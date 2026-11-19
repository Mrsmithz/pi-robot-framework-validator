import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

type Finding = { file: string; line: number; ruleId: string; message: string };
export type LintResult =
  | { status: "completed"; findings: Finding[] }
  | { status: "uncheckable"; reason: string };

type Rule = { id: string; name: string; enabled: boolean };
type ProcessResult =
  | { kind: "exited"; code: number | null; signal: string | null; stdout: string; stderr: string }
  | { kind: "timeout" | "aborted" | "output-limit" }
  | { kind: "spawn-error"; message: string };
type RuleSettings = Record<string, unknown>;
type RuleOptionWarning = { option: string; pattern: string };
type CliDiagnostics = { warnings: RuleOptionWarning[]; noRulesSelected: boolean; unexpected: string[] };

const timeoutMs = 60_000;
const maxProcessOutputBytes = 2 * 1024 * 1024;
const maxReportBytes = 10 * 1024 * 1024;

export async function runRobocop(options: {
  root: string;
  files: readonly string[];
  command: string;
  config: string;
  rules: Record<string, Record<string, unknown>>;
  signal?: AbortSignal;
}): Promise<LintResult> {
  const root = resolve(options.root);
  if (options.files.length === 0) return uncheckable("No Robot files were selected.");
  if (options.signal?.aborted) return uncheckable("Robocop run was aborted.");
  if (!isRecord(options.rules)) return uncheckable("Robocop rule settings were invalid.");

  const config = resolve(root, options.config);
  const files = options.files.map((file) => resolve(root, file));
  const overrides: Array<[string, RuleSettings]> = [];
  for (const [key, settings] of Object.entries(options.rules)) {
    if (!isRecord(settings)) return uncheckable(`Invalid settings for Robocop rule ${key}.`);
    if (Object.keys(settings).length > 0) overrides.push([key, settings]);
  }

  try {
    if (!(await stat(config)).isFile()) return uncheckable("Robocop baseline config is not a regular file.");
  } catch (error) {
    return uncheckable(`Robocop baseline config is unavailable: ${errorMessage(error)}`);
  }

  let reportOverlayRequired = false;
  if (overrides.length === 0) {
    const reportConfig = await inspectReportConfig(config);
    if (reportConfig.reason) return uncheckable(reportConfig.reason);
    reportOverlayRequired = reportConfig.overlayRequired;
  }

  const deadline = Date.now() + timeoutMs;
  let tempDir: string;
  try {
    tempDir = await mkdtemp(resolve(tmpdir(), "robot-validator-robocop-"));
  } catch (error) {
    return uncheckable(`Could not create a temporary Robocop report directory: ${errorMessage(error)}`);
  }

  let overlayConfig: string | undefined;
  try {
    const report = resolve(tempDir, "report.json");
    let inventory: Rule[] | undefined;
    const configurations: string[] = [];
    const enabledOverrides: Array<[string, boolean]> = [];
    let enabledRuleNames: Set<string> | undefined;

    if (overrides.length > 0) {
      if (!config.toLowerCase().endsWith(".toml")) return uncheckable("Robocop overlays require a TOML baseline config.");

      const inventoryResult = await runProcess(options.command, ["list", "rules", "--config", config], root, options.signal, deadline);
      if (inventoryResult.kind !== "exited") return processFailure(inventoryResult, "Robocop rule inventory");
      if (inventoryResult.code !== 0) return commandFailure("Robocop rule inventory", inventoryResult);
      inventory = parseRuleInventory(inventoryResult.stdout);
      if (inventory.length === 0) return uncheckable("Robocop returned an unsupported rule inventory.");
      const inventoryIssue = diagnosticFailure(parseCliDiagnostics(inventoryResult.stdout, inventoryResult.stderr), inventory);
      if (inventoryIssue) return uncheckable(inventoryIssue);

      const byName = new Map(inventory.map((rule) => [rule.name, rule]));
      const byId = new Map(inventory.map((rule) => [rule.id, rule]));
      const enabledRules = new Set(inventory.filter((rule) => rule.enabled).map((rule) => rule.name));
      enabledRuleNames = enabledRules;

      for (const [ruleKey, settings] of overrides) {
        const rule = byName.get(ruleKey) ?? byId.get(ruleKey);
        if (!rule) return uncheckable(`Unknown Robocop rule: ${ruleKey}`);

        if (Object.hasOwn(settings, "enabled")) {
          if (typeof settings.enabled !== "boolean") {
            return uncheckable(`Invalid enabled setting for Robocop rule ${ruleKey}; expected a boolean.`);
          }
          if (settings.enabled) enabledRules.add(rule.name);
          else enabledRules.delete(rule.name);
          enabledOverrides.push([rule.name, settings.enabled]);
        }

        const tuning = Object.entries(settings).filter(([key]) => key !== "enabled");
        if (tuning.length === 0) continue;

        const docsResult = await runProcess(options.command, ["docs", rule.name, "--config", config], root, options.signal, deadline);
        if (docsResult.kind !== "exited") return processFailure(docsResult, `Robocop documentation for ${rule.name}`);
        if (docsResult.code !== 0) return commandFailure(`Robocop documentation for ${rule.name}`, docsResult);
        if (docsResult.stderr.trim() || hasDiagnosticText(docsResult.stdout)) {
          return uncheckable(`Robocop emitted diagnostics while documenting ${rule.name}.`);
        }
        const parameters = parseRuleParameters(docsResult.stdout);
        if (!parameters) return uncheckable(`Robocop returned unsupported parameter documentation for ${rule.name}.`);

        for (const [field, value] of tuning) {
          if (!parameters.has(field)) return uncheckable(`Unsupported Robocop option ${rule.name}.${field}.`);
          const encoded = encodeConfigurationValue(value);
          if (encoded === undefined) return uncheckable(`Unsupported value for Robocop option ${rule.name}.${field}.`);
          configurations.push(`${rule.name}.${field}=${encoded}`);
        }
      }
    }

    const args = ["check", "--config", config, "--reports", "json_report", "--configure", `json_report.output_path=${report}`];
    let expectedEnabledCount: number | undefined;

    if (overrides.length > 0 || reportOverlayRequired) {
      const configure = [...configurations, `json_report.output_path=${report}`, "json_report.skip_on_empty=false"];
      const generatedConfig = join(dirname(config), `.robocop-adapter-${randomUUID()}.toml`);
      overlayConfig = generatedConfig;
      await writeFile(generatedConfig, makeOverlayConfig(basename(config), configure), { flag: "wx" });
      args[2] = generatedConfig;

      if (enabledOverrides.length > 0 && inventory && enabledRuleNames) {
        const allNames = inventory.map((rule) => rule.name);
        const selectedNames = allNames.filter((name) => enabledRuleNames.has(name));
        const ignoredNames = allNames.filter((name) => !enabledRuleNames.has(name));
        expectedEnabledCount = selectedNames.length;
        const selectNames = selectedNames.length > 0 ? selectedNames : allNames;
        const ignoreNames = selectedNames.length > 0 ? ignoredNames : allNames;
        for (const name of selectNames) args.push("--select", name);
        for (const name of ignoreNames) args.push("--ignore", name);
      }
    }

    args.push(...files);
    const lintResult = await runProcess(options.command, args, root, options.signal, deadline);
    if (lintResult.kind !== "exited") return processFailure(lintResult, "Robocop lint");
    if (lintResult.code !== 0 && lintResult.code !== 1) return commandFailure("Robocop lint", lintResult);

    const diagnostics = parseCliDiagnostics(lintResult.stdout, lintResult.stderr);
    if (hasCliDiagnostics(diagnostics)) {
      if (!inventory) {
        const inventoryResult = await runProcess(options.command, ["list", "rules", "--config", config], root, options.signal, deadline);
        if (inventoryResult.kind !== "exited") return processFailure(inventoryResult, "Robocop rule inventory");
        if (inventoryResult.code !== 0) return commandFailure("Robocop rule inventory", inventoryResult);
        inventory = parseRuleInventory(inventoryResult.stdout);
        if (inventory.length === 0) return uncheckable("Robocop returned an unsupported rule inventory while validating diagnostics.");
        const inventoryDiagnostics = parseCliDiagnostics(inventoryResult.stdout, inventoryResult.stderr);
        const inventoryIssue = diagnosticFailure(inventoryDiagnostics, inventory);
        if (inventoryIssue) return uncheckable(inventoryIssue);
      }
      const diagnosticIssue = diagnosticFailure(diagnostics, inventory, expectedEnabledCount);
      if (diagnosticIssue) return uncheckable(diagnosticIssue);
    }

    const knownRuleIds = inventory && new Set(inventory.map((rule) => rule.id));
    const parsed = await readFindings(report, root, new Set(files), knownRuleIds);
    if (parsed.kind === "invalid") return uncheckable(parsed.reason);
    if ((lintResult.code === 0 && parsed.findings.length > 0) || (lintResult.code === 1 && parsed.findings.length === 0)) {
      return uncheckable("Robocop's exit code disagreed with its JSON report.");
    }
    return { status: "completed", findings: parsed.findings };
  } catch (error) {
    return uncheckable(`Robocop could not complete: ${errorMessage(error)}`);
  } finally {
    if (overlayConfig) await unlink(overlayConfig).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runProcess(command: string, args: string[], cwd: string, signal: AbortSignal | undefined, deadline: number): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve({ kind: "timeout" });

  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolveResult({ kind: "spawn-error", message: errorMessage(error) });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let spawnError: string | undefined;
    let stopReason: "timeout" | "aborted" | "output-limit" | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let finished = false;

    const stop = (reason: "timeout" | "aborted" | "output-limit") => {
      if (finished || stopReason) return;
      stopReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const onAbort = () => stop("aborted");
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxProcessOutputBytes) {
        stop("output-limit");
        return;
      }
      target.push(chunk);
    };
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: ProcessResult) => {
      if (finished) return;
      cleanup();
      resolveResult(result);
    };

    const timer = setTimeout(() => stop("timeout"), remaining);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) stop("aborted");

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error: Error) => { spawnError = error.message; });
    child.once("close", (code: number | null, childSignal: NodeJS.Signals | null) => {
      let result: ProcessResult;
      if (stopReason) result = { kind: stopReason };
      else if (spawnError) result = { kind: "spawn-error", message: spawnError };
      else result = { kind: "exited", code, signal: childSignal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      finish(result);
    });
  });
}

