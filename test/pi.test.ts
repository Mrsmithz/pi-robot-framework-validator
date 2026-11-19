import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { access, chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

const repoRoot = resolve(process.env.PI_ROBOT_VALIDATOR_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const piCli = resolve(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const extension = resolve(repoRoot, "src/index.ts");
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/pi/trusted-project");
const CHAT_HISTORY_SENTINEL = "CHAT_HISTORY_SENTINEL_MUST_NOT_REACH_REVIEWER";
const QA_SENTINEL = "SYNTHETIC_QA_DATA_SENTINEL";
const GUIDELINE_SENTINEL = "SYNTHETIC_GUIDELINE_SENTINEL";

type JsonRecord = Record<string, unknown>;
type Completion =
  | { kind: "tool"; name: string; args: JsonRecord }
  | { kind: "text"; text: string };
type Waiter = {
  predicate: (record: JsonRecord) => boolean;
  resolve: (record: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    return Object.values(value).map(text).join("\n");
  }
  return "";
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function modelId(body: JsonRecord): string {
  return requiredString(body.model, "provider request model");
}

function completionChunks(model: string, completion: Completion): JsonRecord[] {
  const base = {
    id: "chatcmpl-pi-test",
    object: "chat.completion.chunk",
    created: 1,
    model,
  };
  if (completion.kind === "text") {
    return [
      { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: { content: completion.text }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
  }
  return [
    {
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call-pi-e2e",
            type: "function",
            function: { name: completion.name, arguments: JSON.stringify(completion.args) },
          }],
        },
        finish_reason: null,
      }],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

async function requestBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return record(parsed, "OpenAI-compatible request");
}

function sendCompletion(response: ServerResponse, model: string, completion: Completion): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of completionChunks(model, completion)) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

class RpcPi {
  private buffer = "";
  private readonly waiters = new Set<Waiter>();
  private readonly recordsValue: JsonRecord[] = [];
  private listener: ((value: JsonRecord) => void) | undefined;
  private processError: Error | undefined;
  private stderr = "";
  private exitResolver: (() => void) | undefined;
  private readonly exited = new Promise<void>((resolveExit) => { this.exitResolver = resolveExit; });

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    child.once("error", (error) => this.fail(error));
    child.once("close", (code, signal) => {
      if (code !== 0) this.fail(new Error(`Pi exited with code ${String(code)} and signal ${String(signal)}: ${this.stderr}`));
      this.exitResolver?.();
    });
  }

  get records(): readonly JsonRecord[] {
    return this.recordsValue;
  }

  onRecord(listener: (value: JsonRecord) => void): void {
    this.listener = listener;
  }

  send(message: JsonRecord): void {
    if (!this.child.stdin.writable) throw new Error(`Pi RPC stdin is closed: ${this.stderr}`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(predicate: (value: JsonRecord) => boolean, label: string, timeoutMs = 60_000): Promise<JsonRecord> {
    if (this.processError) return Promise.reject(this.processError);
    const existing = this.recordsValue.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<JsonRecord>((resolveWait, rejectWait) => {
      const waiter: Waiter = {
        predicate,
        resolve: resolveWait,
        reject: rejectWait,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          rejectWait(new Error(`Timed out waiting for ${label}. Pi stderr: ${this.stderr}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async command(command: string, fields: JsonRecord = {}): Promise<JsonRecord> {
    const id = `pi-test-${command}-${this.recordsValue.length}`;
    const response = this.waitFor((item) => item.type === "response" && item.id === id, `${command} response`);
    this.send({ id, type: command, ...fields });
    const result = await response;
    assert.equal(result.success, true, `Pi RPC ${command} failed: ${JSON.stringify(result)}`);
    return result;
  }

  async close(): Promise<void> {
    if (this.child.stdin.writable) this.child.stdin.end();
    const killTimer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    await this.exited;
    clearTimeout(killTimer);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.consumeRecord(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private consumeRecord(line: string): void {
    try {
      const parsed: unknown = JSON.parse(line);
      const value = record(parsed, "Pi RPC record");
      this.recordsValue.push(value);
      this.listener?.(value);
      for (const waiter of this.waiters) {
        if (waiter.predicate(value)) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve(value);
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.processError) return;
    this.processError = error;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

function responseDetails(event: JsonRecord): JsonRecord {
  assert.equal(event.isError, false, `robot_review failed: ${JSON.stringify(event.result)}`);
  const result = record(event.result, "robot_review result");
  const content = array(result.content, "robot_review result content");
  const rendered = content.map((item) => text(record(item, "tool content").text)).join("\n");
  return record(JSON.parse(rendered), "robot_review JSON result");
}

test("Pi runs trusted Robot review with local deterministic models", { timeout: 120_000 }, (t) => runPiReview(t, { shareQa: true, trusted: true }));
test("Pi continues lint and readability without sending declined QA data", { timeout: 120_000 }, (t) => runPiReview(t, { shareQa: false, trusted: true }));
test("Pi does not run Robocop when only the validator config is present in an unapproved project", { timeout: 120_000 },
  (t) => runPiReview(t, { shareQa: true, trusted: false }));

async function runPiReview(t: TestContext, { shareQa, trusted }: { shareQa: boolean; trusted: boolean }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-robot-validator-e2e-"));
  const projectRoot = join(temporaryRoot, "trusted-project");
  const agentDir = join(temporaryRoot, "pi-agent");
  const captured: JsonRecord[] = [];
  const providerFailures: string[] = [];
  const uiRequests: JsonRecord[] = [];
  const uiFailures: string[] = [];
  let mainRequests = 0;
  let reviewerRequests = 0;
  let server: Server | undefined;
  let pi: RpcPi | undefined;

  t.after(async () => {
    await pi?.close();
    if (server) await closeServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await cp(fixture, projectRoot, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  if (!trusted) {
    await cp(join(projectRoot, ".pi/robot-validator.toml"), join(agentDir, "robot-validator.toml"));
    await rm(join(projectRoot, ".pi/settings.json"));
    await writeFile(join(projectRoot, ".pi/robot-validator.toml"), '[robocop]\ncommand = "do-not-execute"\n');
  }
  const serverReady = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        throw new Error(`Unexpected local provider request: ${request.method} ${request.url}`);
      }
      const body = await requestBody(request);
      captured.push(body);
      const model = modelId(body);
      let completion: Completion;

      if (model === "pi-agent") {
        mainRequests += 1;
        if (mainRequests === 1) {
          completion = { kind: "tool", name: "robot_review", args: { action: "settings" } };
        } else if (mainRequests === 2) {
          completion = {
            kind: "tool",
            name: "robot_review",
            args: {
              action: "review",
              target: { kind: "project" },
              qa: { path: "cases.csv", recipient: "local-e2e/robot-reviewer" },
            },
          };
        } else if (mainRequests === 3) {
          completion = { kind: "text", text: "Robocop findings, QA notes, and readability notes are reported separately." };
        } else {
          providerFailures.push(`Unexpected extra agent request ${mainRequests}.`);
          completion = { kind: "text", text: "Unexpected extra request." };
        }
      } else if (model === "robot-reviewer") {
        reviewerRequests += 1;
        const requestText = text(body.messages);
        const hasQa = requestText.includes(QA_SENTINEL);
        const hasGuideline = requestText.includes(GUIDELINE_SENTINEL);
        if (hasQa && !hasGuideline) {
          completion = {
            kind: "text",
            text: JSON.stringify({
              qa: {
                status: "reviewed",
                notes: [{ file: "tests/example.robot", line: 2, sheet: "CSV", cell: "B2", field: "name" }],
              },
            }),
          };
        } else if (hasGuideline && !hasQa) {
          completion = {
            kind: "text",
            text: JSON.stringify({
              readability: [{
                file: "tests/example.robot",
                line: 2,
                guideline: "fixture-guideline",
                message: "Synthetic readability note for the fixture test.",
              }],
            }),
          };
        } else {
          providerFailures.push(`Reviewer request ${reviewerRequests} was not section-specific.`);
          completion = { kind: "text", text: "{}" };
        }
      } else {
        providerFailures.push(`Unexpected model requested: ${model}.`);
        completion = { kind: "text", text: "Unexpected model." };
      }

      sendCompletion(response, model, completion);
    })().catch((error: unknown) => {
      providerFailures.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end("fake provider rejected request");
    });
  });
  server = serverReady;
  const listening = once(serverReady, "listening");
  serverReady.listen(0, "127.0.0.1");
  await listening;
  const address = serverReady.address();
  assert.ok(address && typeof address !== "string");
  const providerUrl = `http://127.0.0.1:${address.port}/v1`;

  const models = {
    providers: {
      "local-e2e": {
        name: "Local deterministic E2E provider",
        baseUrl: providerUrl,
        api: "openai-completions",
        apiKey: "e2e-dummy-key",
        authHeader: false,
        models: ["pi-agent", "robot-reviewer"].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          contextWindow: 16_000,
          maxTokens: 2_048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  };
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`);
  await chmod(join(projectRoot, "bin/robocop"), 0o755);

  await access(piCli);
  await access(extension);

  const inheritedPath = process.env.PATH ?? "";
  const env = {
    HOME: temporaryRoot,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PATH: [join(projectRoot, "bin"), dirname(process.execPath), inheritedPath].filter(Boolean).join(delimiter),
    TMPDIR: temporaryRoot,
    NO_COLOR: "1",
  };
  const child = spawn(process.execPath, [
    piCli,
    "--mode", "rpc",
    "--no-session",
    "--offline",
    ...(trusted ? ["--approve"] : []),
    "--no-context-files",
    "--no-extensions",
    "-e", extension,
    "--tools", "robot_review",
    "--model", "local-e2e/pi-agent",
  ], { cwd: projectRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  pi = new RpcPi(child);
  pi.onRecord((item) => {
    if (item.type !== "extension_ui_request") return;
    uiRequests.push(item);
    if (item.method !== "confirm" || typeof item.id !== "string") {
      uiFailures.push(`Unexpected extension UI request: ${JSON.stringify(item)}`);
      return;
    }
    pi?.send({ type: "extension_ui_response", id: item.id, confirmed: item.title !== "Send selected QA data?" || shareQa });
  });

  const availableModels = await pi.command("get_available_models");
  const configured = array(record(availableModels.data, "available models response").models, "configured models");
  assert.ok(configured.some((item) => record(item, "model").provider === "local-e2e" && record(item, "model").id === "pi-agent"));
  assert.ok(configured.some((item) => record(item, "model").provider === "local-e2e" && record(item, "model").id === "robot-reviewer"));

  const settled = pi.waitFor((item) => item.type === "agent_settled", "agent_settled");
  await pi.command("prompt", {
    message: `Review the entire sample project using the selected cases.csv. I authorize sending this synthetic QA data to local-e2e/robot-reviewer and confirm whole-project scope. Keep this chat-only value private: ${CHAT_HISTORY_SENTINEL}`,
  });
  await settled;

  assert.deepEqual(providerFailures, [], "local fake provider must handle every request");
  assert.deepEqual(uiFailures, [], "Pi should request only supported consent confirmations");
  assert.equal(mainRequests, 3, "the outer Pi model should perform settings, review, and final response turns");
  assert.equal(reviewerRequests, shareQa ? 2 : 1, "Only approved review sections should reach the reviewer");
  assert.deepEqual(
    uiRequests.map((item) => item.title).sort(),
    ["Review all Robot tests?", "Send selected QA data?"].sort(),
    "RPC client must explicitly approve QA disclosure and whole-project scope",
  );

  const agentRequests = captured.filter((body) => modelId(body) === "pi-agent");
  const nestedRequests = captured.filter((body) => modelId(body) === "robot-reviewer");
  assert.equal(agentRequests.length, 3);
  assert.ok(!JSON.stringify(agentRequests).includes(QA_SENTINEL), "spreadsheet cells must not be forwarded to the main agent");
  assert.equal(nestedRequests.length, shareQa ? 2 : 1);
  const firstAgent = agentRequests[0];
  assert.ok(firstAgent);
  const offeredTools = array(firstAgent.tools, "outer Pi tools");
  const offeredNames = offeredTools.map((tool) => {
    const entry = record(tool, "tool declaration");
    const declaration = isRecord(entry.function) ? entry.function : entry;
    return requiredString(declaration.name, "tool name");
  });
  assert.deepEqual(offeredNames, ["robot_review"], "the extension tool must be registered and active");
  const firstMessages = array(firstAgent.messages, "first outer messages");
  const systemMessage = record(firstMessages[0], "outer system message");
  assert.equal(systemMessage.role, "system");
  assert.match(text(systemMessage.content), /robot_validator_completion|If the task changes Robot Framework tests/);
  assert.match(text(systemMessage.content), /robot_review/);

  for (const nested of nestedRequests) {
    assert.ok(nested.tools === undefined || (Array.isArray(nested.tools) && nested.tools.length === 0), "nested reviewer must receive no tools");
    const messages = array(nested.messages, "nested reviewer messages");
    assert.equal(messages.length, 2, "nested reviewer gets only its system prompt and one scoped user payload");
    assert.equal(record(messages[0], "nested system message").role, "system");
    assert.equal(record(messages[1], "nested user message").role, "user");
    assert.ok(!JSON.stringify(nested).includes(CHAT_HISTORY_SENTINEL), "chat-only history must stay out of reviewer requests");
  }
  const qaRequest = nestedRequests.find((body) => JSON.stringify(body).includes(QA_SENTINEL));
  const readabilityRequest = nestedRequests.find((body) => JSON.stringify(body).includes(GUIDELINE_SENTINEL));
  if (shareQa) {
    assert.ok(qaRequest, "synthetic QA cells must reach the explicitly selected reviewer");
    assert.ok(!JSON.stringify(qaRequest).includes(GUIDELINE_SENTINEL), "QA-only request must not include readability guidelines");
  } else {
    assert.ok(!JSON.stringify(captured).includes(QA_SENTINEL), "declined QA cells must not reach any model");
  }
  assert.ok(readabilityRequest, "configured readability guideline must reach the reviewer");
  assert.ok(!JSON.stringify(readabilityRequest).includes(QA_SENTINEL), "readability-only request must not include QA data");

  const executions = pi.records.filter((item) => item.type === "tool_execution_end" && item.toolName === "robot_review");
  assert.equal(executions.length, 2, "Pi should expose settings and unified review tool results");
  const settingsResult = responseDetails(executions[0]!);
  assert.equal(settingsResult.trusted, trusted);
  assert.equal(record(settingsResult.reviewer, "reviewer settings").recipient, "local-e2e/robot-reviewer");
  const reviewResult = responseDetails(executions[1]!);
  assert.equal(reviewResult.qaSource, shareQa ? "cases.csv" : undefined);
  assert.deepEqual(Object.keys(reviewResult).filter((key) => ["robocop", "qa", "readability"].includes(key)).sort(), ["qa", "readability", "robocop"]);

  const lint = record(reviewResult.robocop, "Robocop result");
  if (trusted) {
    assert.equal(lint.status, "completed");
    const findings = array(lint.findings, "Robocop findings").map((finding) => record(finding, "Robocop finding"));
    assert.ok(findings.some((finding) => finding.file === "tests/example.robot" && finding.message === "Synthetic Robocop fixture finding."), "Robocop finding must survive the unified review result");
  } else {
    assert.equal(lint.status, "uncheckable");
    assert.match(requiredString(lint.reason, "lint reason"), /requires a trusted project/);
  }

  const qa = record(reviewResult.qa, "QA result");
  if (shareQa) {
    assert.equal(qa.status, "reviewed");
    assert.ok(array(qa.notes, "QA notes").some((note) => record(note, "QA note").sheetIndex === 1), "QA output should retain its selected-sheet citation");
  } else {
    assert.equal(qa.status, "uncheckable");
    assert.match(requiredString(qa.reason, "QA reason"), /not confirmed/);
  }
  const readability = record(reviewResult.readability, "readability result");
  assert.equal(readability.status, "reviewed");
  assert.ok(array(readability.notes, "readability notes").some((note) => record(note, "readability note").message === "Synthetic readability note for the fixture test."));
}
