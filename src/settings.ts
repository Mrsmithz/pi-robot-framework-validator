import { readFile } from "node:fs/promises";
import { isAbsolute, posix, resolve, win32 } from "node:path";
import { parse } from "smol-toml";

export type Option =
  | string
  | boolean
  | number
  | readonly (string | number | boolean)[];

export type Settings = {
  robocop: {
    command: string;
    config: string;
    rules: Record<string, Record<string, Option>>;
  };
  readability: {
    enabled: boolean;
    model?: string;
    guidelines: Record<string, { text: string; enabled: boolean }>;
  };
  sources: Record<string, string>;
};

export type SettingsIssue = {
  section: "all" | "robocop" | "readability";
  path: string;
  key?: string;
  message: string;
};

export type SettingsResult = {
  settings: Settings;
  errors: SettingsIssue[];
};

type Scope = "global" | "project";
type Guideline = { text: string; enabled: boolean };

const BUILT_IN_GUIDELINES = {
  "business-readable": {
    text: "Make the test's starting condition, action, and expected outcome understandable to a business reader without opening keyword definitions.",
    enabled: true,
  },
  "given-when-then": {
    text: "Use Given, When, and Then. Allow And for additional steps where it helps. Review this guideline where Robocop does not check the convention.",
    enabled: true,
  },
  "named-verification": {
    text: "Use a named verification keyword instead of writing assertions directly in the test body.",
    enabled: true,
  },
} satisfies Record<string, Guideline>;

const GUIDELINE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RULE_ID = /^[a-z0-9][a-z0-9-]*$/;
const OPTION_KEY = /^[a-z][a-z0-9_]*$/;
const BARE_COMMAND = /^[A-Za-z0-9_.+-]+$/;
const MODEL_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: object, key: string): boolean {
  return Object.hasOwn(record, key);
}

function setRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isOption(value: unknown): value is Option {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return true;
  }
  if (!Array.isArray(value)) return false;
  return value.every(
    (item: unknown) =>
      typeof item === "string" ||
      typeof item === "boolean" ||
      typeof item === "number",
  );
}

function isValidCommand(value: string): boolean {
  if (value.length === 0 || value.trim() !== value || value.includes("\0")) {
    return false;
  }

  return (
    isAbsolute(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    (BARE_COMMAND.test(value) && value !== "." && value !== "..")
  );
}

function makeDefaults(projectRoot: string): Settings {
  const sources: Record<string, string> = {};
  setRecordValue(sources, "robocop.command", "default");
  setRecordValue(sources, "robocop.config", "default");
  setRecordValue(sources, "readability.enabled", "default");

  const guidelines: Record<string, Guideline> = {};
  for (const [id, guideline] of Object.entries(BUILT_IN_GUIDELINES)) {
    setRecordValue(guidelines, id, { ...guideline });
    setRecordValue(sources, `readability.guidelines.${id}.text`, "default");
    setRecordValue(sources, `readability.guidelines.${id}.enabled`, "default");
  }

  return {
    robocop: {
      command: "robocop",
      config: resolve(projectRoot, "robocop.toml"),
      rules: {},
    },
    readability: {
      enabled: true,
      guidelines,
    },
    sources,
  };
}

function addIssue(
  errors: SettingsIssue[],
  section: SettingsIssue["section"],
  path: string,
  key: string | undefined,
  message: string,
): void {
  errors.push(key === undefined ? { section, path, message } : { section, path, key, message });
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readDocument(
  path: string,
  errors: SettingsIssue[],
): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      addIssue(errors, "all", path, undefined, `Could not read settings file: ${String(error)}`);
    }
    return undefined;
  }

  try {
    const document: unknown = parse(content);
    if (!isRecord(document)) {
      addIssue(errors, "all", path, undefined, "Settings document must contain a TOML table.");
      return undefined;
    }
    return document;
  } catch (error: unknown) {
    addIssue(errors, "all", path, undefined, `Invalid TOML: ${String(error)}`);
    return undefined;
  }
}

