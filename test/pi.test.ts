import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piCli = resolve(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const extension = resolve(repoRoot, "src/index.ts");
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/pi/changed-project");
const CHAT_HISTORY_SENTINEL = "CHAT_HISTORY_SENTINEL_MUST_NOT_REACH_REVIEWER";
const QA_SENTINEL = "QA_UNRELATED_SENTINEL";
const UNRELATED_TEST_SENTINEL = "UNRELATED_TEST_SENTINEL";
const REFERENCE_SENTINEL = "REFERENCE_SENTINEL";

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

type Scenario = {
  actions: Completion[];
  prompt: string;
  trusted?: boolean;
  reviewerReply?: string;
};

test("Pi reports scoped lint, QA, readability, and references with approved local evidence", { timeout: 120_000 }, async (t) => {
  const scenario: Scenario = {
    actions: [
      { kind: "tool", name: "robot_review", args: { action: "settings" } },
      { kind: "tool", name: "robot_review", args: { action: "authorize-snippets", snippetIds: ["customer-api-pinned"] } },
      { kind: "tool", name: "robot_review", args: { action: "map-qa", mapping: "default", layout: { headerRow: 1, id: "A", name: "B", objective: "C" } } },
      { kind: "tool", name: "robot_review", args: {
        action: "review",
        changes: [{ path: "tests/example.robot", ranges: [{ startLine: 1, endLine: 5 }], category: "api" }],
        qa: { mapping: "default" },
        snippets: [{ id: "customer-api-pinned", workspace: "fixture-workspace", snippet: "fixture-snippet", revision: "0123456789abcdef0123456789abcdef01234567", file: "tests/pinned-reference.robot", startLine: 2, text: "REFERENCE_SENTINEL\n    No Operation\n" }],
      } },
    ],
    prompt: "Review only the changed API test. Use the local QA mapping and the approved pinned reference excerpt. Report the current scope and each result section.",
    reviewerReply: JSON.stringify({
      readability: [{ file: "tests/example.robot", line: 2, message: "Synthetic readability note." }],
      references: { status: "reviewed", notes: [{ type: "suggestion", source: { file: "tests/example.robot", line: 2 },
        evidence: [{ id: "customer-api-pinned", line: 2 }], message: "Synthetic reference note." }] },
    }),
  };
  const result = await runScenario(t, scenario);
  if (!result) return;

  const toolResults = getToolResults(result.pi);
  assert.equal(toolResults.length, 4);
  const review = responseDetails(toolResults.at(-1)!);
  for (const section of ["scope", "robocop", "qa", "readability", "references", "settingsErrors"]) {
    assert.ok(Object.hasOwn(review, section), `review result should include ${section}`);
  }
  const readability = record(review.readability, "readability result");
  assert.equal(readability.status, "reviewed");
  assert.equal(array(readability.notes, "readability notes").length, 1);
  const references = record(review.references, "reference result");
  assert.equal(references.status, "reviewed");
  assert.match(JSON.stringify(references.notes), /customer-api-pinned/);
  const scope = JSON.stringify(review.scope);
  assert.match(scope, /tests\/example\.robot/);
  assert.doesNotMatch(scope, /unrelated\.robot|mismatch\.robot/);
  const qa = record(review.qa, "QA result");
  assert.equal(qa.status, "checked");
  const qaTests = array(qa.tests, "local QA test records").map((entry) => record(entry, "QA test record"));
  assert.ok(qaTests.some((entry) => entry.file === "tests/example.robot"));
  assert.ok(qaTests.every((entry) => !JSON.stringify(entry).includes(QA_SENTINEL)), "unrelated workbook rows must not become QA results");
  assert.doesNotMatch(JSON.stringify(qa), /Unrelated payment edge/);
  const matchedTest = qaTests.find((entry) => entry.file === "tests/example.robot")!;
  assert.equal(record(matchedTest.id, "QA ID field").status, "match");
  assert.equal(record(matchedTest.name, "QA name field").status, "match");
  assert.equal(record(matchedTest.objective, "QA objective field").status, "match");
  const lint = record(review.robocop, "Robocop result");
  const findings = array(lint.findings, "Robocop findings").map((finding) => record(finding, "Robocop finding"));
  assert.ok(findings.some((finding) => finding.file === "tests/example.robot"));
  assert.ok(findings.every((finding) => finding.file !== "tests/unrelated.robot"));
  assert.ok(result.robocopRuns.some((files) => files.includes("tests/example.robot")));
  assert.ok(result.robocopRuns.every((files) => !files.includes("tests/unrelated.robot")));

  const reviewerPayloads = result.captured.filter((body) => modelId(body) === "robot-reviewer").map((body) => JSON.stringify(body));
  assert.ok(reviewerPayloads.some((payload) => payload.includes("LOCAL_REFERENCE_SENTINEL")), "configured local reference should reach the reviewer");
  assert.ok(reviewerPayloads.some((payload) => payload.includes(REFERENCE_SENTINEL)), "the selected pinned excerpt should reach the reviewer");
  assert.ok(reviewerPayloads.every((payload) => !payload.includes("UNAPPROVED_REFERENCE_SENTINEL")), "only the approved excerpt should reach the reviewer");
  assert.ok(reviewerPayloads.every((payload) => !payload.includes(QA_SENTINEL)), "unrelated QA rows must stay local");
  assert.ok(reviewerPayloads.every((payload) => !payload.includes(CHAT_HISTORY_SENTINEL)), "the advisory reviewer must not receive chat history");
  assert.ok(reviewerPayloads.every((payload) => !payload.includes(UNRELATED_TEST_SENTINEL)), "unrelated Robot tests must stay out of review context");
  assert.ok(result.uiRequests.some((request) => text(request.title).includes("pinned Bitbucket")), "native Pi UI should confirm pinned snippet consent");
  assert.equal(responseDetails(toolResults[2]!).status, "saved", "Pi should persist the confirmed QA mapping");
  const persistedMapping = await readFile(join(result.projectRoot, ".pi/robot-validator-qa-mappings.json"), "utf8");
  assert.match(persistedMapping, /default/);
  assert.match(persistedMapping, /headerRow/);
});

test("QA sentinel stays local for matched and unmatched changed tests", { timeout: 180_000 }, async (t) => {
  for (const path of ["tests/example.robot", "tests/mismatch.robot"]) {
    const result = await runScenario(t, {
      actions: [
        { kind: "tool", name: "robot_review", args: { action: "settings" } },
        { kind: "tool", name: "robot_review", args: { action: "map-qa", mapping: "default", layout: { headerRow: 1, id: "A", name: "B", objective: "C" } } },
        { kind: "tool", name: "robot_review", args: {
          action: "review", changes: [{ path, ranges: [{ startLine: 1, endLine: 3 }] }], qa: { mapping: "default" },
        } },
      ],
      prompt: `Review only ${path} and use the configured local QA mapping.`,
      reviewerReply: JSON.stringify({ readability: [], references: { status: "reviewed", notes: [] } }),
    });
    if (!result) return;
    assert.ok(!JSON.stringify(result.captured).includes(QA_SENTINEL), `unrelated QA record leaked for ${path}`);
    const review = responseDetails(getToolResults(result.pi).at(-1)!);
    const qa = record(review.qa, "QA result");
    assert.equal(qa.status, "checked");
    const qaTests = array(qa.tests, "local QA test records");
    const matchedTest = record(qaTests.find((entry) => record(entry, "QA test record").file === path), "matched QA test");
    assert.equal(record(matchedTest.id, "QA ID field").status, "match");
    assert.equal(record(matchedTest.name, "QA name field").status, path.endsWith("mismatch.robot") ? "mismatch" : "match");
    assert.equal(record(matchedTest.objective, "QA objective field").status, path.endsWith("mismatch.robot") ? "mismatch" : "match");
    assert.doesNotMatch(JSON.stringify(qa), /Unrelated payment edge/);
    const reviewerPayloads = result.captured.filter((body) => modelId(body) === "robot-reviewer");
    assert.ok(reviewerPayloads.every((body) => !JSON.stringify(body).includes(QA_SENTINEL)));
  }
});

test("resource-only changes skip workbook QA while empty changes skip all checks", { timeout: 180_000 }, async (t) => {
  for (const changes of [
    [{ path: "resources/shared.resource" }],
    [],
  ]) {
    const result = await runScenario(t, {
      actions: [
        { kind: "tool", name: "robot_review", args: { action: "settings" } },
        { kind: "tool", name: "robot_review", args: { action: "review", changes } },
      ],
      prompt: "Review the supplied changes only.",
    });
    if (!result) return;
    const review = responseDetails(getToolResults(result.pi).at(-1)!);
    const qa = record(review.qa, "QA result");
    assert.equal(qa.status, "not-applicable");
    assert.equal(qa.tests === undefined ? 0 : array(qa.tests, "local QA test records").length, 0, "empty or resource-only changes must not trigger QA comparisons");
    assert.ok(!result.uiRequests.some((request) => request.method === "select"), "no QA workbook selection should be requested");
    if (changes.length === 0) {
      assert.equal(result.uiRequests.length, 0);
      assert.equal(result.captured.filter((body) => modelId(body) === "robot-reviewer").length, 0);
      assert.equal(result.robocopRuns.length, 0);
    } else {
      assert.ok(result.captured.some((body) => modelId(body) === "robot-reviewer"), "resource advisory should run");
      assert.ok(result.robocopRuns.some((files) => files.includes("resources/shared.resource")), "Robocop should check changed resources");
    }
  }
});

test("untrusted projects cannot run lint or send QA and reference content", { timeout: 120_000 }, async (t) => {
  const result = await runScenario(t, {
    trusted: false,
    actions: [
      { kind: "tool", name: "robot_review", args: { action: "settings" } },
      { kind: "tool", name: "robot_review", args: {
        action: "review", changes: [{ path: "tests/example.robot", category: "api" }], qa: { mapping: "default" },
      } },
    ],
    prompt: "Review only tests/example.robot.",
  });
  if (!result) return;
  assert.equal(result.robocopRuns.length, 0);
  assert.equal(result.captured.filter((body) => modelId(body) === "robot-reviewer").length, 0);
  const allProviderRequests = JSON.stringify(result.captured);
  assert.ok(!allProviderRequests.includes(QA_SENTINEL));
  assert.ok(!allProviderRequests.includes(REFERENCE_SENTINEL));
  const review = responseDetails(getToolResults(result.pi).at(-1)!);
  const qa = record(review.qa, "QA result");
  assert.notEqual(qa.status, "checked", "untrusted projects must not run local QA");
  assert.equal(qa.tests === undefined ? 0 : array(qa.tests, "local QA test records").length, 0);
});

async function runScenario(t: TestContext, scenario: Scenario) {
  const python = await findRobotPython();
  if (!python) {
    t.skip("Robot Framework 7.4.2 is unavailable; set ROBOT_PARSER_PYTHON to a Python environment that provides it.");
    return undefined;
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-robot-validator-e2e-"));
  const projectRoot = join(temporaryRoot, "changed-project");
  const agentDir = join(temporaryRoot, "pi-agent");
  const robocopLog = join(temporaryRoot, "robocop-runs.jsonl");
  const captured: JsonRecord[] = [];
  const providerFailures: string[] = [];
  const uiRequests: JsonRecord[] = [];
  let mainRequests = 0;
  let server: Server | undefined;
  let pi: RpcPi | undefined;

  t.after(async () => {
    await pi?.close();
    if (server) await closeServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await cp(fixture, projectRoot, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  if (scenario.trusted === false) {
    await cp(join(projectRoot, ".pi/robot-validator.toml"), join(agentDir, "robot-validator.toml"));
    await rm(join(projectRoot, ".pi/settings.json"));
    await writeFile(join(projectRoot, ".pi/robot-validator.toml"), '[robocop]\ncommand = "do-not-execute"\n');
  }
  const serverReady = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") throw new Error(`Unexpected local provider request: ${request.method} ${request.url}`);
      const body = await requestBody(request);
      captured.push(body);
      const model = modelId(body);
      let completion: Completion;
      if (model === "pi-agent") {
        mainRequests += 1;
        completion = scenario.actions[mainRequests - 1] ?? { kind: "text", text: "Reviewed the current requested scope only." };
      } else if (model === "robot-reviewer") {
        completion = { kind: "text", text: scenario.reviewerReply ?? JSON.stringify({ readability: [], references: { status: "reviewed", notes: [] } }) };
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

  const models = {
    providers: {
      "local-e2e": {
        name: "Local deterministic E2E provider",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        apiKey: "e2e-dummy-key",
        authHeader: false,
        models: ["pi-agent", "robot-reviewer"].map((id) => ({
          id, name: id, reasoning: false, input: ["text"], contextWindow: 16_000, maxTokens: 2_048,
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
    PATH: [join(projectRoot, "bin"), dirname(process.execPath), dirname(python), inheritedPath].filter(Boolean).join(delimiter),
    TMPDIR: temporaryRoot,
    NO_COLOR: "1",
    ROBOT_PARSER_PYTHON: python,
    PI_FIXTURE_ROBOCOP_LOG: robocopLog,
  };
  const trusted = scenario.trusted !== false;
  const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--no-session", "--offline", ...(trusted ? ["--approve"] : ["--no-approve"]),
    "--no-context-files", "--no-extensions", "-e", extension, "--tools", "robot_review", "--model", "local-e2e/pi-agent"],
  { cwd: projectRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  pi = new RpcPi(child);
  const uiFailures: string[] = [];
  pi.onRecord((item) => {
    if (item.type !== "extension_ui_request") return;
    uiRequests.push(item);
    if (item.method !== "confirm" || typeof item.id !== "string") {
      uiFailures.push(`Unexpected extension UI request: ${JSON.stringify(item)}`);
      return;
    }
    pi?.send({ type: "extension_ui_response", id: item.id, confirmed: true });
  });

  const modelsResponse = await pi.command("get_available_models");
  const configured = array(record(modelsResponse.data, "available models response").models, "configured models");
  for (const id of ["pi-agent", "robot-reviewer"]) {
    assert.ok(configured.some((item) => record(item, "model").provider === "local-e2e" && record(item, "model").id === id));
  }
  const settled = pi.waitFor((item) => item.type === "agent_settled", "agent_settled");
  await pi.command("prompt", { message: `${scenario.prompt} Keep this chat-only value private: ${CHAT_HISTORY_SENTINEL}` });
  await settled;

  assert.deepEqual(providerFailures, [], "local fake provider must handle every request");
  assert.deepEqual(uiFailures, [], "Pi should request only supported confirmation dialogs");
  assert.equal(mainRequests, scenario.actions.length + 1, "outer Pi model should complete each tool action and final response");
  const rawLog = await readFile(robocopLog, "utf8").catch(() => "");
  const robocopRuns = rawLog.split("\n").filter(Boolean).map(parseStringArray);
  return { pi, projectRoot, captured, uiRequests, robocopRuns };
}

function parseStringArray(line: string): string[] {
  return array(JSON.parse(line), "Robocop invocation log").map((item) => requiredString(item, "Robocop file argument"));
}

function getToolResults(pi: RpcPi): JsonRecord[] {
  return pi.records.filter((item) => item.type === "tool_execution_end" && item.toolName === "robot_review");
}

async function findRobotPython(): Promise<string | undefined> {
  const candidates = [process.env.ROBOT_PARSER_PYTHON, "python3"].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    let output = "";
    try {
      const child = spawn(candidate, ["-m", "robot", "--version"], { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      await once(child, "close");
      if (output.includes("Robot Framework 7.4.2")) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}
