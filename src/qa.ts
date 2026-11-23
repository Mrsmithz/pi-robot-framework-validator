import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { readSpreadsheet } from "./spreadsheet.ts";

export type RobotTest = {
  file: string;
  line: number;
  endLine: number;
  name: string;
  nameDynamic: boolean;
  idDynamic?: boolean;
  documentation?: { text: string; line: number; dynamic: boolean };
  error?: string;
};

export type MappingInput = {
  sheet?: string;
  headerRow: number;
  id: string;
  name: string;
  objective: string;
};

export interface QAUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, body: string): Promise<boolean>;
}

export type MappingHeader = { column: string; text: string };
type Header = MappingHeader;
type FieldStatus = "match" | "mismatch" | "uncheckable";
type FieldResult = { status: FieldStatus; reason?: string; cell?: string; robotLine?: number };
type TestResult = {
  file: string;
  line: number;
  endLine: number;
  id: FieldResult;
  name: FieldResult;
  objective: FieldResult;
};
export type QAResult =
  | { status: "checked"; tests: TestResult[] }
  | { status: "uncheckable" | "not-applicable"; reason: string; tests: TestResult[] };

type SavedMapping = {
  format: "csv" | "xlsx";
  sheet?: string;
  headerRow: number;
  columns: { id: string; name: string; objective: string };
  headers: Header[];
};
type MappingFile = { version: 1; mappings: Record<string, SavedMapping> };
type Snapshot = { root: string; path: string; name: string; format: "csv" | "xlsx"; sheet: string; cells: { address: string; text: string }[] };
type SelectedSnapshot = { snapshot: Snapshot; data: ReturnType<typeof parseRows> };

const SIDECAR = ".pi/robot-validator-qa-mappings.json";
const MAX_BYTES = 256 * 1024;
const NO_TESTS: QAResult = { status: "not-applicable", reason: "No changed Robot tests were supplied.", tests: [] };

export async function runQA(options: {
  root: string;
  folder: string;
  tests: readonly RobotTest[];
  mapping?: string;
  headerless?: Omit<MappingInput, "headerRow">;
  ui?: QAUI;
  signal?: AbortSignal;
}): Promise<QAResult> {
  if (options.tests.length === 0) return NO_TESTS;
  let knownLayout: SavedMapping | undefined;
  try {
    const root = await projectRoot(options.root);
    if (options.headerless && options.mapping) return uncheckable("A saved mapping and a headerless mapping cannot be combined.", options.tests);
    const layout = options.headerless ? undefined : await loadMapping(root, options.mapping ?? "default");
    knownLayout = layout;
    if (!options.headerless && !layout) return uncheckable("No confirmed QA mapping was supplied.", options.tests);
    const selected = await selectSnapshot({ root, folder: options.folder, sheet: options.headerless?.sheet ?? layout?.sheet, requireSheet: true, ui: options.ui, signal: options.signal });
    if (options.headerless) {
      const columns = validatedColumns(options.headerless);
      return compareTests(options.tests, selected.data.rows, { headerRow: 0, columns }, selected.snapshot.sheet, true);
    }
    if (!layout) return uncheckable("No confirmed QA mapping was supplied.", options.tests);
    if (layout.format !== selected.snapshot.format) return layoutUncheckable("The selected QA source format differs from the confirmed mapping.", options.tests, layout);
    if (layout.sheet !== undefined && layout.sheet !== selected.snapshot.sheet) return layoutUncheckable("The confirmed sheet is no longer available.", options.tests, layout);
    const header = readHeader(selected.snapshot.cells, layout.headerRow);
    const mappedHeaders = header.filter((item) => Object.values(layout.columns).includes(item.column));
    if (!sameHeaders(mappedHeaders, layout.headers)) return layoutUncheckable("The confirmed mapped headers have changed.", options.tests, layout);
    if (!columnsExist(header, layout.columns)) return layoutUncheckable("The confirmed columns are no longer available.", options.tests, layout);
    return compareTests(options.tests, selected.data.rows, layout, selected.snapshot.sheet, false);
  } catch (error) {
    options.signal?.throwIfAborted();
    return knownLayout ? layoutUncheckable(safeFailure(error), options.tests, knownLayout) : uncheckable(safeFailure(error), options.tests);
  }
}

