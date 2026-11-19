import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, extname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";

const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs") as typeof import("exceljs");
const unzipper = require("unzipper") as {
  Parse(options: { forceStream: true }): unknown;
};

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_XLSX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_XLSX_CELLS = 100_000;

type ZipEntry = AsyncIterable<Buffer> & {
  path?: string;
  vars?: { uncompressedSize?: number };
};

type ZipArchive = AsyncIterable<ZipEntry> & NodeJS.WritableStream & {
  destroy(error?: Error): void;
};

export type Spreadsheet = {
  name: string;
  sheets: { name: string; cells: { address: string; text: string }[] }[];
};

type CellRange = {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
};

type MutableSheet = Spreadsheet["sheets"][number];

type LimitedInput = {
  source: ReturnType<typeof createReadStream>;
  stream: Transform;
};

class SerializedByteBudget {
  private bytes: number;

  constructor(
    private readonly name: string,
    private readonly maxBytes: number,
  ) {
    this.bytes = Buffer.byteLength(
      `{"name":${JSON.stringify(name)},"sheets":[]}`,
      "utf8",
    );
    this.check();
  }

  addSheet(sheetName: string, sheetCount: number): void {
    this.bytes +=
      (sheetCount === 0 ? 0 : 1) +
      Buffer.byteLength(
        `{"name":${JSON.stringify(sheetName)},"cells":[]}`,
        "utf8",
      );
    this.check();
  }

  addCell(cell: { address: string; text: string }, cellCount: number): void {
    this.bytes +=
      (cellCount === 0 ? 0 : 1) +
      Buffer.byteLength(JSON.stringify(cell), "utf8");
    this.check();
  }

  private check(): void {
    if (this.bytes > this.maxBytes) {
      throw new Error(
        `Spreadsheet extraction exceeds maxBytes: serialized cells exceed ${this.maxBytes} bytes.`,
      );
    }
  }
}

export async function readSpreadsheet(options: {
  path: string;
  sheet?: string;
  range?: string;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<Spreadsheet> {
  validateMaxBytes(options.maxBytes);

  const extension = extname(options.path).toLowerCase();
  if (extension !== ".csv" && extension !== ".xlsx") {
    throw new Error(`Unsupported spreadsheet file type: ${extension || "unknown"}.`);
  }

  if (extension === ".xlsx" && options.range !== undefined && options.sheet === undefined) {
    throw new Error("An XLSX range requires a sheet name.");
  }
  if (extension === ".csv" && options.sheet !== undefined && options.sheet !== "CSV") {
    throw new Error(`CSV has no sheet named ${JSON.stringify(options.sheet)}.`);
  }

  const range = options.range === undefined ? undefined : parseRange(options.range);
  await validateInputFile(options.path, MAX_INPUT_BYTES, options.signal);

  const spreadsheet =
    extension === ".csv"
      ? await readCsv(options, range)
      : await readXlsx(options, range);
  assertSpreadsheetHasContent(spreadsheet);
  return spreadsheet;
}

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
}

async function validateInputFile(
  path: string,
  inputLimitBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const info = await stat(path);
  signal?.throwIfAborted();

  if (!info.isFile()) {
    throw new Error("Spreadsheet path must refer to a file.");
  }
  if (info.size > inputLimitBytes) {
    throw new Error(
      `Spreadsheet input exceeds the ${inputLimitBytes}-byte input limit: ${info.size} bytes.`,
    );
  }
}

function createLimitedInput(
  path: string,
  inputLimitBytes: number,
  signal?: AbortSignal,
): LimitedInput {
  const source = createReadStream(path, {
    highWaterMark: Math.min(64 * 1024, inputLimitBytes),
    signal,
  });
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > inputLimitBytes) {
        callback(
          new Error(
            `Spreadsheet input exceeds the ${inputLimitBytes}-byte input limit.`,
          ),
        );
      } else {
        callback(null, chunk);
      }
    },
  });
  return { source, stream };
}

