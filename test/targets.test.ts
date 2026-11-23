import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedSinceRead, changeSources, readKeywordContext, readSnapshots, resolveChanges } from "../src/targets.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "robot-targets-"));
  const root = join(dir, "project");
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "tests/customer.robot"), [
    "*** Settings ***", "Resource    data.resource", "", "*** Test Cases ***",
    "ID01 Customer profile", "    Given A customer exists", "    Then Verify customer profile",
    "", "ID02 Unchanged test", "    No Operation", "",
  ].join("\n"));
  const resource = "*** Keywords ***\nVerify customer profile\n    No Operation\n";
  await writeFile(join(root, "tests/data.resource"), resource);
  await writeFile(join(root, "tests/unrelated.resource"), resource);
  await writeFile(join(dir, "private.robot"), "*** Test Cases ***\nPRIVATE\n");
  await symlink(join(dir, "private.robot"), join(root, "tests/outside.robot"));
  return { root, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("task scope accepts suites and resources, rejects unsafe or unavailable files, and never adds nearby files", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  const { files, unavailable } = await resolveChanges(root, [
    { path: "tests/data.resource" }, { path: "tests/customer.robot" }, { path: "tests/outside.robot" },
    { path: "../private.robot" }, { path: "tests/missing.resource" },
  ]);
  assert.deepEqual(files.map(({ file }) => file), ["tests/customer.robot", "tests/data.resource"]);
  assert.deepEqual(unavailable, [
    { file: "tests/outside.robot", reason: "File is outside the project." },
    { file: "../private.robot", reason: "File is outside the project." },
    { file: "tests/missing.resource", reason: "Robot file is unavailable." },
  ]);
});

test("review separates changed lines from their test context without forwarding unrelated tests", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  const { files } = await resolveChanges(root, [{ path: "tests/customer.robot", ranges: [{ startLine: 7, endLine: 7 }] }]);
  const { snapshots } = await readSnapshots(root, files);
  const { changes, context: surrounding } = changeSources(snapshots, [
    { file: "tests/customer.robot", line: 5, endLine: 7 },
    { file: "tests/customer.robot", line: 9, endLine: 10 },
  ]);
  assert.deepEqual(changes, [{ file: "tests/customer.robot", startLine: 7, text: "    Then Verify customer profile\n" }]);
  assert.deepEqual(surrounding, [{ file: "tests/customer.robot", startLine: 5,
    text: "ID01 Customer profile\n    Given A customer exists\n    Then Verify customer profile\n" }]);
  const context = await readKeywordContext({ root, snapshots, changes, context: [
    { path: "tests/unrelated.resource", startLine: 2, endLine: 3 }, { path: "tests/data.resource", startLine: 2, endLine: 3 },
  ] });
  assert.deepEqual(context.sources, [{ file: "tests/data.resource", startLine: 2, text: "Verify customer profile\n    No Operation\n" }]);
  assert.deepEqual(context.unavailable.map(({ file }) => file), ["tests/unrelated.resource"]);
});

test("a resource change includes the affected keyword but not other definitions", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  await writeFile(join(root, "tests/data.resource"), [
    "| *** Keywords *** |", "| Verify customer profile |", "| | No Operation |",
    "| Other definition |", "| | Log | Unchanged |", "",
  ].join("\n"));
  const { files } = await resolveChanges(root, [{ path: "tests/data.resource", ranges: [{ startLine: 3, endLine: 3 }] }]);
  const { snapshots } = await readSnapshots(root, files);
  assert.deepEqual(changeSources(snapshots, []), {
    changes: [{ file: "tests/data.resource", startLine: 3, text: "| | No Operation |\n" }],
    context: [{ file: "tests/data.resource", startLine: 2, text: "| Verify customer profile |\n| | No Operation |\n" }],
  });
});

test("only direct calls admit keyword definitions, including CURDIR imports", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  await writeFile(join(root, "tests/customer.robot"), [
    "*** Settings ***", "Resource    ${CURDIR}/data.resource", "*** Test Cases ***", "ID01 Profile",
    "    Then Verify customer profile", "    Log    Unchanged definition", "",
  ].join("\n"));
  await writeFile(join(root, "tests/data.resource"), [
    "*** Keywords ***", "Verify customer profile", "    No Operation", "Unchanged definition", "    No Operation", "",
  ].join("\n"));
  const { files } = await resolveChanges(root, [{ path: "tests/customer.robot" }]);
  const { snapshots } = await readSnapshots(root, files);
  const { sources, unavailable } = await readKeywordContext({ root, snapshots, changes: changeSources(snapshots, []).changes,
    context: [{ path: "tests/data.resource", startLine: 2, endLine: 3 }, { path: "tests/data.resource", startLine: 4, endLine: 5 }] });
  assert.deepEqual(sources.map(({ startLine }) => startLine), [2]);
  assert.match(unavailable[0]?.reason ?? "", /referenced keyword/);
});

test("review detects invalid line coordinates and invalidates a snapshot if the file changes", async (t) => {
  const { root, cleanup } = await fixture();
  t.after(cleanup);
  const { files } = await resolveChanges(root, [
    { path: "tests/customer.robot" }, { path: "tests/data.resource", ranges: [{ startLine: 3, endLine: 4 }] },
  ]);
  const { snapshots, unavailable } = await readSnapshots(root, files);
  assert.match(unavailable[0]?.reason ?? "", /does not fit the current file/);
  assert.deepEqual(await changedSinceRead(root, snapshots), []);
  await writeFile(join(root, "tests/customer.robot"), "*** Test Cases ***\nDifferent\n");
  assert.deepEqual(await changedSinceRead(root, snapshots), ["tests/customer.robot"]);
});