export async function confirmMapping(options: {
  root: string;
  folder: string;
  name: string;
  input: MappingInput;
  ui?: QAUI;
  signal?: AbortSignal;
}): Promise<{ status: "saved" | "uncheckable" | "declined"; reason?: string }> {
  try {
    const root = await projectRoot(options.root);
    const selected = await selectSnapshot({ root, folder: options.folder, sheet: options.input.sheet, ui: options.ui, signal: options.signal });
    return await confirmAndSave({ ...options, root, selected, columns: mappingInput(options.input).columns });
  } catch (error) {
    options.signal?.throwIfAborted();
    return { status: "uncheckable", reason: safeFailure(error) };
  }
}

export async function suggestMapping(options: {
  root: string;
  folder: string;
  name: string;
  sheet?: string;
  headerRow: number;
  suggest: (headers: MappingHeader[], headerRow: number) => Promise<Pick<MappingInput, "id" | "name" | "objective"> | undefined>;
  ui?: QAUI;
  signal?: AbortSignal;
}): Promise<{ status: "saved" | "uncheckable" | "declined"; reason?: string }> {
  try {
    const root = await projectRoot(options.root);
    const selected = await selectSnapshot({ root, folder: options.folder, sheet: options.sheet, ui: options.ui, signal: options.signal });
    const headers = readHeader(selected.snapshot.cells, options.headerRow);
    if (!headers.length) return { status: "uncheckable", reason: "The selected header row is empty." };
    const proposed = await options.suggest(headers.map((header) => ({ ...header })), options.headerRow);
    if (!proposed) return { status: "uncheckable", reason: "No valid mapping suggestion was returned." };
    const input = { ...proposed, sheet: selected.snapshot.sheet, headerRow: options.headerRow };
    const columns = validatedColumns(input);
    if (!columnsExist(headers, columns)) return { status: "uncheckable", reason: "The suggested columns do not match the selected headers." };
    return await confirmAndSave({ ...options, input, root, selected, columns });
  } catch (error) {
    options.signal?.throwIfAborted();
    return { status: "uncheckable", reason: safeFailure(error) };
  }
}

async function confirmAndSave(options: {
  root: string;
  name: string;
  input: MappingInput;
  selected: SelectedSnapshot;
  columns: SavedMapping["columns"];
  ui?: QAUI;
  signal?: AbortSignal;
}): Promise<{ status: "saved" | "uncheckable" | "declined"; reason?: string }> {
  if (!validMappingName(options.name)) return { status: "uncheckable", reason: "The mapping name is invalid." };
  const headers = readHeader(options.selected.snapshot.cells, options.input.headerRow);
  if (headers.length === 0) return { status: "uncheckable", reason: "The selected header row is empty." };
  if (!columnsExist(headers, options.columns)) return { status: "uncheckable", reason: "A mapped column is not present in the selected header row." };
  if (!options.ui || !await options.ui.confirm(
    "Confirm QA mapping",
    confirmationText({ ...options.input, sheet: options.selected.snapshot.sheet }, headers),
  )) return { status: "declined", reason: "The QA mapping was not confirmed." };

  const current = await readMappingFile(options.root);
  current.mappings[options.name] = {
    format: options.selected.snapshot.format,
    ...(options.selected.snapshot.format === "csv" ? {} : { sheet: options.selected.snapshot.sheet }),
    headerRow: options.input.headerRow,
    columns: options.columns,
    headers: headers.filter((header) => Object.values(options.columns).includes(header.column)),
  };
  await writeMappingFile(options.root, current);
  return { status: "saved" };
}

