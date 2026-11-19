import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { runRobocop } from "../src/robocop.ts";

const inventory = [
  "LEN08 [W]: line-too-long: Line is too long ({line_length}/{allowed_length}) (enabled)",
  "SPC01 [W]: trailing-whitespace: Trailing whitespace at the end of line (disabled*) [fixable]",
  "DOC02 [W]: missing-doc-test-case: Missing documentation (disabled)",
].join("\n");

type StubMode = "clean" | "finding" | "malformed" | "missing-report" | "findings-zero" | "empty-one" | "hang" | "no-inventory" | "no-docs" | "typo-select" | "intentional-disabled-all" | "check-error";

async function fixture(t: TestContext, mode: StubMode, source = "tests/check.robot") {
  const directory = await mkdtemp(join(tmpdir(), "robot-validator-robocop-test-"));
  const root = join(directory, "project");
  const callsPath = join(directory, "calls.jsonl");
  const startedPath = join(directory, "started");
  const command = join(directory, "robocop-stub.mjs");
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "robocop.toml"), '[tool.robocop.lint]\nselect = ["line-too-long"]\nignore = ["trailing-whitespace"]\nconfigure = ["line-too-long.line_length=40"]\n');
  await writeFile(join(root, source), "*** Test Cases ***\nCheck\n    No Operation\n");
  await writeFile(command, stubSource(mode, callsPath, source, startedPath));
  await chmod(command, 0o755);
  t.after(() => rm(directory, { recursive: true, force: true }));

  return { root, callsPath, startedPath, command, source, config: "robocop.toml" };
}