async function readLimitedFile(
  path: string,
  inputLimitBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const input = createLimitedInput(path, inputLimitBytes, signal);
  const inputDone = pipeline(input.source, input.stream);
  void inputDone.catch(() => undefined);
  const chunks: Buffer[] = [];
  let byteLength = 0;

  try {
    for await (const value of input.stream) {
      if (!Buffer.isBuffer(value)) {
        throw new Error("Spreadsheet input stream returned a non-buffer chunk.");
      }
      chunks.push(value);
      byteLength += value.length;
    }
    await inputDone;
    const result = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } catch (error) {
    input.source.destroy();
    input.stream.destroy();
    await inputDone.catch(() => undefined);
    throw error;
  }
}

function createOutput(name: string, maxBytes: number): {
  spreadsheet: Spreadsheet;
  addSheet(sheetName: string): MutableSheet;
  addCell(sheet: MutableSheet, cell: { address: string; text: string }): void;
} {
  const spreadsheet: Spreadsheet = { name, sheets: [] };
  const budget = new SerializedByteBudget(name, maxBytes);

  return {
    spreadsheet,
    addSheet(sheetName) {
      budget.addSheet(sheetName, spreadsheet.sheets.length);
      const sheet: MutableSheet = { name: sheetName, cells: [] };
      spreadsheet.sheets.push(sheet);
      return sheet;
    },
    addCell(sheet, cell) {
      budget.addCell(cell, sheet.cells.length);
      sheet.cells.push(cell);
    },
  };
}

async function readCsv(
  options: { path: string; maxBytes: number; signal?: AbortSignal },
  range: CellRange | undefined,
): Promise<Spreadsheet> {
  const output = createOutput(basename(options.path), options.maxBytes);
  const sheet = output.addSheet("CSV");
  const input = createLimitedInput(options.path, MAX_INPUT_BYTES, options.signal);
  const parser = parse({
    bom: true,
    max_record_size: MAX_INPUT_BYTES,
    relax_column_count: true,
    skip_empty_lines: false,
  });
  const inputDone = pipeline(input.source, input.stream, parser);
  void inputDone.catch(() => undefined);

  let rowCount = 0;
  let maxColumn = 0;

  try {
    for await (const recordValue of parser) {
      if (!Array.isArray(recordValue) || !recordValue.every((cell) => typeof cell === "string")) {
        throw new Error("CSV parser returned an invalid row.");
      }
      const record = recordValue as string[];
      rowCount += 1;
      maxColumn = Math.max(maxColumn, record.length);

      for (let index = 0; index < record.length; index += 1) {
        const column = index + 1;
        if (range !== undefined && !contains(range, rowCount, column)) {
          continue;
        }
        output.addCell(sheet, {
          address: `${columnName(column)}${rowCount}`,
          text: record[index] ?? "",
        });
      }
    }
    await inputDone;
  } catch (error) {
    input.source.destroy();
    input.stream.destroy();
    parser.destroy();
    await inputDone.catch(() => undefined);
    throw error;
  }

  if (range !== undefined) {
    assertRangeAvailable(range, rowCount, maxColumn);
  }
  return output.spreadsheet;
}

async function readXlsx(
  options: {
    path: string;
    sheet?: string;
    maxBytes: number;
    signal?: AbortSignal;
  },
  range: CellRange | undefined,
): Promise<Spreadsheet> {
  const output = createOutput(basename(options.path), options.maxBytes);
  const input = await readLimitedFile(options.path, MAX_INPUT_BYTES, options.signal);
  await assertXlsxExpansionBound(input, options.signal);
  options.signal?.throwIfAborted();

  const workbook = new ExcelJS.Workbook();
  const workbookData = new ArrayBuffer(input.length);
  new Uint8Array(workbookData).set(input);
  await workbook.xlsx.load(workbookData);
  options.signal?.throwIfAborted();
  assertAggregateCellLimit(workbook);

  const selectedWorksheet =
    options.sheet === undefined ? undefined : workbook.getWorksheet(options.sheet);
  if (options.sheet !== undefined && selectedWorksheet === undefined) {
    throw new Error(`XLSX has no sheet named ${JSON.stringify(options.sheet)}.`);
  }
  const worksheets =
    selectedWorksheet === undefined ? workbook.worksheets : [selectedWorksheet];

  for (const worksheet of worksheets) {
    const sheet = output.addSheet(worksheet.name);
    let maxRow = 0;
    let maxColumn = 0;
    worksheet.eachRow((row, rowNumber) => {
      maxRow = Math.max(maxRow, rowNumber);
      row.eachCell((cell, columnNumber) => {
        maxColumn = Math.max(maxColumn, columnNumber);
        if (!contains(range, rowNumber, columnNumber)) {
          return;
        }
        const text = cellText(cell.value, cell.numFmt, cell.address);
        if (text !== undefined) {
          output.addCell(sheet, { address: cell.address, text });
        }
      });
    });

    if (range !== undefined) {
      assertRangeAvailable(range, maxRow, maxColumn);
    }
  }
  return output.spreadsheet;
}