async function selectSnapshot(options: {
  root: string;
  folder: string;
  sheet?: string;
  requireSheet?: boolean;
  ui?: QAUI;
  signal?: AbortSignal;
}): Promise<SelectedSnapshot> {
  options.signal?.throwIfAborted();
  const folderPath = resolve(options.root, options.folder);
  const canonicalFolder = await realpath(folderPath);
  if (!isWithin(options.root, canonicalFolder)) throw new Error("folder is outside the project");
  const entries = await readdir(canonicalFolder, { withFileTypes: true });
  const eligible: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || ![".csv", ".xlsx"].includes(extname(entry.name).toLowerCase())) continue;
    const path = resolve(canonicalFolder, entry.name);
    const canonical = await realpath(path);
    if (!isWithin(options.root, canonical)) continue;
    if ((await lstat(path)).isFile()) eligible.push(entry.name);
  }
  if (eligible.length === 0) throw new Error("no eligible spreadsheet is available");
  let name: string;
  if (eligible.length === 1) name = eligible[0] ?? "";
  else {
    if (!options.ui) throw new Error("a spreadsheet choice is required");
    const selected = await options.ui.select("Choose QA source", [...eligible].sort());
    if (selected === undefined || !eligible.includes(selected)) throw new Error("a valid spreadsheet choice is required");
    name = selected;
  }
  const path = resolve(canonicalFolder, name);
  const canonicalPath = await realpath(path);
  if (!isWithin(options.root, canonicalPath) || !isWithin(canonicalFolder, canonicalPath)) throw new Error("spreadsheet is outside the configured folder");
  const initialInfo = await lstat(canonicalPath);
  if (!initialInfo.isFile()) throw new Error("spreadsheet is not a regular file");
  const isCsv = extname(name).toLowerCase() === ".csv";
  if (!isCsv && options.requireSheet && !options.sheet) throw new Error("an explicit workbook sheet is required");
  const sheet = isCsv ? "CSV" : options.sheet;
  const spreadsheet = await readSpreadsheet({ path: canonicalPath, ...(sheet ? { sheet } : {}), maxBytes: MAX_BYTES, signal: options.signal });
  let chosenSheet = sheet;
  if (!chosenSheet && spreadsheet.sheets.length > 1) {
    if (!options.ui) throw new Error("a workbook sheet choice is required");
    chosenSheet = await options.ui.select("Choose QA sheet", spreadsheet.sheets.map((candidate) => candidate.name));
    if (!chosenSheet || !spreadsheet.sheets.some((candidate) => candidate.name === chosenSheet)) throw new Error("a valid workbook sheet choice is required");
  }
  chosenSheet ??= spreadsheet.sheets[0]?.name;
  const selectedSheet = spreadsheet.sheets.find((candidate) => candidate.name === chosenSheet);
  if (!selectedSheet) throw new Error("selected sheet is unavailable");
  const finalPath = await realpath(path);
  const finalInfo = await lstat(finalPath);
  if (finalPath !== canonicalPath || !finalInfo.isFile() || !sameFileIdentity(initialInfo, finalInfo)) throw new Error("spreadsheet changed while it was read");
  const snapshot: Snapshot = { root: options.root, path: canonicalPath, name, format: isCsv ? "csv" : "xlsx", sheet: selectedSheet.name, cells: selectedSheet.cells };
  return { snapshot, data: parseRows(selectedSheet.cells) };
}

function parseRows(cells: Snapshot["cells"]): { rows: Map<number, Map<string, string>>; maxColumn: number } {
  const rows = new Map<number, Map<string, string>>();
  let maxColumn = 0;
  for (const cell of cells) {
    const match = /^([A-Z]+)([1-9]\d*)$/.exec(cell.address);
    if (!match) throw new Error("spreadsheet returned an invalid cell address");
    const column = match[1] ?? "";
    const row = Number(match[2]);
    const values = rows.get(row) ?? new Map<string, string>();
    values.set(column, cell.text);
    rows.set(row, values);
    maxColumn = Math.max(maxColumn, columnNumber(column));
  }
  return { rows, maxColumn };
}

