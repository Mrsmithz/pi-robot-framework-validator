import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Settings } from "../src/settings.ts";
import { loadReferences, type SnippetExcerpt } from "../src/references.ts";

async function environment(t: { after(callback: () => void | Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "robot-validator-references-"));
  await mkdir(join(root, "tests"), { recursive: true });
  await mkdir(join(root, "changed"), { recursive: true });
  await writeFile(join(root, "tests", "api.robot"), "*** Test Cases ***\nApproved API example\n    Log    ok\n");
  await writeFile(join(root, "tests", "other.resource"), "*** Keywords ***\nShared setup\n    Log    setup\n");
  await writeFile(join(root, "changed", "api.robot"), "*** Test Cases ***\nChanged API test\n");
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

const referenceSettings = (local: Settings["references"]["local"] = {}, snippets: Settings["references"]["snippets"] = {}, bitbucket = true): Settings["references"] => ({ bitbucket, local, snippets });
const categories = new Map([
  ["changed/api.robot", "api"],
  ["changed/second.robot", "api"],
  ["changed/ui.robot", "ui"],
]);

test("loads comparable local examples but excludes each file from its own comparison", async (t) => {
  const root = await environment(t);
  const result = await loadReferences({
    root,
    settings: referenceSettings({
      api: { path: "tests/api.robot", category: "api" },
      resource: { path: "tests/other.resource", category: "api" },
      self: { path: "changed/api.robot", category: "api" },
    }),
    categories,
    allowSnippets: false,
  });

  assert.deepEqual(result.sources.map(({ id }) => id), ["api", "resource", "self"]);
  assert.equal(result.sources[0]?.projectPath, "tests/api.robot");
  assert.equal(result.sources[1]?.projectPath, "tests/other.resource");
  assert.deepEqual(result.sources[0]?.appliesTo, ["changed/api.robot", "changed/second.robot"]);
  assert.deepEqual(result.sources[1]?.appliesTo, ["changed/api.robot", "changed/second.robot"]);
  assert.deepEqual(result.sources[2]?.appliesTo, ["changed/second.robot"]);
  assert.equal(result.sources[2]?.projectPath, "changed/api.robot");
  assert.deepEqual(result.unavailable, []);
});

test("accepts only an exact pinned snippet identity and preserves excerpt line", async (t) => {
  const root = await environment(t);
  const revision = "0123456789abcdef0123456789abcdef01234567";
  const settings = referenceSettings({}, {
    approved: { workspace: "team", snippet: "shared", revision, file: "api.robot", category: "api", projectPath: "tests/api.robot" },
    wrong: { workspace: "team", snippet: "shared", revision, file: "api.robot", category: "api" },
  });
  const excerpts: SnippetExcerpt[] = [
    { id: "approved", workspace: "team", snippet: "shared", revision, file: "api.robot", startLine: 17, text: "Approved pinned excerpt\n" },
    { id: "wrong", workspace: "team", snippet: "shared", revision: "ffffffffffffffffffffffffffffffffffffffff", file: "api.robot", startLine: 2, text: "Must not be passed\n" },
  ];
  const result = await loadReferences({ root, settings, categories, snippets: excerpts, allowSnippets: true });

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.id, "approved");
  assert.equal(result.sources[0]?.startLine, 17);
  assert.deepEqual(result.sources[0]?.pinned, { workspace: "team", snippet: "shared", revision, file: "api.robot" });
  assert.deepEqual(result.unavailable, [{ id: "wrong", reason: "Returned excerpt does not match the approved pinned identity." }]);
});

test("does not use snippets when disabled or lacking main-agent consent", async (t) => {
  const root = await environment(t);
  const revision = "0123456789abcdef0123456789abcdef01234567";
  const entry = { workspace: "team", snippet: "shared", revision, file: "api.robot", category: "api" };
  const excerpt: SnippetExcerpt = { id: "one", ...entry, startLine: 1, text: "private snippet content" };
  const config = referenceSettings({}, { one: entry });

  const disabled = await loadReferences({ root, settings: referenceSettings({}, { one: entry }, false), categories, snippets: [excerpt], allowSnippets: true });
  const unapproved = await loadReferences({ root, settings: config, categories, snippets: [excerpt], allowSnippets: false });

  assert.deepEqual(disabled.sources, []);
  assert.deepEqual(unapproved.sources, []);
  assert.match(disabled.unavailable[0]?.reason ?? "", /disabled/);
  assert.match(unapproved.unavailable[0]?.reason ?? "", /not approved/);
});

test("rejects references outside the project, including escaping symlinks", async (t) => {
  const root = await environment(t);
  const outside = await mkdtemp(join(tmpdir(), "robot-validator-outside-"));
  await writeFile(join(outside, "escape.robot"), "must not be read");
  await symlink(join(outside, "escape.robot"), join(root, "tests", "escape.robot"));
  t.after(() => rm(outside, { force: true, recursive: true }));

  const result = await loadReferences({
    root,
    settings: referenceSettings({ outside: { path: "../outside/escape.robot", category: "api" }, symlink: { path: "tests/escape.robot", category: "api" } }),
    categories,
    allowSnippets: false,
  });

  assert.deepEqual(result.sources, []);
  assert.equal(result.unavailable.length, 2);
  assert.ok(result.unavailable.every(({ reason }) => /outside the project/.test(reason)));
});

test("reports absent comparable references without falling back to another category", async (t) => {
  const root = await environment(t);
  const result = await loadReferences({
    root,
    settings: referenceSettings({ ui: { path: "tests/api.robot", category: "unrelated" } }),
    categories,
    allowSnippets: false,
  });
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.unavailable, [{ id: "ui", reason: "No changed file has this reference category." }]);
});
