import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Settings } from "./settings.ts";

export type SnippetExcerpt = {
  id: string;
  workspace: string;
  snippet: string;
  revision: string;
  file: string;
  startLine: number;
  text: string;
};

export type ReferenceSource = {
  id: string;
  projectPath?: string;
  startLine: number;
  text: string;
  pinned?: { workspace: string; snippet: string; revision: string; file: string };
  appliesTo: readonly string[];
};

const MAX_REFERENCES_PER_LIST = 50;
const MAX_REFERENCE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

function within(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function changedFilesFor(category: string, categories: ReadonlyMap<string, string>, exclude?: string): string[] {
  return [...categories]
    .filter(([file, fileCategory]) => fileCategory === category && file !== exclude)
    .map(([file]) => file);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readBounded(path: string, remaining: number, signal?: AbortSignal): Promise<{ text: string; bytes: number }> {
  signal?.throwIfAborted();
  const limit = Math.min(MAX_REFERENCE_BYTES, remaining);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Not a regular file.");
    if (before.size > BigInt(limit)) throw new Error("Reference exceeds the configured read limit.");
    if (await realpath(path) !== path || !sameFile(before, await stat(path, { bigint: true }))) {
      throw new Error("Reference moved while opening it.");
    }
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count !== Number(before.size) || !sameFile(before, await handle.stat({ bigint: true })) || await realpath(path) !== path) {
      throw new Error("Reference changed while reading it.");
    }
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count)), bytes: count };
  } finally {
    await handle.close();
  }
}

export async function loadReferences(options: {
  root: string;
  settings: Settings["references"];
  categories: ReadonlyMap<string, string>;
  snippets?: readonly SnippetExcerpt[];
  allowSnippets: boolean;
  signal?: AbortSignal;
}): Promise<{ sources: ReferenceSource[]; unavailable: { id: string; reason: string }[] }> {
  const root = await realpath(resolve(options.root));
  const sources: ReferenceSource[] = [];
  const unavailable: { id: string; reason: string }[] = [];
  let remaining = MAX_TOTAL_BYTES;

  for (const [index, [id, approved]] of Object.entries(options.settings.local).entries()) {
    options.signal?.throwIfAborted();
    if (index >= MAX_REFERENCES_PER_LIST) {
      unavailable.push({ id, reason: "Local reference limit exceeded." });
      continue;
    }
    let canonical: string;
    try {
      const candidate = resolve(root, approved.path);
      if (!within(root, candidate)) throw new Error("Path is outside the project.");
      canonical = await realpath(candidate);
      if (!within(root, canonical)) throw new Error("Path resolves outside the project.");
      if (![".robot", ".resource"].includes((canonical.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase())) {
        throw new Error("Only .robot and .resource files are approved.");
      }
    } catch (error) {
      unavailable.push({ id, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const projectPath = relative(root, canonical).split(sep).join("/");
    const appliesTo = changedFilesFor(approved.category, options.categories, projectPath);
    if (appliesTo.length === 0) {
      unavailable.push({ id, reason: "No changed file has this reference category." });
      continue;
    }
    try {
      const { text, bytes } = await readBounded(canonical, remaining, options.signal);
      remaining -= bytes;
      sources.push({ id, projectPath, startLine: 1, text, appliesTo });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      unavailable.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const [index, [id, approved]] of Object.entries(options.settings.snippets).entries()) {
    options.signal?.throwIfAborted();
    if (index >= MAX_REFERENCES_PER_LIST) {
      unavailable.push({ id, reason: "Snippet reference limit exceeded." });
      continue;
    }
    if (!options.settings.bitbucket) {
      unavailable.push({ id, reason: "Bitbucket snippet references are disabled in project settings." });
      continue;
    }
    if (!options.allowSnippets) {
      unavailable.push({ id, reason: "Snippet content was not approved for this review." });
      continue;
    }
    const excerpt = options.snippets?.find((candidate) => candidate.id === id);
    if (!excerpt) {
      unavailable.push({ id, reason: "Pinned snippet excerpt is unavailable." });
      continue;
    }
    if (excerpt.workspace !== approved.workspace || excerpt.snippet !== approved.snippet ||
        excerpt.revision !== approved.revision || excerpt.file !== approved.file) {
      unavailable.push({ id, reason: "Returned excerpt does not match the approved pinned identity." });
      continue;
    }
    if (!Number.isSafeInteger(excerpt.startLine) || excerpt.startLine < 1 || excerpt.text.length === 0) {
      unavailable.push({ id, reason: "Pinned snippet excerpt has invalid location or empty content." });
      continue;
    }
    const appliesTo = changedFilesFor(approved.category, options.categories);
    if (appliesTo.length === 0) {
      unavailable.push({ id, reason: "No changed file has this reference category." });
      continue;
    }
    const bytes = Buffer.byteLength(excerpt.text, "utf8");
    if (bytes > MAX_REFERENCE_BYTES || bytes > remaining) {
      unavailable.push({ id, reason: "Snippet excerpt exceeds the configured read limit." });
      continue;
    }
    remaining -= bytes;
    sources.push({
      id,
      ...(approved.projectPath === undefined ? {} : { projectPath: approved.projectPath }),
      startLine: excerpt.startLine,
      text: excerpt.text,
      pinned: { workspace: excerpt.workspace, snippet: excerpt.snippet, revision: excerpt.revision, file: excerpt.file },
      appliesTo,
    });
  }

  return { sources, unavailable };
}