function readHeader(cells: Snapshot["cells"], headerRow: number): Header[] {
  if (!Number.isSafeInteger(headerRow) || headerRow < 1) throw new Error("invalid header row");
  const parsed = parseRows(cells);
  const row = parsed.rows.get(headerRow);
  if (!row) return [];
  return Array.from({ length: parsed.maxColumn }, (_, index) => ({
    column: columnName(index + 1),
    text: row.get(columnName(index + 1)) ?? "",
  }));
}

function mappingInput(input: MappingInput): { columns: SavedMapping["columns"] } {
  if (!Number.isSafeInteger(input.headerRow) || input.headerRow < 1) throw new Error("invalid header row");
  if (input.sheet !== undefined && input.sheet.length === 0) throw new Error("invalid sheet name");
  return { columns: validatedColumns(input) };
}

function validatedColumns(input: Pick<MappingInput, "id" | "name" | "objective">): SavedMapping["columns"] {
  const columns = { id: input.id, name: input.name, objective: input.objective };
  const unique = new Set(Object.values(columns));
  if (unique.size !== 3 || Object.values(columns).some((column) => !/^[A-Z]{1,3}$/.test(column) || columnNumber(column) > 16_384)) {
    throw new Error("invalid column assignments");
  }
  return columns;
}

function compareTests(tests: readonly RobotTest[], rows: Map<number, Map<string, string>>, layout: Pick<SavedMapping, "headerRow" | "columns">, sheet: string, headerless: boolean): QAResult {
  const idRows = new Map<string, number[]>();
  const blankIdRows: number[] = [];
  const firstDataRow = headerless ? 1 : layout.headerRow + 1;
  for (const [row, values] of [...rows.entries()].sort(([left], [right]) => left - right)) {
    if (row < firstDataRow || [...values.values()].every((value) => value.trim() === "")) continue;
    const id = values.get(layout.columns.id) ?? "";
    if (id.trim() === "") { blankIdRows.push(row); continue; }
    const found = idRows.get(id) ?? [];
    found.push(row);
    idRows.set(id, found);
  }

  return {
    status: "checked",
    tests: tests.map((test): TestResult => {
      const robotId = test.name.split(/\s+/, 1)[0] ?? "";
      const idDynamic = test.idDynamic ?? test.nameDynamic;
      const matches = idRows.get(robotId) ?? [];
      if (test.error || robotId === "" || idDynamic) return { file: test.file, line: test.line, endLine: test.endLine, id: uncheckableField("The Robot test ID is incomplete or dynamic."), name: uncheckableField("The Robot test ID is incomplete or dynamic."), objective: uncheckableField("The Robot test ID is incomplete or dynamic.") };
      if (matches.length > 1) {
        const cell = `${sheet}!${layout.columns.id}${matches[0]}`;
        return { file: test.file, line: test.line, endLine: test.endLine, id: uncheckableField("The QA ID is ambiguous.", cell), name: uncheckableField("The QA ID is ambiguous.", cell), objective: uncheckableField("The QA ID is ambiguous.", cell) };
      }
      const row = matches[0];
      if (row === undefined) {
        const id = blankIdRows.length > 0
          ? uncheckableField("A QA row has no ID, so absence cannot be confirmed.", `${sheet}!${layout.columns.id}${blankIdRows[0]}`)
          : { status: "mismatch", reason: "No QA record has this ID." } satisfies FieldResult;
        const unavailable = uncheckableField("No unique QA record is available for field comparison.");
        return { file: test.file, line: test.line, endLine: test.endLine, id, name: unavailable, objective: unavailable };
      }
      const values = rows.get(row) ?? new Map<string, string>();
      const id: FieldResult = { status: "match", cell: `${sheet}!${layout.columns.id}${row}` };
      const nameCell = `${sheet}!${layout.columns.name}${row}`;
      const objectiveCell = `${sheet}!${layout.columns.objective}${row}`;
      const expectedName = values.get(layout.columns.name) ?? "";
      const expectedObjective = values.get(layout.columns.objective) ?? "";
      const actualName = test.name.slice(robotId.length).replace(/^\s/, "");
      const name: FieldResult = test.nameDynamic
        ? uncheckableField("The Robot test name uses runtime substitution.", nameCell, test.line)
        : expectedName.trim() === ""
          ? uncheckableField("The QA name is blank.", nameCell, test.line)
          : lineEndings(actualName) === lineEndings(expectedName)
            ? { status: "match", cell: nameCell, robotLine: test.line }
            : { status: "mismatch", reason: "The Robot test name differs from the QA name.", cell: nameCell, robotLine: test.line };
      const documentation = test.documentation;
      const documentationLine = documentation?.line ?? test.line;
      const objective: FieldResult = documentation?.dynamic
        ? uncheckableField("The Robot documentation uses runtime substitution.", objectiveCell, documentation.line)
        : expectedObjective.trim() === ""
          ? uncheckableField("The QA objective is blank.", objectiveCell, documentationLine)
          : documentation === undefined
            ? { status: "mismatch", reason: "Robot documentation is missing.", cell: objectiveCell, robotLine: documentationLine }
            : lineEndings(documentation.text) === lineEndings(expectedObjective)
              ? { status: "match", cell: objectiveCell, robotLine: documentationLine }
              : { status: "mismatch", reason: "Robot documentation differs from the QA objective.", cell: objectiveCell, robotLine: documentationLine };
      return { file: test.file, line: test.line, endLine: test.endLine, id, name, objective };
    }),
  };
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function lineEndings(value: string): string { return value.replace(/\r\n?/g, "\n"); }
function uncheckableField(reason: string, cell?: string, robotLine?: number): FieldResult { return { status: "uncheckable", reason, ...(cell ? { cell } : {}), ...(robotLine !== undefined ? { robotLine } : {}) }; }
function uncheckable(reason: string, tests: readonly RobotTest[]): QAResult {
  return { status: "uncheckable", reason, tests: tests.map((test) => ({ file: test.file, line: test.line, endLine: test.endLine, id: uncheckableField(reason), name: uncheckableField(reason), objective: uncheckableField(reason) })) };
}
function layoutUncheckable(reason: string, tests: readonly RobotTest[], layout: SavedMapping): QAResult {
  const sheet = layout.sheet ?? "CSV";
  return { status: "uncheckable", reason, tests: tests.map((test) => ({
    file: test.file, line: test.line, endLine: test.endLine,
    id: uncheckableField(reason, `${sheet}!${layout.columns.id}${layout.headerRow}`),
    name: uncheckableField(reason, `${sheet}!${layout.columns.name}${layout.headerRow}`),
    objective: uncheckableField(reason, `${sheet}!${layout.columns.objective}${layout.headerRow}`),
  })) };
}
function sameHeaders(left: Header[], right: Header[]): boolean {
  return left.length === right.length && left.every((header, index) => header.column === right[index]?.column && header.text === right[index]?.text);
}
function columnsExist(headers: Header[], columns: SavedMapping["columns"]): boolean {
  return Object.values(columns).every((column) => headers.some((header) => header.column === column && header.text !== ""));
}
function confirmationText(input: MappingInput, headers: Header[]): string {
  const details = headers.map(({ column, text }) => `${column}: ${JSON.stringify(text)}`);
  return [`Sheet: ${JSON.stringify(input.sheet ?? "CSV")}`, `Header row: ${input.headerRow}`, `ID: ${input.id}`, `Name: ${input.name}`, `Objective: ${input.objective}`, "Headers:", ...details].join("\n");
}

async function loadMapping(root: string, name: string): Promise<SavedMapping | undefined> {
  if (!validMappingName(name)) throw new Error("invalid mapping name");
  const file = await readMappingFile(root);
  return Object.hasOwn(file.mappings, name) ? file.mappings[name] : undefined;
}

async function readMappingFile(root: string): Promise<MappingFile> {
  const path = await safeSidecarPath(root, false);
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    return parseMappingFile(raw);
  } catch (error) {
    if (isCode(error, "ENOENT")) return { version: 1, mappings: {} };
    throw new Error("saved QA mappings are invalid");
  }
}

