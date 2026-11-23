import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type RobotTest = {
  file: string;
  line: number;
  endLine: number;
  name: string;
  nameDynamic: boolean;
  idDynamic: boolean;
  documentation?: { text: string; line: number; dynamic: boolean };
  error?: string;
};

export type RobotMetadataResult = {
  tests: RobotTest[];
  uncheckable: { file: string; line: number; endLine?: number; reason: string }[];
};

type Source = { file: string; startLine: number; text: string };
type Input = { sources: readonly Source[] };

const timeoutMs = 30_000;
const maxBytes = 8 * 1024 * 1024;
const parserScript = fileURLToPath(new URL("./robot-metadata.py", import.meta.url));
const parserError = "Robot Framework could not reliably parse metadata.";

export async function readRobotMetadata(options: {
  root: string;
  sources: readonly { file: string; startLine: number; text: string }[];
  python: string;
  signal?: AbortSignal;
}): Promise<RobotMetadataResult> {
  if (options.sources.length === 0) return { tests: [], uncheckable: [] };
  const input = JSON.stringify({ sources: options.sources } satisfies Input);
  if (Buffer.byteLength(input) > maxBytes) return failedSources(options.sources, "Robot metadata input exceeded the size limit.");
  if (options.signal?.aborted) return failedSources(options.sources, "Robot metadata parsing was aborted.");

  const processResult = await runParser({ ...options, input });
  if (processResult.kind !== "exited") {
    const reason = processResult.kind === "timeout" ? "Robot metadata parsing timed out."
      : processResult.kind === "aborted" ? "Robot metadata parsing was aborted."
        : processResult.kind === "output-limit" ? "Robot metadata output exceeded the size limit."
          : "Robot metadata parser could not be started.";
    return failedSources(options.sources, reason);
  }
  if (processResult.code !== 0) return failedSources(options.sources, parserError);

  try {
    const result: unknown = JSON.parse(processResult.stdout);
    if (!isMetadataResult(result)) return failedSources(options.sources, parserError);
    return result;
  } catch {
    return failedSources(options.sources, parserError);
  }
}

type ProcessResult = { kind: "exited"; code: number | null; stdout: string } | { kind: "timeout" | "aborted" | "output-limit" | "spawn-error" };

async function runParser(options: {
  root: string;
  python: string;
  input: string;
  signal?: AbortSignal;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ kind: "aborted" });
      return;
    }

    let child;
    try {
      child = spawn(options.python, ["-I", parserScript], {
        cwd: options.root,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve({ kind: "spawn-error" });
      return;
    }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stopReason: "timeout" | "aborted" | "output-limit" | undefined;
    let spawnFailed = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const stop = (reason: "timeout" | "aborted" | "output-limit") => {
      if (settled || stopReason) return;
      stopReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const onAbort = () => stop("aborted");
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) {
        stop("output-limit");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () => { spawnFailed = true; });
    child.once("close", (code: number | null) => {
      if (settled) return;
      cleanup();
      if (stopReason) resolve({ kind: stopReason });
      else if (spawnFailed) resolve({ kind: "spawn-error" });
      else resolve({ kind: "exited", code, stdout: Buffer.concat(chunks).toString("utf8") });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) stop("aborted");
    child.stdin.end(options.input);
  });
}

function failedSources(sources: readonly Source[], reason: string): RobotMetadataResult {
  return { tests: [], uncheckable: sources.map(({ file, startLine }) => ({ file, line: startLine, reason })) };
}

function isMetadataResult(value: unknown): value is RobotMetadataResult {
  if (!isRecord(value) || !Array.isArray(value.tests) || !Array.isArray(value.uncheckable)) return false;
  return value.tests.every(isRobotTest) && value.uncheckable.every(isUncheckable);
}

function isRobotTest(value: unknown): value is RobotTest {
  if (!isRecord(value) || typeof value.file !== "string" || !Number.isInteger(value.line) || !Number.isInteger(value.endLine) ||
      typeof value.name !== "string" || typeof value.nameDynamic !== "boolean" || typeof value.idDynamic !== "boolean") return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (value.documentation === undefined) return true;
  return isRecord(value.documentation) && typeof value.documentation.text === "string" &&
    Number.isInteger(value.documentation.line) && typeof value.documentation.dynamic === "boolean";
}

function isUncheckable(value: unknown): value is RobotMetadataResult["uncheckable"][number] {
  return isRecord(value) && typeof value.file === "string" && Number.isInteger(value.line) &&
    (value.endLine === undefined || Number.isInteger(value.endLine)) && typeof value.reason === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
