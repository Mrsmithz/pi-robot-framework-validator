import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadSettings } from "../src/settings.ts";

async function environment(t: { after(callback: () => void | Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "robot-validator-settings-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  const projectSettingsPath = join(projectRoot, ".pi", "robot-validator.toml");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(projectRoot, ".pi"), { recursive: true });
  t.after(() => rm(root, { force: true, recursive: true }));

  return {
    agentDir,
    projectRoot,
    globalSettingsPath: join(agentDir, "robot-validator.toml"),
    projectSettingsPath,
  };
}

test("returns defaults and their sources when no settings files exist", async (t) => {
  const env = await environment(t);
  const result = await loadSettings({ ...env, trusted: true });

  assert.deepEqual(result.errors, []);
  assert.equal(result.settings.robocop.command, "robocop");
  assert.equal(result.settings.robocop.config, resolve(env.projectRoot, "robocop.toml"));
  assert.equal(result.settings.readability.enabled, true);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.settings.readability.guidelines).map(([id, guideline]) => [
        id,
        guideline.enabled,
      ]),
    ),
    {
      "business-readable": true,
      "given-when-then": true,
      "named-verification": true,
    },
  );
  assert.equal(result.settings.sources["robocop.command"], "default");
  assert.equal(result.settings.sources["robocop.config"], "default");
  assert.equal(result.settings.sources["readability.enabled"], "default");
  assert.equal(
    result.settings.sources["readability.guidelines.business-readable.text"],
    "default",
  );
});

test("merges global and trusted project settings field by field", async (t) => {
  const env = await environment(t);
  await writeFile(
    env.globalSettingsPath,
    `
[robocop]
command = "custom-robocop"

[rules."robocop:line-too-long"]
enabled = true
line_length = 100
labels = ["global", 2, false]

[readability.guidelines.named-verification]
text = "Global verification wording."

[readability.guidelines.business-terms]
text = "Use the business team's field names."
`,
  );
  await writeFile(
    env.projectSettingsPath,
    `
[robocop]
command = "/opt/tools/robocop"
config = "config/robocop.toml"

[rules."robocop:line-too-long"]
line_length = 120

[readability]
model = "openrouter/meta-llama/llama-3.3-70b-instruct"

[readability.guidelines.named-verification]
text = "Project verification wording."

[readability.guidelines.given-when-then]
enabled = false
`,
  );

  const result = await loadSettings({ ...env, trusted: true });
  const rule = result.settings.robocop.rules["line-too-long"];
  const projectPath = resolve(env.projectRoot, ".pi", "robot-validator.toml");

  assert.deepEqual(result.errors, []);
  assert.equal(result.settings.robocop.command, "/opt/tools/robocop");
  assert.equal(result.settings.robocop.config, resolve(env.projectRoot, "config/robocop.toml"));
  assert.deepEqual(rule, { enabled: true, line_length: 120, labels: ["global", 2, false] });
  assert.equal(result.settings.sources["robocop.command"], projectPath);
  assert.equal(result.settings.sources["robocop.config"], projectPath);
  assert.equal(result.settings.sources["robocop.rules.line-too-long.enabled"], env.globalSettingsPath);
  assert.equal(result.settings.sources["robocop.rules.line-too-long.line_length"], projectPath);
  assert.deepEqual(result.settings.readability.guidelines["named-verification"], {
    text: "Project verification wording.",
    enabled: true,
  });
  assert.equal(
    result.settings.sources["readability.guidelines.named-verification.text"],
    projectPath,
  );
  assert.equal(
    result.settings.sources["readability.guidelines.named-verification.enabled"],
    "default",
  );
  assert.deepEqual(result.settings.readability.guidelines["given-when-then"], {
    text: "Use Given, When, and Then. Allow And for additional steps where it helps. Review this guideline where Robocop does not check the convention.",
    enabled: false,
  });
  assert.equal(
    result.settings.sources["readability.guidelines.given-when-then.enabled"],
    projectPath,
  );
  assert.equal(
    result.settings.readability.model,
    "openrouter/meta-llama/llama-3.3-70b-instruct",
  );
  assert.equal(result.settings.sources["readability.model"], projectPath);
  const businessTerms = result.settings.readability.guidelines["business-terms"];
  assert.ok(businessTerms);
  assert.equal(businessTerms.enabled, true);
  assert.equal(result.settings.sources["readability.guidelines.business-terms.text"], env.globalSettingsPath);
  assert.equal(result.settings.sources["readability.guidelines.business-terms.enabled"], "default");
});

test("ignores project settings entirely when the project is untrusted", async (t) => {
  const env = await environment(t);
  await writeFile(env.globalSettingsPath, '[robocop]\ncommand = "global-robocop"\n');
  await writeFile(env.projectSettingsPath, "[broken\n");

  const result = await loadSettings({ ...env, trusted: false });

  assert.deepEqual(result.errors, []);
  assert.equal(result.settings.robocop.command, "global-robocop");
});

