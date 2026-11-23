import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { confirmMapping, runQA, suggestMapping } from "../src/qa.ts";
import type { QAUI, RobotTest } from "../src/qa.ts";

const cases = "ID,Test name,Objective\nQA-01,Create a user,User can sign in\nQA-02,Delete a user,User is removed\n";
const robotTests: RobotTest[] = [
  { file: "tests/users.robot", line: 4, endLine: 6, name: "QA-01 Create a user", nameDynamic: false, documentation: { text: "User can sign in", line: 5, dynamic: false } },
  { file: "tests/users.robot", line: 8, endLine: 10, name: "QA-02 Remove a user", nameDynamic: false, documentation: { text: "User is removed", line: 9, dynamic: false } },
  { file: "tests/users.robot", line: 12, endLine: 14, name: "QA-03 Add a user", nameDynamic: false, documentation: { text: "Creates a user", line: 13, dynamic: false } },
];

async function writeWorkbook(path: string, sheetNames: string[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  for (const sheetName of sheetNames) {
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow(["ID", "Test name", "Objective"]);
    sheet.addRow(["QA-01", "Create a user", "User can sign in"]);
  }
  await workbook.xlsx.writeFile(path);
}

async function project(): Promise<{ root: string; folder: string }> {
  const root = await mkdtemp(join(tmpdir(), "robot-validator-qa-"));
  const folder = join(root, "qa");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(folder));
  await writeFile(join(folder, "cases.csv"), cases);
  return { root, folder };
}

function ui(options: { choose?: string; approve?: boolean; onConfirm?: (body: string) => void } = {}): QAUI {
  return {
    async select(_title, choices) { return options.choose ?? choices[0]; },
    async confirm(_title, body) { options.onConfirm?.(body); return options.approve ?? true; },
  };
}

const input = { headerRow: 1, id: "A", name: "B", objective: "C" };

