import { open, opendir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export type Target = { kind: "files"; paths: readonly string[] } | { kind: "project" };
export type KeywordContext = { path: string; startLine: number; endLine: number };
export type Source = { file: string; startLine: number; text: string };

const skipped = new Set(["node_modules", "__pycache__", "build", "dist", "results"]);
const maxFiles = 200;
const maxSourceBytes = 256 * 1024;

function within(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function hasExtension(file: string, extensions: readonly string[]): boolean {
  return extensions.includes(extname(file).toLowerCase());
}

async function selectedFile(root: string, path: string, extensions: readonly string[]): Promise<string> {
  if (!hasExtension(path, extensions)) throw new Error(`Unsupported file type: ${path}`);
  const candidate = resolve(root, path);
  if (!within(root, candidate)) throw new Error(`File is outside the project: ${path}`);
  const file = await realpath(candidate);
  if (!within(root, file)) throw new Error(`File is outside the project: ${path}`);
  if (!hasExtension(file, extensions) || !(await stat(file)).isFile()) throw new Error(`Not a supported file: ${path}`);
  return file;
}

export async function resolveTargets(root: string, target: Target, signal?: AbortSignal): Promise<string[]> {
  const files = new Set<string>();
  function add(file: string) {
    files.add(file);
    if (files.size > maxFiles) throw new Error(`More than ${maxFiles} Robot files selected. Ask for a smaller scope.`);
  }

  if (target.kind === "files") {
    for (const path of target.paths) {
      signal?.throwIfAborted();
      add(await selectedFile(root, path, [".robot"]));
    }
  } else {
    const dirs = [root];
    let entries = 0;
    for (const dir of dirs) {
      for await (const entry of await opendir(dir)) {
        signal?.throwIfAborted();
        if (++entries > 50_000) throw new Error("Too many project entries. Ask for a smaller scope.");
        if (entry.name.startsWith(".")) continue;
        const path = resolve(dir, entry.name);
        if (entry.isDirectory() && !skipped.has(entry.name)) dirs.push(path);
        if (entry.isFile() && hasExtension(path, [".robot"])) add(path);
      }
    }
  }
  if (files.size === 0) throw new Error("No Robot files were selected. Ask which files to review.");
  return [...files].sort();
}

function sectionName(line?: string): string | undefined {
  const heading = line?.trim().replace(/^\|\s*|\s*\|$/g, "");
  return heading?.match(/^\*{3}\s*([^*]+?)\s*\*{3}$/)?.[1]?.toLowerCase();
}

function budgetedReader(signal?: AbortSignal) {
  let budget = maxSourceBytes;
  return async function read(file: string): Promise<string> {
    signal?.throwIfAborted();
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(budget + 1);
      let count = 0;
      while (count < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
        if (bytesRead === 0) break;
        count += bytesRead;
      }
      if (count > budget) throw new Error("Robot source is too large for one review. Ask for fewer files or keyword excerpts.");
      budget -= count;
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
    } finally {
      await handle.close();
    }
  };
}

export async function readReviewSources(options: {
  root: string; files: readonly string[]; context: readonly KeywordContext[]; signal?: AbortSignal;
}): Promise<{ tests: Source[]; keywords: Source[]; unreviewedFiles: string[] }> {
  const { root, files, context, signal } = options;
  const tests: Source[] = [];
  const unreviewedFiles: string[] = [];
  const read = budgetedReader(signal);
  for (const file of files) {
    const text = await read(await selectedFile(root, file, [".robot"]));
    const count = tests.length;
    const lines = text.split(/(?<=\n)/);
    let start = -1;
    for (let index = 0; index <= lines.length; index++) {
      const section = sectionName(lines[index]);
      if (section === undefined && index < lines.length) continue;
      if (start >= 0 && lines.slice(start + 1, index).some((row) => row.trim() !== "")) {
        tests.push({ file: relative(root, file), startLine: start + 1, text: lines.slice(start, index).join("") });
      }
      start = section === "test cases" || section === "tasks" ? index : -1;
    }
    if (tests.length === count) unreviewedFiles.push(relative(root, file));
  }
  if (tests.length === 0) throw new Error("No supported Robot test or task sections found in the selected files.");
  return { tests, unreviewedFiles, keywords: await readKeywordContext({ root, tests, context, signal }) };
}

function keywordHeading(line: string): string | undefined {
  const text = line.trimEnd();
  if (!text || /^\s/.test(text) || text.startsWith("#")) return undefined;
  if (text.startsWith("|")) return text.split("|")[1]?.trim() || undefined;
  return text.split(/ {2,}|\t/)[0];
}

function normalizedKeyword(text: string): string {
  return text.trim().replace(/^(given|when|then|and|but)\s+/i, "").replace(/[\s_]/g, "").toLowerCase();
}

export async function readKeywordContext(options: {
  root: string; tests: readonly Source[]; context: readonly KeywordContext[]; signal?: AbortSignal;
}): Promise<Source[]> {
  const { root, tests, context, signal } = options;
  const keywords: Source[] = [];
  const read = budgetedReader(signal);
  const referenced = new Set(tests.flatMap(({ text }) => text.split(/\|| {2,}|\t|\n/).map(normalizedKeyword)));
  const texts = new Map<string, string[]>();
  for (const { path, startLine, endLine } of context) {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new Error(`Invalid keyword context range: ${path}:${startLine}-${endLine}`);
    }
    const file = await selectedFile(root, path, [".robot", ".resource"]);
    let lines = texts.get(file);
    if (!lines) {
      lines = (await read(file)).split(/(?<=\n)/);
      texts.set(file, lines);
    }
    const start = startLine - 1;
    const heading = keywordHeading(lines[start] ?? "");
    const section = lines.slice(0, start).map(sectionName).findLast((name) => name !== undefined);
    const subsequent = lines.slice(start + 1, endLine);
    if (endLine > lines.length || section !== "keywords" || !heading || !referenced.has(normalizedKeyword(heading)) ||
        sectionName(lines[start]) !== undefined || subsequent.some((line) => sectionName(line) !== undefined || keywordHeading(line) !== undefined)) {
      throw new Error(`Select one referenced keyword definition: ${path}:${startLine}-${endLine}`);
    }
    keywords.push({ file: relative(root, file), startLine, text: lines.slice(start, endLine).join("") });
  }
  return keywords;
}