function parseRuleInventory(output: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+\[[^\]]+\]:\s+([^:]+):.*\((enabled|disabled)[^)]*\)/);
    if (match) rules.push({ id: match[1]!, name: match[2]!.trim(), enabled: match[3] === "enabled" });
  }
  return rules;
}

function parseRuleParameters(output: string): Set<string> | undefined {
  const start = output.indexOf("Configurables:");
  if (start < 0) return undefined;
  const section = output.slice(start);
  const parameters = new Set([...section.matchAll(/^\s{4}([A-Za-z_][A-Za-z\d_]*)\s*=/gm)].map((match) => match[1]!));
  return parameters.size > 0 ? parameters : undefined;
}

function parseCliDiagnostics(stdout: string, stderr: string): CliDiagnostics {
  const warnings: RuleOptionWarning[] = [];
  const unexpected: string[] = [];
  let noRulesSelected = false;

  for (const [output, isStderr] of [[stderr, true], [stdout, false]] as const) {
    for (const line of output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const optionWarning = line.match(/Option value ['"](.+?)['"] from ['"]--(select|ignore)['"] did not match(?: with)? any rule name or id\./i);
      if (optionWarning) {
        warnings.push({ pattern: optionWarning[1]!, option: optionWarning[2]! });
      } else if (/No rule selected with the existing configuration/i.test(line)) {
        noRulesSelected = true;
      } else if (isStderr || /^(?:warning|error|fatal|failed to|unknown |invalid |configuration .*?(?:error|warning|invalid|failed))/i.test(line)) {
        unexpected.push(line);
      }
    }
  }
  return { warnings, noRulesSelected, unexpected };
}

function hasCliDiagnostics(diagnostics: CliDiagnostics): boolean {
  return diagnostics.warnings.length > 0 || diagnostics.noRulesSelected || diagnostics.unexpected.length > 0;
}

function diagnosticFailure(diagnostics: CliDiagnostics, inventory: Rule[], expectedEnabledCount?: number): string | undefined {
  if (diagnostics.unexpected.length > 0) {
    return `Robocop emitted an unrecognized diagnostic: ${diagnostics.unexpected[0]}`;
  }
  for (const warning of diagnostics.warnings) {
    if (!inventory.some((rule) => rulePatternMatches(warning.pattern, rule))) {
      return `Robocop config contains an unknown --${warning.option} rule pattern: ${warning.pattern}`;
    }
  }
  if (diagnostics.noRulesSelected) {
    const enabledCount = expectedEnabledCount ?? inventory.filter((rule) => rule.enabled).length;
    if (enabledCount > 0) return "Robocop selected no rules despite enabled rules in the effective config.";
  }
  return undefined;
}

function rulePatternMatches(pattern: string, rule: Rule): boolean {
  if (pattern === "ALL" || pattern === "PROJECT") return true;
  if (!pattern.includes("*")) return pattern === rule.id || pattern === rule.name;
  const matcher = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return matcher.test(rule.id) || matcher.test(rule.name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function inspectReportConfig(config: string): Promise<{ overlayRequired: boolean; reason?: string }> {
  let contents: string;
  try {
    contents = await readFile(config, "utf8");
  } catch (error) {
    return { overlayRequired: false, reason: `Robocop baseline config cannot be inspected safely: ${errorMessage(error)}` };
  }
  return {
    overlayRequired: /\bextends\s*=/i.test(contents) || /json_report\.(?:output_path|skip_on_empty)/i.test(contents),
  };
}

function makeOverlayConfig(configName: string, configure: string[]): string {
  const quotedConfig = JSON.stringify(configName);
  const quotedConfigure = configure.map((value) => JSON.stringify(value)).join(", ");
  return `[tool.robocop]\nextends = [${quotedConfig}]\n\n[tool.robocop.lint]\nconfigure = [${quotedConfigure}]\n`;
}

function encodeConfigurationValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (Array.isArray(value)) {
    if (value.some((entry) => !["string", "number", "boolean"].includes(typeof entry) || (typeof entry === "number" && !Number.isFinite(entry)))) return undefined;
    const entries = value.map(String);
    if (entries.some((entry) => entry.includes(","))) return undefined;
    return entries.join(",");
  }
  return undefined;
}

async function readFindings(report: string, root: string, selectedFiles: Set<string>, knownRuleIds: Set<string> | undefined): Promise<{ kind: "valid"; findings: Finding[] } | { kind: "invalid"; reason: string }> {
  try {
    const info = await stat(report);
    if (!info.isFile() || info.size > maxReportBytes) return { kind: "invalid", reason: "Robocop produced an unsupported JSON report." };
    const parsed: unknown = JSON.parse(await readFile(report, "utf8"));
    if (!Array.isArray(parsed)) return { kind: "invalid", reason: "Robocop's JSON report was not an array." };

    const findings: Finding[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry) || typeof entry.source !== "string" || typeof entry.line !== "number" || !Number.isSafeInteger(entry.line) || entry.line < 1 || typeof entry.rule_id !== "string" || !entry.rule_id || typeof entry.description !== "string" || !entry.description || (knownRuleIds && !knownRuleIds.has(entry.rule_id))) {
        return { kind: "invalid", reason: "Robocop's JSON report contained an incompatible finding." };
      }
      const absoluteFile = resolve(root, entry.source);
      if (!selectedFiles.has(absoluteFile)) return { kind: "invalid", reason: "Robocop reported a finding for an unselected file." };
      const relativeFile = relative(root, absoluteFile);
      if (relativeFile === ".." || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)) {
        return { kind: "invalid", reason: "Robocop reported a finding outside the project root." };
      }
      findings.push({ file: relativeFile, line: entry.line, ruleId: entry.rule_id, message: entry.description });
    }
    return { kind: "valid", findings };
  } catch (error) {
    return { kind: "invalid", reason: `Robocop did not produce a readable JSON report: ${errorMessage(error)}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandFailure(step: string, result: Extract<ProcessResult, { kind: "exited" }>): LintResult {
  const detail = (result.stderr || result.stdout).trim().slice(0, 500);
  return uncheckable(`${step} failed with exit code ${result.code}${detail ? `: ${detail}` : "."}`);
}

function processFailure(result: Exclude<ProcessResult, { kind: "exited" }>, step: string): LintResult {
  switch (result.kind) {
    case "timeout": return uncheckable(`${step} timed out.`);
    case "aborted": return uncheckable(`${step} was aborted.`);
    case "output-limit": return uncheckable(`${step} produced too much output.`);
    case "spawn-error": return uncheckable(`${step} could not start: ${result.message}`);
  }
}

function hasDiagnosticText(output: string): boolean {
  return /^(?:warning|error|fatal|failed to|unknown |invalid |configuration .*?(?:error|warning|invalid|failed))/im.test(output);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uncheckable(reason: string): LintResult {
  return { status: "uncheckable", reason };
}