function stubSource(mode: StubMode, callsPath: string, source: string, startedPath: string): string {
  const allDisabledInventory = inventory.replace("(enabled)", "(disabled)");
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const callsPath = ${JSON.stringify(callsPath)};
const source = ${JSON.stringify(source)};
const startedPath = ${JSON.stringify(startedPath)};
const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
let configText = "";
if (configIndex >= 0) {
  try { configText = readFileSync(args[configIndex + 1], "utf8"); } catch {}
}
appendFileSync(callsPath, JSON.stringify({ cwd: process.cwd(), args, configText }) + "\\n");
if (args[0] === "list" && args[1] === "rules") {
  if (mode === "no-inventory") { process.stderr.write("unsupported list command"); process.exit(2); }
  const listedRules = mode === "intentional-disabled-all" ? ${JSON.stringify(allDisabledInventory)} : ${JSON.stringify(inventory)};
  if (mode === "typo-select") process.stderr.write("Option value 'line-too-lng' from '--select' did not match any rule name or id.\\n");
  if (mode === "intentional-disabled-all") process.stderr.write("Option value 'line-too-long' from '--select' did not match any rule name or id.\\n");
  process.stdout.write(listedRules + "\\n");
  process.exit(0);
}
if (args[0] === "docs") {
  if (mode === "no-docs") { process.stderr.write("unsupported docs command"); process.exit(2); }
  process.stdout.write("Rule: line-too-long (LEN08)\\n\\nConfigurables:\\n    line_length = 120\\n        type: int\\n    ignore_docs = False\\n        type: str2bool\\n");
  process.exit(0);
}
if (args[0] !== "check") { process.stderr.write("unsupported command"); process.exit(2); }
if (mode === "hang") {
  writeFileSync(startedPath, "ready");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === "check-error") { process.stderr.write("configuration could not be loaded"); process.exit(2); }
if (mode === "typo-select" || mode === "intentional-disabled-all") {
  const name = mode === "typo-select" ? "line-too-lng" : "line-too-long";
  process.stderr.write("Option value '" + name + "' from '--select' did not match any rule name or id.\\n");
  process.stdout.write("No rule selected with the existing configuration. Please check if all rules from --select exist.\\n");
}
const settings = [];
for (let index = 0; index < args.length - 1; index += 1) {
  if (args[index] === "--configure") settings.push(args[index + 1]);
}
const reportSetting = settings.find((setting) => setting.startsWith("json_report.output_path="));
if (!reportSetting) { process.stderr.write("missing JSON output path"); process.exit(2); }
const reportPath = reportSetting.slice("json_report.output_path=".length);
if (mode === "missing-report") process.exit(0);
if (mode === "malformed") { writeFileSync(reportPath, "{"); process.exit(0); }
const finding = { source, line: 2, rule_id: "LEN08", description: "Line is too long" };
const hasFinding = mode === "finding" || mode === "findings-zero";
writeFileSync(reportPath, JSON.stringify(hasFinding ? [finding] : []));
process.exit(mode === "empty-one" ? 1 : mode === "findings-zero" ? 0 : hasFinding ? 1 : 0);
`;
}

type Invocation = { cwd: string; args: string[]; configText: string };
async function calls(path: string): Promise<Invocation[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Invocation);
  } catch {
    return [];
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise<void>((resolveNext) => setImmediate(resolveNext));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function optionValues(args: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === option) values.push(args[index + 1]!);
  }
  return values;
}

function configureValues(args: string[]): string[] {
  return optionValues(args, "--configure");
}

test("uses only the confirmed check/report CLI for no-overlay runs and preserves the baseline", async (t) => {
  const env = await fixture(t, "finding", "tests/case with spaces.robot");
  const baselinePath = join(env.root, env.config);
  const baseline = await readFile(baselinePath, "utf8");

  const result = await runRobocop({ root: env.root, files: [env.source], command: env.command, config: env.config, rules: {} });

  assert.deepEqual(result, {
    status: "completed",
    findings: [{ file: env.source, line: 2, ruleId: "LEN08", message: "Line is too long" }],
  });
  assert.equal(await readFile(baselinePath, "utf8"), baseline);
  const invocations = await calls(env.callsPath);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.cwd, env.root);
  const args = invocations[0]!.args;
  assert.deepEqual(args, ["check", "--config", baselinePath, "--reports", "json_report", "--configure", args[6], resolve(env.root, env.source)]);
  const reportSetting = args[6]!;
  assert.match(reportSetting, /^json_report\.output_path=/);
  const reportPath = reportSetting.slice("json_report.output_path=".length);
  assert.equal(resolve(reportPath), reportPath);
  assert.ok(reportPath.startsWith(tmpdir()));
  await assert.rejects(stat(reportPath));
});

test("materializes field overlays in a sibling config and uses repeated selection flags", async (t) => {
  const env = await fixture(t, "clean");
  const baselinePath = join(env.root, env.config);
  const baseline = await readFile(baselinePath, "utf8");

  const result = await runRobocop({
    root: env.root,
    files: [env.source],
    command: env.command,
    config: env.config,
    rules: {
      "line-too-long": { line_length: 55, ignore_docs: true },
      "trailing-whitespace": { enabled: true },
      "missing-doc-test-case": { enabled: false },
    },
  });

  assert.deepEqual(result, { status: "completed", findings: [] });
  assert.equal(await readFile(baselinePath, "utf8"), baseline);
  const invocations = await calls(env.callsPath);
  assert.deepEqual(invocations.map(({ args }) => args[0]), ["list", "docs", "check"]);
  const { args, configText } = invocations[2]!;
  assert.notEqual(args[2], baselinePath);
  assert.match(configText, /extends = \["robocop\.toml"\]/);
  assert.match(configText, /line-too-long\.line_length=55/);
  assert.match(configText, /line-too-long\.ignore_docs=true/);
  assert.match(configText, /json_report\.output_path=/);
  assert.match(configText, /json_report\.skip_on_empty=false/);
  assert.deepEqual(optionValues(args, "--select"), ["line-too-long", "trailing-whitespace"]);
  assert.deepEqual(optionValues(args, "--ignore"), ["missing-doc-test-case"]);
  assert.equal(configureValues(args).length, 1);
  await assert.rejects(stat(args[2]!));
});

test("requires an existing regular baseline config before invoking Robocop", async (t) => {
  const env = await fixture(t, "clean");
  await rm(join(env.root, env.config));
  const missing = await runRobocop({ root: env.root, files: [env.source], command: env.command, config: env.config, rules: {} });
  assert.equal(missing.status, "uncheckable");
  assert.match(missing.reason, /baseline config is unavailable/);
  assert.deepEqual(await calls(env.callsPath), []);

  await mkdir(join(env.root, env.config));
  const directory = await runRobocop({ root: env.root, files: [env.source], command: env.command, config: env.config, rules: {} });
  assert.equal(directory.status, "uncheckable");
  assert.match(directory.reason, /not a regular file/);
  assert.deepEqual(await calls(env.callsPath), []);
});

test("uses a report-only sibling overlay when the baseline can redirect or suppress JSON", async (t) => {
  const env = await fixture(t, "clean");
  await writeFile(join(env.root, env.config), '[tool.robocop.lint]\nconfigure = ["json_report.output_path=outside.json"]\n');
  const redirected = await runRobocop({ root: env.root, files: [env.source], command: env.command, config: env.config, rules: {} });
  assert.deepEqual(redirected, { status: "completed", findings: [] });
  const firstCall = (await calls(env.callsPath))[0]!;
  assert.equal(firstCall.args[0], "check");
  assert.notEqual(firstCall.args[2], join(env.root, env.config));
  assert.match(firstCall.configText, /extends = \["robocop\.toml"\]/);
  assert.match(firstCall.configText, /json_report\.skip_on_empty=false/);
  assert.match(firstCall.configText, /json_report\.output_path=/);
  await assert.rejects(stat(firstCall.args[2]!));

  await writeFile(join(env.root, "parent.toml"), '[tool.robocop.lint]\nconfigure = ["json_report.skip_on_empty=true"]\n');
  await writeFile(join(env.root, env.config), '[tool.robocop]\nextends = ["parent.toml"]\n[tool.robocop.lint]\n');
  const inherited = await runRobocop({ root: env.root, files: [env.source], command: env.command, config: env.config, rules: {} });
  assert.deepEqual(inherited, { status: "completed", findings: [] });
  const invocations = await calls(env.callsPath);
  assert.equal(invocations.length, 2);
  assert.match(invocations[1]!.configText, /extends = \["robocop\.toml"\]/);
  await assert.rejects(stat(invocations[1]!.args[2]!));
});

test("rejects findings for files outside the selected target set", async (t) => {
  const env = await fixture(t, "finding");
  const result = await runRobocop({ root: env.root, files: ["tests/other.robot"], command: env.command, config: env.config, rules: {} });
  assert.equal(result.status, "uncheckable");
  assert.match(result.reason, /unselected file/);
});

test("unknown rule and unsupported rule option are uncheckable", async (t) => {
  const unknownRuleEnv = await fixture(t, "clean");
  const unknownRule = await runRobocop({ root: unknownRuleEnv.root, files: [unknownRuleEnv.source], command: unknownRuleEnv.command, config: unknownRuleEnv.config, rules: { "not-a-rule": { enabled: true } } });
  assert.equal(unknownRule.status, "uncheckable");
  assert.match(unknownRule.reason, /Unknown Robocop rule/);
  assert.deepEqual((await calls(unknownRuleEnv.callsPath)).map(({ args }) => args[0]), ["list"]);

  const unknownOptionEnv = await fixture(t, "clean");
  const unknownOption = await runRobocop({ root: unknownOptionEnv.root, files: [unknownOptionEnv.source], command: unknownOptionEnv.command, config: unknownOptionEnv.config, rules: { "line-too-long": { invented_option: 1 } } });
  assert.equal(unknownOption.status, "uncheckable");
  assert.match(unknownOption.reason, /Unsupported Robocop option/);
  assert.deepEqual((await calls(unknownOptionEnv.callsPath)).map(({ args }) => args[0]), ["list", "docs"]);
});

test("advanced overlays fail closed when list or docs commands are unavailable", async (t) => {
  const noInventoryEnv = await fixture(t, "no-inventory");
  const noInventory = await runRobocop({ root: noInventoryEnv.root, files: [noInventoryEnv.source], command: noInventoryEnv.command, config: noInventoryEnv.config, rules: { "line-too-long": { enabled: true } } });
  assert.equal(noInventory.status, "uncheckable");
  assert.match(noInventory.reason, /rule inventory failed/);

  const noDocsEnv = await fixture(t, "no-docs");
  const noDocs = await runRobocop({ root: noDocsEnv.root, files: [noDocsEnv.source], command: noDocsEnv.command, config: noDocsEnv.config, rules: { "line-too-long": { line_length: 55 } } });
  assert.equal(noDocs.status, "uncheckable");
  assert.match(noDocs.reason, /documentation.*failed/);
});

test("rejects typoed rule selection but accepts an intentional all-disabled config", async (t) => {
  const typo = await fixture(t, "typo-select");
  const typoResult = await runRobocop({ root: typo.root, files: [typo.source], command: typo.command, config: typo.config, rules: {} });
  assert.equal(typoResult.status, "uncheckable");
  assert.match(typoResult.reason, /unknown --select rule pattern: line-too-lng/);
  assert.deepEqual((await calls(typo.callsPath)).map(({ args }) => args[0]), ["check", "list"]);

  const disabled = await fixture(t, "intentional-disabled-all");
  const disabledResult = await runRobocop({ root: disabled.root, files: [disabled.source], command: disabled.command, config: disabled.config, rules: {} });
  assert.deepEqual(disabledResult, { status: "completed", findings: [] });
});

test("missing or incompatible JSON and exit/report mismatches are never clean", async (t) => {
  for (const mode of ["missing-report", "malformed", "findings-zero", "empty-one", "check-error"] as const) {
    const env = await fixture(t, mode);
    const result = await runRobocop({ root: env.root, files: [env.source], command: env.command, config: env.config, rules: {} });
    assert.equal(result.status, "uncheckable", mode);
  }
});

test("abort terminates the active Robocop child", async (t) => {
  const env = await fixture(t, "hang");
  const controller = new AbortController();
  const pending = runRobocop({ root: env.root, files: [env.source], command: env.command, config: env.config, rules: {}, signal: controller.signal });
  await waitForFile(env.startedPath);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "uncheckable");
  assert.match(result.reason, /aborted/i);
});

test("bounds subprocess duration", async (t) => {
  const env = await fixture(t, "hang");
  const originalSetTimeout = globalThis.setTimeout;
  const shortSetTimeout = Object.assign(
    <TArgs extends unknown[]>(callback: (...args: TArgs) => void, delay?: number, ...args: TArgs) =>
      originalSetTimeout(callback, delay !== undefined && delay >= 59_000 ? 100 : delay, ...args),
    originalSetTimeout,
  );
  Reflect.set(globalThis, "setTimeout", shortSetTimeout);
  try {
    const pending = runRobocop({ root: env.root, files: [env.source], command: env.command, config: env.config, rules: {} });
    await waitForFile(env.startedPath);
    const result = await pending;
    assert.equal(result.status, "uncheckable");
    assert.match(result.reason, /timed out/i);
  } finally {
    Reflect.set(globalThis, "setTimeout", originalSetTimeout);
  }
});

test("stock Robocop 9.4 reports findings, tuning overrides, rule toggles, and clean runs when enabled", { skip: !process.env.ROBOCOP_9_4_PATH }, async (t) => {
  const env = await fixture(t, "clean");
  const command = process.env.ROBOCOP_9_4_PATH!;
  await mkdir(join(env.root, "rules"));
  await writeFile(join(env.root, "rules", "relative_rules.py"), "\n");
  const baselinePath = join(env.root, env.config);
  const parentPath = join(env.root, "parent.toml");
  const parent = '[tool.robocop.lint]\nconfigure = ["json_report.output_path=baseline-report.json", "json_report.skip_on_empty=true"]\n';
  const baseline = '[tool.robocop]\nextends = ["parent.toml"]\n[tool.robocop.lint]\nselect = ["line-too-long"]\nignore = ["trailing-whitespace"]\nconfigure = ["line-too-long.line_length=40"]\ncustom_rules = ["rules/relative_rules.py"]\n';
  await writeFile(parentPath, parent);
  await writeFile(baselinePath, baseline);
  await writeFile(join(env.root, env.source), "*** Test Cases ***\nExample\n    Log    This very long message is a disposable test for a length finding.    \n");

  const findings = await runRobocop({ root: env.root, files: [env.source], command, config: env.config, rules: {} });
  assert.equal(findings.status, "completed");
  assert.ok(findings.findings.some((finding) => finding.ruleId === "LEN08"));

  const tuned = await runRobocop({ root: env.root, files: [env.source], command, config: env.config, rules: { "line-too-long": { line_length: 140 } } });
  assert.deepEqual(tuned, { status: "completed", findings: [] });

  const toggled = await runRobocop({ root: env.root, files: [env.source], command, config: env.config, rules: { "line-too-long": { enabled: false }, "trailing-whitespace": { enabled: true } } });
  assert.equal(toggled.status, "completed");
  assert.ok(toggled.findings.some((finding) => finding.ruleId === "SPC01"));
  assert.ok(!toggled.findings.some((finding) => finding.ruleId === "LEN08"));

  await writeFile(join(env.root, env.source), "*** Test Cases ***\nShort test\n    No Operation\n");
  const clean = await runRobocop({ root: env.root, files: [env.source], command, config: env.config, rules: {} });
  assert.deepEqual(clean, { status: "completed", findings: [] });
  assert.equal(await readFile(baselinePath, "utf8"), baseline);
  assert.equal(await readFile(parentPath, "utf8"), parent);
  await assert.rejects(stat(join(env.root, "baseline-report.json")), { code: "ENOENT" });

  const error = await runRobocop({ root: env.root, files: [env.source], command, config: "missing.toml", rules: {} });
  assert.equal(error.status, "uncheckable");
});
