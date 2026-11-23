import assert from "node:assert/strict";
import { test } from "node:test";
import { readRobotMetadata } from "../src/robot-metadata.ts";

const python = process.env.ROBOT_PARSER_PYTHON;

test("parses test metadata and detects Robot runtime variables without running suites", { skip: !python }, async () => {
  const result = await readRobotMetadata({
    root: process.cwd(),
    python: python ?? "python3",
    sources: [{
      file: "tests/customer.robot",
      startLine: 1,
      text: [
        "*** Settings ***",
        "Library    missing_library_that_must_not_be_imported",
        "*** Variables ***",
        "${SUITE}    substituted",
        "*** Test Cases ***",
        "${SUITE} customer",
        "    [Documentation]    First  cell",
        "    ...    next ${SUITE} \\${LITERAL}",
        "    No Operation",
        "Static \\${LITERAL}",
        "    No Operation",
        "QA-01 ${VARIABLE WITH SPACES}",
        "    No Operation",
        "${VARIABLE WITH SPACES} Is dynamic ID",
        "    No Operation",
        "",
      ].join("\n"),
    }],
  });

  assert.deepEqual(result, {
    tests: [
      {
        file: "tests/customer.robot",
        line: 6,
        endLine: 9,
        name: "${SUITE} customer",
        nameDynamic: true,
        idDynamic: true,
        documentation: { text: "First  cell\nnext ${SUITE} \\${LITERAL}", line: 7, dynamic: true },
      },
      {
        file: "tests/customer.robot",
        line: 10,
        endLine: 11,
        name: "Static \\${LITERAL}",
        nameDynamic: false,
        idDynamic: false,
      },
      {
        file: "tests/customer.robot", line: 12, endLine: 13,
        name: "QA-01 ${VARIABLE WITH SPACES}", nameDynamic: true, idDynamic: false,
      },
      {
        file: "tests/customer.robot", line: 14, endLine: 15,
        name: "${VARIABLE WITH SPACES} Is dynamic ID", nameDynamic: true, idDynamic: true,
      },
    ],
    uncheckable: [],
  });
});

test("keeps valid tests and reports metadata-affecting parser errors per source", { skip: !python }, async () => {
  const result = await readRobotMetadata({
    root: process.cwd(),
    python: python ?? "python3",
    sources: [
      {
        file: "tests/duplicate-doc.robot",
        startLine: 1,
        text: [
          "*** Test Cases ***",
          "Affected test",
          "    [Documentation]    first",
          "    [Documentation]    ambiguous second value",
          "Valid test",
          "    [Documentation]    retained",
          "    No Operation",
          "",
        ].join("\n"),
      },
      { file: "tests/valid.robot", startLine: 1, text: "*** Test Cases ***\nOther valid test\n    No Operation\n" },
    ],
  });

  assert.deepEqual(result.tests, [
    {
      file: "tests/duplicate-doc.robot",
      line: 2,
      endLine: 4,
      name: "Affected test",
      nameDynamic: false,
      idDynamic: false,
      documentation: { text: "first", line: 3, dynamic: false },
      error: "Robot Framework reported an error affecting test metadata.",
    },
    {
      file: "tests/duplicate-doc.robot",
      line: 5,
      endLine: 7,
      name: "Valid test",
      nameDynamic: false,
      idDynamic: false,
      documentation: { text: "retained", line: 6, dynamic: false },
    },
    {
      file: "tests/valid.robot",
      line: 2,
      endLine: 3,
      name: "Other valid test",
      nameDynamic: false,
      idDynamic: false,
    },
  ]);
  assert.deepEqual(result.uncheckable, [{
    file: "tests/duplicate-doc.robot",
    line: 4,
    reason: "Robot Framework reported an error affecting test metadata.",
  }]);
});

test("reports malformed sections and excludes trailing inter-test trivia", { skip: !python }, async () => {
  const result = await readRobotMetadata({
    root: process.cwd(), python: python ?? "python3",
    sources: [{ file: "example.robot", startLine: 1, text: [
      "*** Tets Cases ***", "Not parsed", "    No Operation",
      "*** Test Cases ***", "First", "    No Operation", "# Between tests", "", "Other", "    No Operation",
    ].join("\n") }],
  });
  assert.deepEqual(result.uncheckable, [{ file: "example.robot", line: 1, endLine: 3,
    reason: "Robot Framework did not recognize a section header." }]);
  assert.deepEqual(result.tests.map(({ line, endLine }) => [line, endLine]), [[5, 6], [9, 10]]);
});

test("contains parser and process failures without exposing raw source or process output", async () => {
  const source = { file: "tests/private.robot", startLine: 1, text: "*** Test Cases ***\nSECRET SOURCE" };
  const result = await readRobotMetadata({ root: process.cwd(), python: "/missing/python", sources: [source] });
  assert.deepEqual(result, {
    tests: [],
    uncheckable: [{ file: source.file, line: 1, reason: "Robot metadata parser could not be started." }],
  });
  assert.doesNotMatch(JSON.stringify(result), /SECRET SOURCE/);
});
