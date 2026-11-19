import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readReviewSources, resolveTargets } from "../src/targets.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "robot-targets-"));
  const root = join(dir, "project");
  await mkdir(join(root, "tests"), { recursive: true });
  for (const ignored of [".git", "dist", "node_modules"]) {
    await mkdir(join(root, ignored));
    await writeFile(join(root, ignored, "ignored.robot"), "");
  }
  const file = join(root, "tests/customer.robot");
  await writeFile(file, [
    "*** Settings ***", "Resource    data.resource", "", "*** Test Cases ***",
    "ID01 Customer profile", "    Given A customer exists", "    When Request profile",
    "    Then Verify customer profile", "", "*** Keywords ***", "Verify customer profile", "    No Operation", "",
  ].join("\n"));
  const outside = join(dir, "private.robot");
  await writeFile(outside, "*** Test Cases ***\nPRIVATE\n");
  await symlink(outside, join(root, "tests/outside.robot"));
  return { root, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("explicit targets stay inside the project; the project scan ignores symlinks and generated directories", async (t) => {
  const { root, file, cleanup } = await fixture();
  t.after(cleanup);
  assert.deepEqual(await resolveTargets(root, { kind: "files", paths: ["tests/customer.robot", file] }), [file]);
  assert.deepEqual(await resolveTargets(root, { kind: "project" }), [file]);
  for (const path of ["../private.robot", "tests/outside.robot"]) {
    await assert.rejects(resolveTargets(root, { kind: "files", paths: [path] }), /outside the project/);
  }
});

test("model context starts with test cases and includes only explicitly selected keyword lines", async (t) => {
  const { root, file, cleanup } = await fixture();
  t.after(cleanup);
  const withoutKeywords = await readReviewSources({ root, files: [file], context: [] });
  assert.deepEqual(withoutKeywords.keywords, []);
  assert.equal(withoutKeywords.tests[0]?.startLine, 4);
  assert.match(withoutKeywords.tests[0]?.text ?? "", /ID01 Customer profile/);
  assert.doesNotMatch(withoutKeywords.tests[0]?.text ?? "", /Resource|No Operation/);
  const withKeywords = await readReviewSources({ root, files: [file], context: [
    { path: "tests/customer.robot", startLine: 11, endLine: 12 },
  ] });
  assert.deepEqual(withKeywords.keywords, [{ file: "tests/customer.robot", startLine: 11, text: "Verify customer profile\n    No Operation\n" }]);
  await assert.rejects(readReviewSources({ root, files: [file], context: [
    { path: "tests/customer.robot", startLine: 1, endLine: 2 },
  ] }), /Select one referenced keyword definition/);
});

test("pipe-formatted task sections end at the next section and unreviewed files are reported", async (t) => {
  const { root, file, cleanup } = await fixture();
  t.after(cleanup);
  await writeFile(file, [
    "*** Settings ***", "Resource    data.resource", "| *** Tasks *** |",
    "| ID01 Customer profile |", "| | Then Verify customer profile |", "| *** Variables *** |", "| ${VALUE} | private |", "",
  ].join("\n"));
  const other = join(root, "tests/vars.robot");
  await writeFile(other, "*** Variables ***\n${VALUE}    private\n");
  const { tests, unreviewedFiles } = await readReviewSources({ root, files: [file, other], context: [] });
  assert.deepEqual(unreviewedFiles, ["tests/vars.robot"]);
  assert.deepEqual(tests, [{ file: "tests/customer.robot", startLine: 3,
    text: "| *** Tasks *** |\n| ID01 Customer profile |\n| | Then Verify customer profile |\n" }]);
});