test("confirmed mappings persist per project and compare fields without exposing QA wording", async () => {
  const { root } = await project();
  try {
    const confirmationBodies: string[] = [];
    strictEqual((await confirmMapping({ root, folder: "qa", name: "default", input, ui: ui({ onConfirm: (body) => confirmationBodies.push(body) }) })).status, "saved");
    ok(confirmationBodies[0]?.includes('B: "Test name"'));
    ok(confirmationBodies[0]?.includes("Header row: 1"));
    const raw = await readFile(join(root, ".pi", "robot-validator-qa-mappings.json"), "utf8");
    ok(raw.includes('"column": "B"'));
    ok(raw.includes('"text": "Test name"'));

    const result = await runQA({ root, folder: "qa", tests: robotTests });
    deepStrictEqual(result, {
      status: "checked",
      tests: [
        { file: "tests/users.robot", line: 4, endLine: 6, id: { status: "match", cell: "CSV!A2" }, name: { status: "match", cell: "CSV!B2", robotLine: 4 }, objective: { status: "match", cell: "CSV!C2", robotLine: 5 } },
        { file: "tests/users.robot", line: 8, endLine: 10, id: { status: "match", cell: "CSV!A3" }, name: { status: "mismatch", reason: "The Robot test name differs from the QA name.", cell: "CSV!B3", robotLine: 8 }, objective: { status: "match", cell: "CSV!C3", robotLine: 9 } },
        { file: "tests/users.robot", line: 12, endLine: 14, id: { status: "mismatch", reason: "No QA record has this ID." }, name: { status: "uncheckable", reason: "No unique QA record is available for field comparison." }, objective: { status: "uncheckable", reason: "No unique QA record is available for field comparison." } },
      ],
    });
    ok(!JSON.stringify(result).includes("User can sign in"));
    ok(!JSON.stringify(result).includes("Create a user"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mapped-header drift is uncheckable while unrelated header edits are tolerated", async () => {
  const { root, folder } = await project();
  try {
    await writeFile(join(folder, "cases.csv"), "ID,Test name,Objective,Extra\nQA-01,Create a user,User can sign in,old\n");
    await confirmMapping({ root, folder: "qa", name: "default", input, ui: ui() });
    const first = robotTests[0];
    ok(first);
    await writeFile(join(folder, "cases.csv"), "ID,Test name,Objective,Changed\nQA-01,Create a user,User can sign in,new\n");
    strictEqual((await runQA({ root, folder: "qa", tests: [first] })).status, "checked");

    await writeFile(join(folder, "cases.csv"), "ID,Renamed,Objective,Changed\nQA-01,Create a user,User can sign in,new\n");
    const drift = await runQA({ root, folder: "qa", tests: [first] });
    strictEqual(drift.status, "uncheckable");
    if (drift.status === "uncheckable") strictEqual(drift.tests[0]?.name.cell, "CSV!B1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate IDs do not guess a QA row", async () => {
  const { root, folder } = await project();
  try {
    await confirmMapping({ root, folder: "qa", name: "default", input, ui: ui() });
    await writeFile(join(folder, "cases.csv"), "ID,Test name,Objective\nQA-01,One,One\nQA-01,Two,Two\n");
    const first = robotTests[0];
    ok(first);
    const result = await runQA({ root, folder: "qa", tests: [first] });
    strictEqual(result.status, "checked");
    if (result.status === "checked") {
      strictEqual(result.tests[0]?.id.status, "uncheckable");
      strictEqual(result.tests[0]?.name.status, "uncheckable");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple eligible files require an explicit picker choice", async () => {
  const { root, folder } = await project();
  try {
    await writeFile(join(folder, "other.csv"), cases);
    const selections: string[][] = [];
    const picker: QAUI = {
      async select(_title, choices) { selections.push(choices); return "other.csv"; },
      async confirm() { return true; },
    };
    const first = robotTests[0];
    ok(first);
    const result = await runQA({ root, folder: "qa", headerless: { id: "A", name: "B", objective: "C" }, tests: [first], ui: picker });
    strictEqual(result.status, "checked");
    deepStrictEqual(selections, [["cases.csv", "other.csv"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("suggestion receives only copied headers and reuses that snapshot for save", async () => {
  const { root, folder } = await project();
  try {
    let confirmation = "";
    const result = await suggestMapping({
      root, folder: "qa", name: "suggested", headerRow: 1,
      suggest: async (headers, headerRow) => {
        deepStrictEqual(headers, [
          { column: "A", text: "ID" },
          { column: "B", text: "Test name" },
          { column: "C", text: "Objective" },
        ]);
        strictEqual(headerRow, 1);
        const nameHeader = headers[1];
        ok(nameHeader);
        nameHeader.text = "Changed by callback";
        await writeFile(join(folder, "cases.csv"), "Changed,Headers,Now\n");
        return { id: "A", name: "B", objective: "C" };
      },
      ui: ui({ onConfirm: (body) => { confirmation = body; } }),
    });
    strictEqual(result.status, "saved");
    ok(confirmation.includes('B: "Test name"'));
    ok(!confirmation.includes("QA-01"));
    const persisted = await readFile(join(root, ".pi", "robot-validator-qa-mappings.json"), "utf8");
    ok(persisted.includes('"text": "Test name"'));
    ok(!persisted.includes("Changed by callback"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("literal ID remains checkable when only the test-name suffix is dynamic", async () => {
  const { root } = await project();
  try {
    await confirmMapping({ root, folder: "qa", name: "default", input, ui: ui() });
    const testCase: RobotTest = {
      file: "tests/users.robot", line: 4, endLine: 6, name: "QA-01 ${suffix}", nameDynamic: true, idDynamic: false,
      documentation: { text: "User can sign in", line: 5, dynamic: false },
    };
    const result = await runQA({ root, folder: "qa", tests: [testCase] });
    strictEqual(result.status, "checked");
    if (result.status === "checked") {
      strictEqual(result.tests[0]?.id.status, "match");
      strictEqual(result.tests[0]?.name.status, "uncheckable");
      deepStrictEqual(result.tests[0]?.objective, { status: "match", cell: "CSV!C2", robotLine: 5 });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saved XLSX mappings pin their sheet and source format; headerless XLSX requires a sheet", async () => {
  const { root, folder } = await project();
  try {
    await rm(join(folder, "cases.csv"));
    const path = join(folder, "cases.xlsx");
    await writeWorkbook(path, ["Cases", "Other"]);
    const workbookInput = { sheet: "Cases", headerRow: 1, id: "A", name: "B", objective: "C" };
    strictEqual((await confirmMapping({ root, folder: "qa", name: "default", input: workbookInput, ui: ui() })).status, "saved");
    const first = robotTests[0];
    ok(first);
    strictEqual((await runQA({ root, folder: "qa", tests: [first] })).status, "checked");

    await writeWorkbook(path, ["Other"]);
    const missingSheet = await runQA({ root, folder: "qa", tests: [first], ui: ui({ onConfirm: () => undefined }) });
    strictEqual(missingSheet.status, "uncheckable");
    if (missingSheet.status === "uncheckable") strictEqual(missingSheet.tests[0]?.id.cell, "Cases!A1");

    const noSheet = await runQA({ root, folder: "qa", headerless: { id: "A", name: "B", objective: "C" }, tests: [first] });
    strictEqual(noSheet.status, "uncheckable");
    const explicitSheet = await runQA({ root, folder: "qa", headerless: { sheet: "Other", id: "A", name: "B", objective: "C" }, tests: [first] });
    strictEqual(explicitSheet.status, "checked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a saved CSV layout cannot be reused for an XLSX source", async () => {
  const { root, folder } = await project();
  try {
    await confirmMapping({ root, folder: "qa", name: "default", input, ui: ui() });
    await rm(join(folder, "cases.csv"));
    await writeWorkbook(join(folder, "cases.xlsx"), ["CSV"]);
    const first = robotTests[0];
    ok(first);
    const result = await runQA({ root, folder: "qa", tests: [first] });
    strictEqual(result.status, "uncheckable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("headerless mappings never persist and empty test sets do not prompt", async () => {
  const { root } = await project();
  try {
    let prompts = 0;
    const noTests = await runQA({ root, folder: "qa", tests: [], ui: ui({ onConfirm: () => { prompts += 1; } }) });
    strictEqual(noTests.status, "not-applicable");
    strictEqual(prompts, 0);
    const first = robotTests[0];
    ok(first);
    const oneRun = await runQA({ root, folder: "qa", headerless: { id: "A", name: "B", objective: "C" }, tests: [first] });
    strictEqual(oneRun.status, "checked");
    strictEqual(await readFile(join(root, ".pi", "robot-validator-qa-mappings.json"), "utf8").then(() => true, () => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