test("reports invalid leaves while retaining valid values and other sections", async (t) => {
  const env = await environment(t);
  await writeFile(
    env.globalSettingsPath,
    `[robocop]
command = "global-robocop"

[rules."robocop:line-too-long"]
enabled = true
`,
  );
  await writeFile(
    env.projectSettingsPath,
    `
[robocop]
command = "robocop --version"
config = "custom.toml"
unknown = true

[rules."robocop:line-too-long"]
enabled = "not-a-boolean"
line_length = 120
bad_option = { nested = true }
bad-option = "invalid spelling"

[readability]
enabled = false
model = "missing-provider-separator"
unknown = true

[readability.guidelines.named-verification]
enabled = false
unknown = true

[qa]
spreadsheet = "tests.xlsx"
`,
  );

  const result = await loadSettings({ ...env, trusted: true });
  const projectPath = resolve(env.projectRoot, ".pi", "robot-validator.toml");

  assert.equal(result.settings.robocop.command, "global-robocop");
  assert.equal(result.settings.robocop.config, resolve(env.projectRoot, "custom.toml"));
  assert.deepEqual(result.settings.robocop.rules["line-too-long"], {
    enabled: true,
    line_length: 120,
  });
  assert.equal(result.settings.readability.enabled, false);
  assert.equal(result.settings.readability.model, undefined);
  const namedVerification = result.settings.readability.guidelines["named-verification"];
  assert.ok(namedVerification);
  assert.equal(namedVerification.enabled, false);
  assert.equal(result.settings.sources["robocop.rules.line-too-long.line_length"], projectPath);
  assert.deepEqual(
    result.errors.map(({ section, key }) => [section, key]),
    [
      ["robocop", "robocop.command"],
      ["robocop", "robocop.unknown"],
      ["robocop", "rules.robocop:line-too-long.enabled"],
      ["robocop", "rules.robocop:line-too-long.bad_option"],
      ["robocop", "rules.robocop:line-too-long.bad-option"],
      ["readability", "readability.model"],
      ["readability", "readability.unknown"],
      ["readability", "readability.guidelines.named-verification.unknown"],
      ["all", "qa"],
    ],
  );
  assert.ok(result.errors.every((issue) => issue.path === projectPath));
});

test("only trusted project settings may select a Robocop config path", async (t) => {
  const env = await environment(t);
  await writeFile(
    env.globalSettingsPath,
    '[robocop]\ncommand = "global-robocop"\nconfig = "global.toml"\n',
  );
  await writeFile(env.projectSettingsPath, '[robocop]\nconfig = "project.toml"\n');

  const result = await loadSettings({ ...env, trusted: true });

  assert.equal(result.settings.robocop.command, "global-robocop");
  assert.equal(result.settings.robocop.config, resolve(env.projectRoot, "project.toml"));
  assert.deepEqual(
    result.errors.map(({ section, key }) => [section, key]),
    [["robocop", "robocop.config"]],
  );
  assert.equal(result.errors[0]?.path, env.globalSettingsPath);
});

test("keeps lower-priority settings when a project file is malformed", async (t) => {
  const env = await environment(t);
  await writeFile(env.globalSettingsPath, '[robocop]\ncommand = "global-robocop"\n');
  await writeFile(env.projectSettingsPath, "[robocop\ncommand = 'broken'\n");

  const result = await loadSettings({ ...env, trusted: true });

  assert.equal(result.settings.robocop.command, "global-robocop");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.section, "all");
  assert.equal(result.errors[0]?.path, resolve(env.projectRoot, ".pi", "robot-validator.toml"));
  assert.match(result.errors[0]?.message ?? "", /^Invalid TOML:/);
});

test("accepts syntactically valid rule IDs and options for adapter validation", async (t) => {
  const env = await environment(t);
  await writeFile(
    env.globalSettingsPath,
    '[rules."robocop:future-rule"]\nfuture_option = ["text", 3, true]\nnon_finite = nan\n',
  );

  const result = await loadSettings({ ...env, trusted: false });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.settings.robocop.rules["future-rule"], {
    future_option: ["text", 3, true],
    non_finite: Number.NaN,
  });
  assert.equal(
    result.settings.sources["robocop.rules.future-rule.future_option"],
    env.globalSettingsPath,
  );
});

test("rejects TOML dates where a settings table is required", async (t) => {
  const env = await environment(t);
  await writeFile(env.globalSettingsPath, "readability = 1979-05-27\n");

  const result = await loadSettings({ ...env, trusted: false });

  assert.equal(result.settings.readability.enabled, true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.section, "readability");
  assert.equal(result.errors[0]?.key, "readability");
});

test("rejects path strings that cannot name a Robocop config", async (t) => {
  const env = await environment(t);
  await writeFile(
    env.projectSettingsPath,
    `[robocop]
config = "\\u0000"
`,
  );

  const result = await loadSettings({ ...env, trusted: true });

  assert.equal(result.settings.robocop.config, resolve(env.projectRoot, "robocop.toml"));
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.section, "robocop");
  assert.equal(result.errors[0]?.key, "robocop.config");
});
