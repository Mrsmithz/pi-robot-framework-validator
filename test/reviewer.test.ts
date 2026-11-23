import assert from "node:assert/strict";
import test from "node:test";
import { prepareReview, validateReviewResponse } from "../src/reviewer.ts";
import type { ReferenceSource } from "../src/reviewer.ts";
import type { Source } from "../src/targets.ts";

const changes: Source[] = [{ file: "tests/new.robot", startLine: 3, text: "Test case\n    Step\n" }];
const references: ReferenceSource[] = [{
  id: "approved-api",
  projectPath: "examples/api.robot",
  startLine: 8,
  text: "*** Test Cases ***\nExample test\n    Create request\n",
  pinned: { workspace: "team", snippet: "robot-examples", revision: "abc123", file: "examples/api.robot" },
  appliesTo: ["tests/new.robot"],
}];

function response(referenceNotes: unknown, readability: unknown = []): string {
  return JSON.stringify({ readability, references: referenceNotes });
}

test("prepareReview includes applicable references and scoped context", () => {
  const payload = prepareReview({
    model: { contextWindow: 16_000 },
    changes,
    context: [{ file: "resources/keywords.resource", startLine: 12, text: "Create request\n" }],
    guidelines: { "business-readable": "Use terms a business reader understands." },
    references: [...references, { ...references[0]!, id: "unrelated", appliesTo: ["tests/other.robot"] }],
  });
  assert.deepEqual(JSON.parse(payload), {
    changes,
    context: [{ file: "resources/keywords.resource", startLine: 12, text: "Create request\n" }],
    guidelines: { "business-readable": "Use terms a business reader understands." },
    references,
  });
});

test("prepareReview bounds the combined prompt and payload", () => {
  assert.throws(() => prepareReview({ model: { contextWindow: 100 }, changes, context: [], references }), /input is too large/);
});

test("valid reference notes return citations enriched from trusted project metadata", () => {
  const result = validateReviewResponse({
    changes,
    guidelines: { "business-readable": "Use clear business terms." },
    references,
    raw: response({
      status: "reviewed",
      notes: [{
        type: "suggestion",
        source: { file: "tests/new.robot", line: 4 },
        evidence: [{ id: "approved-api", line: 10 }],
        message: "The example keeps request setup in one keyword.",
      }],
    }, [{ file: "tests/new.robot", line: 4, guideline: "business-readable", message: "Clarify the business outcome." }]),
  });
  assert.deepEqual(result, {
    readability: { status: "reviewed", notes: [{ file: "tests/new.robot", line: 4, guideline: "business-readable", message: "Clarify the business outcome." }] },
    references: {
      status: "reviewed",
      notes: [{
        type: "suggestion",
        source: { file: "tests/new.robot", line: 4 },
        evidence: [{ id: "approved-api", line: 10, projectPath: "examples/api.robot" }],
        message: "The example keeps request setup in one keyword.",
      }],
    },
  });
});

test("a convention requires two distinct examples unless it names a known guideline", () => {
  const note = {
    type: "convention",
    source: { file: "tests/new.robot", line: 4 },
    evidence: [{ id: "approved-api", line: 10 }],
    message: "Project suites use a setup keyword.",
  };
  const result = validateReviewResponse({ changes, references, raw: response({ status: "reviewed", notes: [note] }) });
  assert.deepEqual(result.references, {
    status: "uncheckable",
    reason: "Reviewer supplied a reference note with invalid or insufficient citations.",
  });
});

test("layout notes require project paths and every reference must apply to the cited change", () => {
  const raw = response({
    status: "reviewed",
    notes: [{
      type: "suggestion",
      source: { file: "tests/new.robot", line: 4 },
      evidence: [{ id: "approved-api", line: 10 }],
      layout: true,
      message: "Keep API resources next to their suite.",
    }],
  });
  assert.equal(validateReviewResponse({ changes, references, raw }).references?.status, "reviewed");
  const withoutPath = [{ ...references[0]!, projectPath: undefined }];
  assert.equal(validateReviewResponse({ changes, references: withoutPath, raw }).references?.status, "uncheckable");
  const wrongTarget = [{ ...references[0]!, appliesTo: ["tests/other.robot"] }];
  const wrongTargetRaw = response({
    status: "reviewed",
    notes: [{
      type: "suggestion",
      source: { file: "tests/new.robot", line: 4 },
      evidence: [{ id: "approved-api", line: 10 }],
      message: "Compare these examples.",
    }],
  });
  assert.equal(validateReviewResponse({ changes, references: wrongTarget, raw: wrongTargetRaw }).references?.status, "uncheckable");
});

test("invalid or oversized model output yields uncheckable requested sections", () => {
  const malformed = validateReviewResponse({ raw: "not-json", changes, guidelines: { clear: "Be clear." }, references });
  assert.equal(malformed.readability?.status, "uncheckable");
  assert.equal(malformed.references?.status, "uncheckable");
  const oversized = validateReviewResponse({ raw: "x".repeat(65 * 1024), changes, guidelines: { clear: "Be clear." }, references });
  assert.equal(oversized.readability?.status, "uncheckable");
  assert.equal(oversized.references?.status, "uncheckable");
});

test("a malformed reference section does not invalidate valid readability", () => {
  const result = validateReviewResponse({
    changes,
    guidelines: { clear: "Be clear." },
    references,
    raw: response("not a reference assessment", [{ file: "tests/new.robot", line: 4, guideline: "clear", message: "Clarify this step." }]),
  });
  assert.equal(result.readability?.status, "reviewed");
  assert.equal(result.references?.status, "uncheckable");
});