async function assertXlsxExpansionBound(input: Buffer, signal?: AbortSignal): Promise<void> {
  const source = Readable.from([input]);
  const archive = unzipper.Parse({ forceStream: true }) as ZipArchive;
  const inputDone = pipeline(source, archive);
  void inputDone.catch(() => undefined);
  let expandedBytes = 0;
  let cellCount = 0;

  try {
    for await (const entry of archive) {
      signal?.throwIfAborted();
      const isWorksheet = /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.path ?? "");
      let cellTagTail: Buffer = Buffer.alloc(0);
      const declaredSize = entry.vars?.uncompressedSize;
      if (declaredSize !== undefined && declaredSize > MAX_XLSX_EXPANDED_BYTES) {
        throw new Error(
          `XLSX expanded entries exceed the ${MAX_XLSX_EXPANDED_BYTES}-byte limit.`,
        );
      }
      for await (const chunk of entry) {
        signal?.throwIfAborted();
        expandedBytes += chunk.length;
        if (expandedBytes > MAX_XLSX_EXPANDED_BYTES) {
          throw new Error(
            `XLSX expanded entries exceed the ${MAX_XLSX_EXPANDED_BYTES}-byte limit.`,
          );
        }
        if (isWorksheet) {
          const scan = scanCellTags(chunk, cellTagTail);
          cellCount += scan.count;
          cellTagTail = scan.tail;
          if (cellCount > MAX_XLSX_CELLS) {
            throw new Error(`XLSX workbook exceeds the ${MAX_XLSX_CELLS}-cell limit.`);
          }
        }
      }
    }
    await inputDone;
  } catch (error) {
    source.destroy();
    archive.destroy();
    await inputDone.catch(() => undefined);
    throw error;
  }
}

function scanCellTags(chunk: Buffer, tail: Buffer): { count: number; tail: Buffer } {
  const combined = Buffer.allocUnsafe(tail.length + chunk.length);
  combined.set(tail);
  combined.set(chunk, tail.length);
  let count = 0;
  for (let index = 0; index + 2 < combined.length; index += 1) {
    const delimiter = combined[index + 2] ?? 0;
    if (
      combined[index] === 60 &&
      combined[index + 1] === 99 &&
      (delimiter === 9 ||
        delimiter === 10 ||
        delimiter === 13 ||
        delimiter === 32 ||
        delimiter === 47 ||
        delimiter === 62)
    ) {
      count += 1;
    }
  }
  const tailStart = Math.max(0, combined.length - 2);
  const nextTail = Buffer.allocUnsafe(combined.length - tailStart);
  nextTail.set(combined.subarray(tailStart));
  return { count, tail: nextTail };
}

