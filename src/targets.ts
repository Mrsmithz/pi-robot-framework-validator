import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export type LineRange = { startLine: number; endLine: number };
export type Change = { path: string; ranges?: readonly LineRange[]; category?: string };
export type KeywordContext = LineRange & { path: string };
export type Source = { file: string; startLine: number; text: string };
export type ScopeGap = { file: string; reason: string };
export type ResolvedChange = Omit<Change, "path"> & { file: string; absolute: string };
export type Snapshot = ResolvedChange & { text: string; version: string };

const maxSourceBytes = 256 * 1024;
const extensions = [".robot", ".resource"];

function within(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function selectedFile(root: string, path: string): Promise<string> {
  const supported = (file: string) => extensions.includes(extname(file).toLowerCase());
  if (!supported(path)) throw new Error("Select a .robot or .resource file.");
  const candidate = resolve(root, path);
  if (!within(root, candidate)) throw new Error("File is outside the project.");
  const file = await realpath(candidate).catch(() => { throw new Error("Robot file is unavailable."); });
  if (!within(root, file)) throw new Error("File is outside the project.");
  if (!supported(file) || !(await stat(file).catch(() => undefined))?.isFile()) throw new Error("Robot file is unavailable.");
  return file;
}

export async function resolveChanges(root: string, changes: readonly Change[], signal?: AbortSignal) {
  const files = new Map<string, ResolvedChange>();
  const unavailable: ScopeGap[] = [];
  for (const { path, ranges, category } of changes) {
    signal?.throwIfAborted();
    try {
      const absolute = await selectedFile(root, path);
      const file = relative(root, absolute);
      const previous = files.get(absolute);
      if (previous) throw new Error("Use one entry per Robot file, with all its changed ranges.");
      files.set(absolute, { file, absolute, ranges, category });
    } catch (error) {
      unavailable.push({ file: path, reason: error instanceof Error ? error.message : "Robot file is unavailable." });
    }
  }
  return { files: [...files.values()].sort((a, b) => a.file.localeCompare(b.file)), unavailable };
}

function version(info: { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function budgetedReader(signal?: AbortSignal) {
  let budget = maxSourceBytes;
  return async function read(file: string) {
    signal?.throwIfAborted();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(budget)) throw new Error("Robot source exceeds the review size limit.");
      const current = await stat(file, { bigint: true });
      if (await realpath(file) !== file || before.dev !== current.dev || version(before) !== version(current)) {
        throw new Error("Robot file moved. Retry the review.");
      }
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      while (count < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (count !== Number(before.size) || version(before) !== version(after) || await realpath(file) !== file) {
        throw new Error("Robot file changed while reading it. Retry the review.");
      }
      budget -= count;
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count)), version: version(after) };
    } finally {
      await handle.close();
    }
  };
}

function rows(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export async function readSnapshots(root: string, files: readonly ResolvedChange[], signal?: AbortSignal) {
  const read = budgetedReader(signal);
  const snapshots: Snapshot[] = [];
  const unavailable: ScopeGap[] = [];
  for (const file of files) {
    try {
      if (await selectedFile(root, file.file) !== file.absolute) throw new Error("Robot file moved. Retry the review.");
      const snapshot = await read(file.absolute);
      const size = rows(snapshot.text).length;
      if (file.ranges?.some(({ startLine, endLine }) => startLine > endLine || endLine > size)) {
        throw new Error("A changed line range does not fit the current file. Refresh the task scope and retry.");
      }
      snapshots.push({ ...file, ...snapshot });
    } catch (error) {
      signal?.throwIfAborted();
      unavailable.push({ file: file.file, reason: error instanceof Error ? error.message : "Could not read Robot source." });
    }
  }
  return { snapshots, unavailable };
}

export async function changedSinceRead(root: string, snapshots: readonly Snapshot[]): Promise<string[]> {
  const changed = await Promise.all(snapshots.map(async (file) => {
    try {
      const current = await selectedFile(root, file.file);
      if (current === file.absolute && version(await stat(current, { bigint: true })) === file.version) return undefined;
    } catch {
      // A disappeared or unreadable file invalidates the snapshot.
    }
    return file.file;
  }));
  return changed.filter((file) => file !== undefined);
}

export function touches(ranges: readonly LineRange[] | undefined, startLine: number, endLine: number): boolean {
  return ranges === undefined || ranges.some((range) => range.startLine <= endLine && startLine <= range.endLine);
}

export function changeSources(snapshots: readonly Snapshot[], tests: readonly { file: string; line: number; endLine: number }[]) {
  const changes: Source[] = [];
  const context: Source[] = [];
  for (const snapshot of snapshots) {
    const lines = rows(snapshot.text);
    if (!lines.length) continue;
    const ranges = snapshot.ranges ?? [{ startLine: 1, endLine: lines.length }];
    const merged: LineRange[] = [];
    for (const range of ranges.toSorted((a, b) => a.startLine - b.startLine)) {
      const previous = merged.at(-1);
      if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
      else merged.push({ ...range });
    }
    const excerpt = ({ startLine, endLine }: LineRange) => ({ file: snapshot.file, startLine,
      text: lines.slice(startLine - 1, endLine).join("") });
    changes.push(...merged.map(excerpt));
    if (!snapshot.ranges) continue;
    const declarations = extname(snapshot.file).toLowerCase() === ".resource" ? keywordRanges(lines) :
      tests.filter((test) => test.file === snapshot.file).map(({ line, endLine }) => ({ startLine: line, endLine }));
    for (const span of declarations) {
      if (touches(merged, span.startLine, span.endLine) &&
          !merged.some(({ startLine, endLine }) => startLine <= span.startLine && endLine >= span.endLine)) {
        context.push(excerpt(span));
      }
    }
  }
  return { changes, context };
}

function sectionName(line: string): string | undefined {
  const heading = line.trim().replace(/^\|\s*|\s*\|$/g, "");
  return heading.match(/^\*{3}\s*([^*]+?)\s*\*{3}$/)?.[1]?.toLowerCase();
}

function cells(line: string): string[] {
  const trimmed = line.trimEnd();
  return trimmed.startsWith("|") ? trimmed.split("|").slice(1, -1).map((cell) => cell.trim()) : trimmed.split(/ {2,}|\t/);
}

function keywordHeading(line: string): string | undefined {
  if (!line.trim() || /^\s/.test(line) || line.startsWith("#")) return undefined;
  const name = cells(line)[0];
  return name && !name.startsWith("#") ? name : undefined;
}

function keywordRanges(lines: readonly string[]): LineRange[] {
  const ranges: LineRange[] = [];
  let inKeywords = false;
  let startLine: number | undefined;
  for (const [index, line] of lines.entries()) {
    const heading = sectionName(line);
    const keyword = !heading && inKeywords && keywordHeading(line);
    if (!heading && !keyword) continue;
    if (startLine !== undefined) ranges.push({ startLine, endLine: index });
    startLine = keyword ? index + 1 : undefined;
    if (heading) inKeywords = heading === "keywords" || heading === "keyword";
  }
  if (startLine !== undefined) ranges.push({ startLine, endLine: lines.length });
  return ranges;
}

function normalizedKeyword(text: string): string {
  return text.trim().replace(/^(given|when|then|and|but)\s+/i, "").replace(/[\s_]/g, "").toLowerCase();
}

function keywordCalls(text: string): string[] {
  return rows(text).flatMap((line) => {
    const [first, ...arguments_] = cells(line);
    if (first !== "") return [];
    const body = arguments_.filter(Boolean);
    const firstCall = body.findIndex((cell) => !/^[$@&]\{[^}]+\}\s*=?$/.test(cell));
    if (firstCall < 0) return [];
    const candidate = body[firstCall];
    if (!candidate || candidate.startsWith("#")) return [];
    if (/^\[(?:setup|teardown|template)\]$/i.test(candidate)) {
      const name = body[firstCall + 1];
      return name ? [normalizedKeyword(name)] : [];
    }
    return candidate.startsWith("[") ? [] : [normalizedKeyword(candidate)];
  });
}

