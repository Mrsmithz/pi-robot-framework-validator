import { deepStrictEqual, rejects } from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSpreadsheet } from "../src/spreadsheet.ts";

const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs") as typeof import("exceljs");

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "robot-validator-spreadsheet-"));
}

async function createWorkbook(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const cases = workbook.addWorksheet("QA Cases");
  cases.getCell("A1").value = "Case Ref";
  cases.getCell("D1").value = "Expected result";
  cases.getCell("A2").value = "QA-4";
  cases.getCell("B2").value = "  Add item  ";
  cases.getCell("C2").value = { formula: '"Open item"', result: "Open item" };
  cases.getCell("D2").value = "check, then save";
  cases.getCell("E2").value = 7;
  cases.getCell("E2").numFmt = '"QA-"000';
  cases.getCell("A3").value = "QA-5";
  cases.getCell("C3").value = "second objective";

  const supplemental = workbook.addWorksheet("Supplement");
  supplemental.getCell("C1").value = "retained";
  await workbook.xlsx.writeFile(path);
}

test("CSV preserves quoted multiline text, whitespace, headers, and source addresses", async () => {
  const directory = await temporaryDirectory();
  try {
    const path = join(directory, "cases.csv");
    await writeFile(
      path,
      'QA ID,Test Name,Objective\r\nQA-1,"  Open,\nclose  ","Says ""go"""\r\n',
    );

    const result = await readSpreadsheet({ path, maxBytes: 10_000 });
    deepStrictEqual(result, {
      name: "cases.csv",
      sheets: [
        {
          name: "CSV",
          cells: [
            { address: "A1", text: "QA ID" },
            { address: "B1", text: "Test Name" },
            { address: "C1", text: "Objective" },
            { address: "A2", text: "QA-1" },
            { address: "B2", text: "  Open,\nclose  " },
            { address: "C2", text: 'Says "go"' },
          ],
        },
      ],
    });

    const alternatePath = join(directory, "alternate.csv");
    await writeFile(alternatePath, "Reference,Summary,Intent\nQA-2,Other,Verify\n");
    const alternate = await readSpreadsheet({ path: alternatePath, maxBytes: 10_000 });
    deepStrictEqual(
      alternate.sheets[0]?.cells.slice(0, 3),
      [
        { address: "A1", text: "Reference" },
        { address: "B1", text: "Summary" },
        { address: "C1", text: "Intent" },
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CSV ranges use A1 addresses and need no sheet selection", async () => {
  const directory = await temporaryDirectory();
  try {
    const path = join(directory, "range.csv");
    await writeFile(
      path,
      "Reference,Summary,Goal\nQA-1,  Create item  ,Saved\nQA-2,Delete,Removed\n",
    );

    const result = await readSpreadsheet({
      path,
      range: "B2:C3",
      maxBytes: 10_000,
    });
    deepStrictEqual(result.sheets[0]?.cells, [
      { address: "B2", text: "  Create item  " },
      { address: "C2", text: "Saved" },
      { address: "B3", text: "Delete" },
      { address: "C3", text: "Removed" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("XLSX supports whole-workbook and selected sheet/range extraction", async () => {
  const directory = await temporaryDirectory();
  try {
    const path = join(directory, "cases.xlsx");
    await createWorkbook(path);

    const selected = await readSpreadsheet({
      path,
      sheet: "QA Cases",
      range: "B2:E3",
      maxBytes: 100_000,
    });
    deepStrictEqual(selected, {
      name: "cases.xlsx",
      sheets: [
        {
          name: "QA Cases",
          cells: [
            { address: "B2", text: "  Add item  " },
            { address: "C2", text: "Open item" },
            { address: "D2", text: "check, then save" },
            { address: "E2", text: "QA-007" },
            { address: "C3", text: "second objective" },
          ],
        },
      ],
    });

    const wholeWorkbook = await readSpreadsheet({ path, maxBytes: 100_000 });
    deepStrictEqual(
      wholeWorkbook.sheets.map((sheet) => sheet.name),
      ["QA Cases", "Supplement"],
    );
    deepStrictEqual(wholeWorkbook.sheets[1]?.cells, [
      { address: "C1", text: "retained" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blank selections are unavailable", async () => {
  const directory = await temporaryDirectory();
  try {
    const csvPath = join(directory, "empty.csv");
    await writeFile(csvPath, ",,\n,,\n");
    await rejects(
      readSpreadsheet({ path: csvPath, maxBytes: 10_000 }),
      /no non-empty cells/,
    );

    const xlsxPath = join(directory, "empty.xlsx");
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("QA Cases");
    await workbook.xlsx.writeFile(xlsxPath);
    await rejects(
      readSpreadsheet({ path: xlsxPath, maxBytes: 10_000 }),
      /no non-empty cells/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("XLSX output caps and abort signals fail cleanly", async () => {
  const directory = await temporaryDirectory();
  try {
    const path = join(directory, "cases.xlsx");
    await createWorkbook(path);
    await rejects(
      readSpreadsheet({ path, maxBytes: 100 }),
      /extraction exceeds maxBytes/,
    );

    const controller = new AbortController();
    controller.abort();
    await rejects(
      readSpreadsheet({ path, maxBytes: 10_000, signal: controller.signal }),
      { name: "AbortError" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsupported number formats and uncached formulas fail closed", async () => {
  const directory = await temporaryDirectory();
  try {
    const formattedPath = join(directory, "formatted.xlsx");
    const formattedWorkbook = new ExcelJS.Workbook();
    const formattedSheet = formattedWorkbook.addWorksheet("QA");
    formattedSheet.getCell("A1").value = 7;
    formattedSheet.getCell("A1").numFmt = "0.00";
    await formattedWorkbook.xlsx.writeFile(formattedPath);
    await rejects(
      readSpreadsheet({ path: formattedPath, maxBytes: 10_000 }),
      /unsupported number format/,
    );

    const formulaPath = join(directory, "uncached.xlsx");
    const formulaWorkbook = new ExcelJS.Workbook();
    formulaWorkbook.addWorksheet("QA").getCell("A1").value = { formula: "1+1" };
    await formulaWorkbook.xlsx.writeFile(formulaPath);
    await rejects(
      readSpreadsheet({ path: formulaPath, maxBytes: 10_000 }),
      /no cached result/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("aggregate XLSX cell count is bounded", async () => {
  const directory = await temporaryDirectory();
  try {
    const path = join(directory, "many-cells.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("QA");
    for (let row = 1; row <= 100_001; row += 1) {
      sheet.getCell(row, 1).value = "x";
    }
    await workbook.xlsx.writeFile(path);
    await rejects(
      readSpreadsheet({ path, maxBytes: 100_000_000 }),
      /100000-cell limit/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid and unavailable selections fail instead of returning a partial range", async () => {
  const directory = await temporaryDirectory();
  try {
    const csvPath = join(directory, "cases.csv");
    await writeFile(csvPath, "A,B\n1,2\n");
    await rejects(
      readSpreadsheet({ path: csvPath, range: "A1:C2", maxBytes: 10_000 }),
      /outside the available data/,
    );
    await rejects(
      readSpreadsheet({ path: csvPath, range: "B2:A1", maxBytes: 10_000 }),
      /Invalid spreadsheet range/,
    );

    const xlsxPath = join(directory, "cases.xlsx");
    await createWorkbook(xlsxPath);
    await rejects(
      readSpreadsheet({ path: xlsxPath, range: "A1:B2", maxBytes: 100_000 }),
      /requires a sheet name/,
    );
    await rejects(
      readSpreadsheet({ path: xlsxPath, sheet: "Missing", maxBytes: 100_000 }),
      /has no sheet named/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("input, XLSX expansion, and serialized output limits fail clearly", async () => {
  const directory = await temporaryDirectory();
  try {
    const oversizedPath = join(directory, "large.csv");
    await writeFile(oversizedPath, "");
    await truncate(oversizedPath, 8 * 1024 * 1024 + 1);
    await rejects(
      readSpreadsheet({ path: oversizedPath, maxBytes: 100 }),
      /input limit/,
    );

    const tinyPath = join(directory, "tiny.csv");
    await writeFile(tinyPath, "a\n");
    await rejects(
      readSpreadsheet({ path: tinyPath, maxBytes: 70 }),
      /extraction exceeds maxBytes/,
    );
    const extracted = await readSpreadsheet({ path: tinyPath, maxBytes: 1_000 });
    const serializedBytes = Buffer.byteLength(JSON.stringify(extracted), "utf8");
    deepStrictEqual(
      await readSpreadsheet({ path: tinyPath, maxBytes: serializedBytes }),
      extracted,
    );
    await rejects(
      readSpreadsheet({ path: tinyPath, maxBytes: serializedBytes - 1 }),
      /extraction exceeds maxBytes/,
    );

    const expandedPath = join(directory, "expanded.xlsx");
    const expandedWorkbook = new ExcelJS.Workbook();
    const expandedSheet = expandedWorkbook.addWorksheet("Data");
    const repeatedText = "x".repeat(32_000);
    for (let row = 1; row <= 1_050; row += 1) {
      expandedSheet.getCell(row, 1).value = `${repeatedText}${row}`;
    }
    await expandedWorkbook.xlsx.writeFile(expandedPath);
    await rejects(
      readSpreadsheet({ path: expandedPath, maxBytes: 100 }),
      /XLSX expanded entries exceed the 33554432-byte limit/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