function parseMappingFile(value: unknown): MappingFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.mappings)) throw new Error("invalid mapping file");
  const mappings: Record<string, SavedMapping> = {};
  for (const [name, candidate] of Object.entries(value.mappings)) {
    if (!validMappingName(name) || !isRecord(candidate) || (candidate.format !== "csv" && candidate.format !== "xlsx") || !Number.isSafeInteger(candidate.headerRow) || typeof candidate.headerRow !== "number" || candidate.headerRow < 1) throw new Error("invalid mapping entry");
    if (!isRecord(candidate.columns) || typeof candidate.columns.id !== "string" || typeof candidate.columns.name !== "string" || typeof candidate.columns.objective !== "string") throw new Error("invalid mapping columns");
    if (candidate.sheet !== undefined && (typeof candidate.sheet !== "string" || candidate.sheet.length === 0)) throw new Error("invalid mapping sheet");
    if (candidate.format === "csv" && candidate.sheet !== undefined) throw new Error("invalid CSV mapping sheet");
    if (candidate.format === "xlsx" && typeof candidate.sheet !== "string") throw new Error("invalid XLSX mapping sheet");
    if (!Array.isArray(candidate.headers) || !candidate.headers.every((header) => isRecord(header) && typeof header.column === "string" && typeof header.text === "string")) throw new Error("invalid mapping headers");
    const format: SavedMapping["format"] = candidate.format;
    const parsed: SavedMapping = { format, headerRow: candidate.headerRow, ...(typeof candidate.sheet === "string" ? { sheet: candidate.sheet } : {}), columns: { id: candidate.columns.id, name: candidate.columns.name, objective: candidate.columns.objective }, headers: candidate.headers.map((header) => ({ column: String(header.column), text: String(header.text) })) };
    mappingInput({ ...parsed.columns, headerRow: parsed.headerRow, ...(parsed.sheet ? { sheet: parsed.sheet } : {}) });
    if (!columnsExist(parsed.headers, parsed.columns) || new Set(parsed.headers.map((header) => header.column)).size !== parsed.headers.length) throw new Error("invalid mapping headers");
    mappings[name] = parsed;
  }
  return { version: 1, mappings };
}