export async function readKeywordContext(options: {
  root: string; snapshots: readonly Snapshot[]; changes: readonly Source[]; context: readonly KeywordContext[]; signal?: AbortSignal;
}): Promise<{ sources: Source[]; unavailable: ScopeGap[] }> {
  const { root, snapshots, changes, context, signal } = options;
  const sources: Source[] = [];
  const unavailable: ScopeGap[] = [];
  if (!context.length) return { sources, unavailable };
  const callsByResource = new Map<string, Set<string>>();
  const addCalls = (resource: string, calls: readonly string[]) => {
    const known = callsByResource.get(resource) ?? new Set<string>();
    for (const call of calls) known.add(call);
    callsByResource.set(resource, known);
  };
  for (const { file, text, absolute } of snapshots) {
    const calls = changes.filter((change) => change.file === file).flatMap((change) => keywordCalls(change.text));
    if (!calls.length) continue;
    addCalls(absolute, calls);
    let section: string | undefined;
    for (const line of rows(text)) {
      section = sectionName(line) ?? section;
      if (section !== "settings" && section !== "setting") continue;
      const [setting, resource] = cells(line);
      if (setting?.trim().toLowerCase() !== "resource" || !resource) continue;
      const path = resource.replace(/^\$\{CURDIR\}(?=[/\\])/i, dirname(absolute));
      if (/[$@&%]\{/.test(path)) continue;
      const resolved = await selectedFile(root, resolve(dirname(absolute), path)).catch(() => undefined);
      if (resolved) addCalls(resolved, calls);
    }
  }
  const read = budgetedReader(signal);
  const texts = new Map(snapshots.map(({ absolute, text }) => [absolute, rows(text)]));
  const emitted = new Set<string>();
  for (const { path, startLine, endLine } of context) {
    try {
      signal?.throwIfAborted();
      const file = await selectedFile(root, path);
      const calls = callsByResource.get(file);
      if (!calls) throw new Error("Only same-file or directly imported resource keywords can be context.");
      const key = `${file}:${startLine}:${endLine}`;
      if (emitted.has(key)) continue;
      let lines = texts.get(file);
      if (!lines) {
        lines = rows((await read(file)).text);
        texts.set(file, lines);
      }
      const start = startLine - 1;
      const heading = keywordHeading(lines[start] ?? "");
      const section = lines.slice(0, start).map(sectionName).findLast((name) => name !== undefined);
      if (startLine > endLine || endLine > lines.length || (section !== "keywords" && section !== "keyword") || !heading || !calls.has(normalizedKeyword(heading)) ||
          sectionName(lines[start] ?? "") || lines.slice(start + 1, endLine).some((line) => sectionName(line) || keywordHeading(line))) {
        throw new Error("Select one referenced keyword definition.");
      }
      sources.push({ file: relative(root, file), startLine, text: lines.slice(start, endLine).join("") });
      emitted.add(key);
    } catch (error) {
      signal?.throwIfAborted();
      unavailable.push({ file: path, reason: error instanceof Error ? error.message : "Could not read keyword context." });
    }
  }
  return { sources, unavailable };
}