function parseRange(value: string): CellRange {
  const match = /^([A-Za-z]{1,3})([1-9]\d*):([A-Za-z]{1,3})([1-9]\d*)$/.exec(value);
  if (match === null) {
    throw new Error(`Invalid spreadsheet range ${JSON.stringify(value)}.`);
  }

  const startColumn = columnIndex(match[1] ?? "");
  const startRow = Number(match[2]);
  const endColumn = columnIndex(match[3] ?? "");
  const endRow = Number(match[4]);
  if (
    startColumn > 16_384 ||
    endColumn > 16_384 ||
    startRow > 1_048_576 ||
    endRow > 1_048_576 ||
    startColumn > endColumn ||
    startRow > endRow
  ) {
    throw new Error(`Invalid spreadsheet range ${JSON.stringify(value)}.`);
  }
  return { startRow, endRow, startColumn, endColumn };
}

function columnIndex(name: string): number {
  let column = 0;
  for (const character of name.toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return column;
}

function columnName(column: number): string {
  let name = "";
  while (column > 0) {
    column -= 1;
    name = String.fromCharCode(65 + (column % 26)) + name;
    column = Math.floor(column / 26);
  }
  return name;
}

function contains(range: CellRange | undefined, row: number, column: number): boolean {
  return (
    range === undefined ||
    (row >= range.startRow &&
      row <= range.endRow &&
      column >= range.startColumn &&
      column <= range.endColumn)
  );
}

function assertRangeAvailable(range: CellRange, rows: number, columns: number): void {
  if (range.endRow > rows || range.endColumn > columns) {
    throw new Error("Spreadsheet range is outside the available data.");
  }
}

function assertSpreadsheetHasContent(spreadsheet: Spreadsheet): void {
  const hasContent = spreadsheet.sheets.some((sheet) =>
    sheet.cells.some((cell) => cell.text.trim().length > 0),
  );
  if (!hasContent) {
    throw new Error("Spreadsheet selection is unavailable: it contains no non-empty cells.");
  }
}

function assertAggregateCellLimit(workbook: import("exceljs").Workbook): void {
  let cellCount = 0;
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow((row) => {
      row.eachCell(() => {
        cellCount += 1;
        if (cellCount > MAX_XLSX_CELLS) {
          throw new Error(`XLSX workbook exceeds the ${MAX_XLSX_CELLS}-cell limit.`);
        }
      });
    });
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function cellText(
  value: unknown,
  numFmt: string | undefined,
  address: string,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return formatNumber(value, numFmt, address);
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (value instanceof Date) {
    throw new Error(`XLSX cell ${address} has a date value with an unsupported display format.`);
  }
  if (isRecord(value)) {
    if ("formula" in value || "sharedFormula" in value) {
      if (!("result" in value) || value.result === undefined || value.result === null) {
        throw new Error(`XLSX formula cell ${address} has no cached result.`);
      }
      return cellText(value.result, numFmt, address);
    }
    if (Array.isArray(value.richText)) {
      return value.richText
        .map((run: unknown) => {
          if (!isRecord(run) || typeof run.text !== "string") {
            throw new Error(`XLSX rich-text cell ${address} has an invalid text run.`);
          }
          return run.text;
        })
        .join("");
    }
    if (typeof value.text === "string") {
      return value.text;
    }
    if (typeof value.error === "string") {
      return value.error;
    }
  }
  throw new Error(`XLSX cell ${address} has an unsupported value.`);
}

function formatNumber(value: number, numFmt: string | undefined, address: string): string {
  const format = numFmt ?? "General";
  if (format.toLowerCase() === "general" && Number.isFinite(value)) {
    const text = String(value);
    if (!/[eE]/.test(text) && (!Number.isInteger(value) || Number.isSafeInteger(value))) {
      return text;
    }
  }

  const quotedPrefix = /^"((?:[^"]|"")*)"(0+)$/.exec(format);
  const zeroPattern = /^(0+)$/.exec(format);
  if (Number.isSafeInteger(value) && value >= 0) {
    if (quotedPrefix !== null) {
      const prefix = (quotedPrefix[1] ?? "").replace(/""/g, '"');
      const width = quotedPrefix[2]?.length ?? 0;
      return prefix + String(value).padStart(width, "0");
    }
    if (zeroPattern !== null) {
      return String(value).padStart(format.length, "0");
    }
  }
  throw new Error(
    `XLSX cell ${address} has unsupported number format ${JSON.stringify(format)}.`,
  );
}
