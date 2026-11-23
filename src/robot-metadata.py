import json
import sys
from io import StringIO

import robot
from robot.api.parsing import Comment, Documentation, EmptyLine, Error, TestCase, TestCaseSection, Token, get_model
from robot.variables.search import search_variable


def first_runtime_variable(text):
    remaining = text
    while remaining:
        match = search_variable(remaining, ignore_errors=True)
        if not match:
            break
        if match.identifier in "$@&%*":
            return len(text) - len(remaining) + match.start
        remaining = match.after
    return None


def line_number(source, node):
    return source["startLine"] + max(0, node.lineno - 1)


def test_end(test):
    for node in reversed(test.body):
        if isinstance(node, EmptyLine):
            continue
        if isinstance(node, Comment) and node.tokens[0].type == Token.COMMENT:
            continue
        return node.end_lineno
    return test.header.end_lineno


def inspect_source(source):
    file = source["file"]
    offset = source["startLine"]
    model = get_model(StringIO(source["text"]))
    tests = []
    uncheckable = []

    def report(line, reason, end_line=None):
        item = {"file": file, "line": line, "reason": reason}
        if end_line is not None:
            item["endLine"] = end_line
        if item not in uncheckable:
            uncheckable.append(item)

    if model.errors:
        report(offset, "Robot Framework reported a file-level parse error.")

    for section in model.sections:
        if section.header is not None and section.header.get_token(Token.INVALID_HEADER):
            report(line_number(source, section), "Robot Framework did not recognize a section header.",
                   offset + section.end_lineno - 1)
        if not isinstance(section, TestCaseSection):
            continue
        for test in section.body:
            if not isinstance(test, TestCase):
                continue

            error_nodes = [node for node in test.body if isinstance(node, Error) and node.errors]
            test_errors = bool(test.errors or error_nodes)
            error_line = line_number(source, error_nodes[0]) if error_nodes else line_number(source, test)
            if test_errors:
                report(error_line, "Robot Framework reported an error affecting test metadata.")

            name = test.name
            name_parts = name.split(maxsplit=1)
            variable_start = first_runtime_variable(name)
            documentation_nodes = [node for node in test.body if isinstance(node, Documentation)]
            documentation = documentation_nodes[0] if documentation_nodes else None
            result = {
                "file": file,
                "line": line_number(source, test),
                "endLine": offset + test_end(test) - 1,
                "name": name,
                "nameDynamic": variable_start is not None,
                "idDynamic": bool(name_parts and variable_start is not None and variable_start < len(name_parts[0])),
            }
            if documentation is not None:
                text = documentation.value
                result["documentation"] = {
                    "text": text,
                    "line": line_number(source, documentation),
                    "dynamic": first_runtime_variable(text) is not None,
                }
            if test_errors:
                result["error"] = "Robot Framework reported an error affecting test metadata."
            tests.append(result)

    for section in model.sections:
        for node in getattr(section, "body", []):
            if isinstance(node, Error) and node.errors:
                report(line_number(source, node), "Robot Framework reported a parse error outside a test.")

    return tests, uncheckable


def main():
    if robot.__version__ != "7.4.2":
        sys.exit(1)
    try:
        payload = json.load(sys.stdin)
        sources = payload["sources"]
        if not isinstance(sources, list):
            raise ValueError
        tests = []
        uncheckable = []
        for source in sources:
            try:
                parsed_tests, parsed_uncheckable = inspect_source(source)
                tests.extend(parsed_tests)
                uncheckable.extend(parsed_uncheckable)
            except Exception:
                uncheckable.append({
                    "file": source["file"],
                    "line": source["startLine"],
                    "reason": "Robot Framework could not reliably parse this file's metadata.",
                })
        json.dump({"tests": tests, "uncheckable": uncheckable}, sys.stdout, ensure_ascii=True)
    except Exception:
        sys.exit(1)


if __name__ == "__main__":
    main()