async function writeMappingFile(root: string, value: MappingFile): Promise<void> {
  const path = await safeSidecarPath(root, true);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const tempReal = await realpath(temp);
    if (!isWithin(root, tempReal)) throw new Error("mapping file is outside the project");
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function safeSidecarPath(root: string, createDirectory: boolean): Promise<string> {
  const directory = resolve(root, ".pi");
  if (createDirectory) await mkdir(directory, { recursive: true });
  let canonicalDirectory: string;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory()) throw new Error("mapping storage is unsafe");
    canonicalDirectory = await realpath(directory);
  } catch (error) {
    if (isCode(error, "ENOENT") && !createDirectory) return resolve(root, SIDECAR);
    throw error;
  }
  if (!isWithin(root, canonicalDirectory)) throw new Error("mapping storage is outside the project");
  const path = resolve(canonicalDirectory, basename(SIDECAR));
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || !isWithin(root, await realpath(path))) throw new Error("mapping storage is unsafe");
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  return path;
}

async function projectRoot(path: string): Promise<string> {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw new Error("project root is unavailable");
  return root;
}
function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function validMappingName(name: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isCode(error: unknown, code: string): boolean { return isRecord(error) && error.code === code; }
function safeFailure(error: unknown): string {
  if (isRecord(error) && error.message === "no eligible spreadsheet is available") return "No eligible QA spreadsheet is available.";
  if (isRecord(error) && error.message === "a spreadsheet choice is required") return "Choose a QA spreadsheet in the native developer UI.";
  if (isRecord(error) && error.message === "a valid spreadsheet choice is required") return "A valid QA spreadsheet choice is required.";
  return "QA input or mapping is unavailable or invalid.";
}
function columnNumber(column: string): number {
  let result = 0;
  for (const character of column) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}
function columnName(value: number): string {
  let result = "";
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}