function applyRobocop(
  value: unknown,
  path: string,
  scope: Scope,
  projectRoot: string,
  settings: Settings,
  errors: SettingsIssue[],
): void {
  if (!isRecord(value)) {
    addIssue(errors, "robocop", path, "robocop", "Expected a table.");
    return;
  }

  for (const [key, setting] of Object.entries(value)) {
    const settingKey = `robocop.${key}`;
    if (key === "command") {
      if (typeof setting !== "string" || !isValidCommand(setting)) {
        addIssue(
          errors,
          "robocop",
          path,
          settingKey,
          "Expected one bare executable name or an absolute executable path, without arguments.",
        );
        continue;
      }
      settings.robocop.command = setting;
      setRecordValue(settings.sources, settingKey, path);
      continue;
    }

    if (key === "config") {
      if (scope !== "project") {
        addIssue(
          errors,
          "robocop",
          path,
          settingKey,
          "robocop.config can only be set in trusted project settings.",
        );
        continue;
      }
      if (
        typeof setting !== "string" ||
        setting.trim().length === 0 ||
        setting.includes("\0")
      ) {
        addIssue(errors, "robocop", path, settingKey, "Expected a non-empty path string.");
        continue;
      }
      settings.robocop.config = resolve(projectRoot, setting);
      setRecordValue(settings.sources, settingKey, path);
      continue;
    }

    addIssue(errors, "robocop", path, settingKey, "Unknown Robocop setting.");
  }
}

function applyRules(
  value: unknown,
  path: string,
  settings: Settings,
  errors: SettingsIssue[],
): void {
  if (!isRecord(value)) {
    addIssue(errors, "robocop", path, "rules", "Expected a table of Robocop rule overrides.");
    return;
  }

  for (const [stableId, options] of Object.entries(value)) {
    const ruleKey = `rules.${stableId}`;
    const match = /^robocop:(.+)$/.exec(stableId);
    const ruleId = match?.[1];
    if (ruleId === undefined || !RULE_ID.test(ruleId)) {
      addIssue(
        errors,
        "robocop",
        path,
        ruleKey,
        'Expected a stable rule ID in the form "robocop:<rule-name>".',
      );
      continue;
    }
    if (!isRecord(options)) {
      addIssue(errors, "robocop", path, ruleKey, "Expected a table of rule options.");
      continue;
    }

    const current = settings.robocop.rules[ruleId] ?? {};
    const updated = { ...current };
    let changed = false;
    for (const [optionKey, optionValue] of Object.entries(options)) {
      const settingKey = `${ruleKey}.${optionKey}`;
      if (!OPTION_KEY.test(optionKey)) {
        addIssue(errors, "robocop", path, settingKey, "Rule option names must use snake_case.");
        continue;
      }
      if (optionKey === "enabled" && typeof optionValue !== "boolean") {
        addIssue(errors, "robocop", path, settingKey, "Expected a boolean for rule enabled.");
        continue;
      }
      if (!isOption(optionValue)) {
        addIssue(
          errors,
          "robocop",
          path,
          settingKey,
          "Expected a string, boolean, number, or flat array of those values.",
        );
        continue;
      }
      setRecordValue(updated, optionKey, optionValue);
      setRecordValue(settings.sources, `robocop.rules.${ruleId}.${optionKey}`, path);
      changed = true;
    }
    if (changed) setRecordValue(settings.robocop.rules, ruleId, updated);
  }
}

function applyReadability(
  value: unknown,
  path: string,
  settings: Settings,
  errors: SettingsIssue[],
): void {
  if (!isRecord(value)) {
    addIssue(errors, "readability", path, "readability", "Expected a table.");
    return;
  }

  for (const [key, setting] of Object.entries(value)) {
    if (key === "enabled") {
      if (typeof setting !== "boolean") {
        addIssue(errors, "readability", path, "readability.enabled", "Expected a boolean.");
        continue;
      }
      settings.readability.enabled = setting;
      setRecordValue(settings.sources, "readability.enabled", path);
      continue;
    }

    if (key === "model") {
      if (typeof setting !== "string" || !MODEL_ID.test(setting)) {
        addIssue(
          errors,
          "readability",
          path,
          "readability.model",
          'Expected an exact model ID in "provider/model-id" form.',
        );
        continue;
      }
      settings.readability.model = setting;
      setRecordValue(settings.sources, "readability.model", path);
      continue;
    }

    if (key === "guidelines") {
      applyGuidelines(setting, path, settings, errors);
      continue;
    }

    addIssue(errors, "readability", path, `readability.${key}`, "Unknown readability setting.");
  }
}

function applyGuidelines(
  value: unknown,
  path: string,
  settings: Settings,
  errors: SettingsIssue[],
): void {
  if (!isRecord(value)) {
    addIssue(
      errors,
      "readability",
      path,
      "readability.guidelines",
      "Expected a table of guideline settings.",
    );
    return;
  }

  for (const [id, fields] of Object.entries(value)) {
    const guidelineKey = `readability.guidelines.${id}`;
    if (!GUIDELINE_ID.test(id)) {
      addIssue(errors, "readability", path, guidelineKey, "Guideline IDs must use kebab-case.");
      continue;
    }
    if (!isRecord(fields)) {
      addIssue(errors, "readability", path, guidelineKey, "Expected a table.");
      continue;
    }

    const existing = hasOwn(settings.readability.guidelines, id)
      ? settings.readability.guidelines[id]
      : undefined;
    let text = existing?.text;
    let enabled = existing?.enabled ?? true;
    let textSource = settings.sources[`readability.guidelines.${id}.text`] ?? "default";
    let enabledSource = settings.sources[`readability.guidelines.${id}.enabled`] ?? "default";

    for (const [field, fieldValue] of Object.entries(fields)) {
      const settingKey = `${guidelineKey}.${field}`;
      if (field === "text") {
        if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
          addIssue(errors, "readability", path, settingKey, "Expected non-empty guideline text.");
          continue;
        }
        text = fieldValue;
        textSource = path;
        continue;
      }

      if (field === "enabled") {
        if (typeof fieldValue !== "boolean") {
          addIssue(errors, "readability", path, settingKey, "Expected a boolean.");
          continue;
        }
        enabled = fieldValue;
        enabledSource = path;
        continue;
      }

      addIssue(errors, "readability", path, settingKey, "Unknown guideline setting.");
    }

    if (text === undefined) {
      addIssue(errors, "readability", path, guidelineKey, "A new guideline must provide text.");
      continue;
    }

    setRecordValue(settings.readability.guidelines, id, { text, enabled });
    setRecordValue(settings.sources, `${guidelineKey}.text`, textSource);
    setRecordValue(settings.sources, `${guidelineKey}.enabled`, enabledSource);
  }
}

function applyDocument(
  document: Record<string, unknown>,
  path: string,
  scope: Scope,
  projectRoot: string,
  settings: Settings,
  errors: SettingsIssue[],
): void {
  for (const [key, value] of Object.entries(document)) {
    if (key === "robocop") {
      applyRobocop(value, path, scope, projectRoot, settings, errors);
      continue;
    }
    if (key === "rules") {
      applyRules(value, path, settings, errors);
      continue;
    }
    if (key === "readability") {
      applyReadability(value, path, settings, errors);
      continue;
    }
    addIssue(errors, "all", path, key, "Unknown settings section.");
  }
}

export async function loadSettings(options: {
  agentDir: string;
  projectRoot: string;
  trusted: boolean;
}): Promise<SettingsResult> {
  const projectRoot = resolve(options.projectRoot);
  const globalPath = resolve(options.agentDir, "robot-validator.toml");
  const projectPath = resolve(projectRoot, ".pi", "robot-validator.toml");
  const settings = makeDefaults(projectRoot);
  const errors: SettingsIssue[] = [];

  const globalDocument = await readDocument(globalPath, errors);
  if (globalDocument !== undefined) {
    applyDocument(globalDocument, globalPath, "global", projectRoot, settings, errors);
  }

  if (options.trusted) {
    const projectDocument = await readDocument(projectPath, errors);
    if (projectDocument !== undefined) {
      applyDocument(projectDocument, projectPath, "project", projectRoot, settings, errors);
    }
  }

  return { settings, errors };
}
