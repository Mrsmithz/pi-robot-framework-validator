# Robot Framework test metadata without execution

Evidence for [issue #14](https://github.com/Mrsmithz/pi-robot-framework-validator/issues/14). The probe uses Robot Framework 7.4.2. It distinguishes parsed test metadata, source spelling, and text resolved at runtime. It does not define equality with a QA test case's name or objective.

## Public parsing APIs

| Need | Robot Framework 7.4.2 API |
| --- | --- |
| Group a name and its documentation by test | [`robot.api.parsing.get_model(source)`][get-model] returns an AST. Iterate `File.sections`, then the `body` of each `TestCaseSection`. [`TestCase.name`][test-case] reads the name from its `TestCaseName` header. In `TestCase.body`, a [`Documentation`][documentation] statement represents `[Documentation]`, and its inherited [`value`][doc-value] gives the assembled text. The class can also represent suite or keyword documentation, so its parent matters. |
| Locate the test or documentation | `TestCase.lineno` is the test's starting line. `Documentation.lineno` and `end_lineno` give the statement's start and end based on its first and last retained tokens. For exact columns, use `test.header.get_token(Token.TESTCASE_NAME)` and `doc.get_token(Token.DOCUMENTATION)`. [`Token.lineno`][token-position] starts at 1, and `Token.col_offset` starts at 0. In the pipe fixture, the name and setting share a line. |
| Inspect source syntax rather than assembled text | [`robot.api.parsing.get_tokens(source)`][get-tokens] returns tokens with `type`, `value`, and position. The stream includes `TESTCASE_NAME`, `DOCUMENTATION`, and `ARGUMENT`, plus separators, comments, continuation markers, and line endings by default. `EOS` marks the end of a logical statement. One statement can span lines, and one line can contain multiple statements. On the AST, use `doc.get_tokens(Token.ARGUMENT)` for the documentation cells or `doc.tokens` for all retained tokens. |

Use the [documented `robot.api.parsing` imports][public-api]. The module and public AST classes date to Robot Framework 4.0. Version 3.2 exposed the parsing entry points and `Token` through `robot.api`. The test file entry points accept a UTF-8 file path, a text stream, or source text. Resource files and suite initialization files have separate entry points with different valid sections and settings. Both test file entry points parse syntax, not executions. The [parser source][parser-source] builds and validates the AST. In the probe, the `Library`, `Resource`, and `Variables` declarations become AST nodes without loading the named targets. The [suite runner][runtime-imports], outside this parser path, handles imports.

## What the parser preserves and changes

- **Space-separated data.** Two or more spaces or a tab separate cells. `Split  Name` parses as a test named `Split` with a keyword call named `Name` on the same line. Documentation is a special case: `First  cell` splits into two argument tokens, but `Documentation.value` rebuilds the gap from their column offsets. A tab between `Two` and `cells` becomes a space in the value. The [space-separated format][space-format] documents cell boundaries, and the [documentation spaces guide][doc-spaces] dates preservation of documentation spacing to 6.1.
- **Pipe-separated data.** The [pipe format][pipe-format] permits both formats in one file. Pipe padding belongs to separators, while consecutive spaces inside a cell remain data. `Pipe  ${ITEM}` retains its two spaces. In the documentation value, `First  cell | x \| y` becomes three spaces between `cell` and `x` in place of the pipe and its padding. The `\|` inside the second cell remains spelled with its backslash at this stage.
- **Continuation rows.** The [continuation and newline rules][newlines] insert a newline between documentation rows. A bare `...` between text rows represents a blank line in the assembled value. A trailing escaping backslash suppresses the automatic newline and disappears from `Documentation.value`. A trailing `\n` also suppresses the automatic newline, but the two characters remain until escape processing. The [7.4.2 value implementation][doc-source] uses token offsets for spacing and strips trailing whitespace from the assembled string. Comments, continuation markers, and physical line endings are not part of the value.
- **Escapes and variables.** The probe preserves `\t`, `\${ITEM}`, and `${ITEM}` as source spellings even though the fixture defines `${ITEM}` locally. The [user guide][test-doc] describes variable resolution in the final test name and documentation. The [suite runner][runtime-resolution] resolves both when it creates the test result. Leave `get_model`'s `curdir` unset for source inspection: passing it explicitly substitutes `${CURDIR}` during parsing, as documented by [`get_model`][get-model]. Rendered HTML is different again: the [paragraph rules][paragraphs] can combine lines separated by a single newline.
- **Missing, empty, and invalid data.** No `[Documentation]` yields no statement. An explicit empty `[Documentation]` yields a statement with `value == ''`. Full tokens retain syntax that `data_only=True` discards, including comments, separators, and continuation markers. The probe produced the same values and line spans in both modes for these fixtures. A data-only AST cannot be saved back to source. The [public parsing guide][public-api] describes tokenization errors and AST validation, so a returned AST does not by itself establish valid metadata.

`TestCase.name` identifies the parsed name cell. `Documentation.value` is assembled text, not the source row or a resolved report value. Full tokens expose source spelling and positions, but a claim about exact file bytes needs the original source rather than these two fields. These distinctions limit what a QA note can describe as verbatim. The Robot Framework APIs do not specify how to compare parsed Robot text with a QA record.

The probe covers valid test cases in Robot Framework 7.4.2 using in-memory text with LF line endings. The token round trip and the match between full and data-only metadata are observations for these inputs, not guarantees for other versions, file encodings, or malformed files. Runtime resolution and rendering were checked against source and documentation, not by executing tests.

## Reproduce the probe

Run this from the repository root with `uv` and Python 3.13. The input is synthetic and stays in memory. The script only calls the parsing APIs. It does not run a suite or load any suite imports. Tuples labeled `name`, `doc`, or `args` use `(line, column, token value)` for token positions. Python `repr` shows an actual newline as `\n` and a literal backslash followed by `n` as `\\n`.

```sh
(
	scratch=$(mktemp -d "$PWD/.rf-qa-probe.XXXXXX") || exit
	trap 'rm -rf -- "$scratch"' EXIT
	TMPDIR="$scratch" UV_CACHE_DIR="$scratch/cache" uv run --isolated --no-project --python 3.13 --with robotframework==7.4.2 python - <<'PY'
from io import StringIO
from platform import python_version

import robot
from robot.api.parsing import Documentation, TestCase, TestCaseSection, Token, get_model, get_tokens

source = r'''*** Settings ***
Library    qa_probe_nonexistent_library
Resource    qa_probe_nonexistent.resource
Variables    qa_probe_nonexistent.py
*** Variables ***
${ITEM}    substituted
*** Test Cases ***
Space ${ITEM}
    [Documentation]    First  cell    # comment
    ...    Second ${ITEM} \${ITEM} \t
    ...
    ...    Join\
    ...    next\n
    ...    final ${CURDIR}
    No Operation
| Pipe  ${ITEM} | [Documentation] | First  cell | x \| y |
|               | ...             | Second ${ITEM} |
|               | No Operation |
Missing documentation
    No Operation
Empty documentation
    [Documentation]
    No Operation
'''

def position(token):
	return token.lineno, token.col_offset, token.value

def metadata(model):
	for section in model.sections:
		if isinstance(section, TestCaseSection):
			for test in section.body:
				if isinstance(test, TestCase):
					name_token = test.header.get_token(Token.TESTCASE_NAME)
					docs = [node for node in test.body if isinstance(node, Documentation)]
					yield ('name', test.lineno, test.name, position(name_token))
					for doc in docs:
						setting = doc.get_token(Token.DOCUMENTATION)
						yield ('doc', (doc.lineno, doc.end_lineno), position(setting), doc.value)
						yield ('args', [position(t) for t in doc.get_tokens(Token.ARGUMENT)])

assert robot.__version__ == '7.4.2'
print('Robot Framework', robot.__version__, '| Python', python_version())
full = get_model(StringIO(source))
data = get_model(StringIO(source), data_only=True)
print('settings:', [type(node).__name__ for node in full.sections[0].body])
for row in metadata(full):
	print(row)
print('data-only metadata matches:', list(metadata(full)) == list(metadata(data)))
for model in (full, data):
	first_doc = model.sections[2].body[0].body[0]
	print('first doc token types:', sorted({t.type for t in first_doc.tokens}))

tokens = list(get_tokens(StringIO(source)))
print('fixture text matches token values:', source == ''.join(t.value for t in tokens))
print('line 9:', [(t.type, t.col_offset, t.value) for t in tokens if t.lineno == 9])

split_source = '*** Test Cases ***\nSplit  Name\n\t[Documentation]\tTwo\tcells\n\tNo Operation\n'
split = get_model(StringIO(split_source)).sections[0].body[0]
print('split name, keyword, doc:', (split.name, split.body[0].keyword, split.body[1].value))
PY
)
```

Observed output:

```text
Robot Framework 7.4.2 | Python 3.13.5
settings: ['LibraryImport', 'ResourceImport', 'VariablesImport']
('name', 8, 'Space ${ITEM}', (8, 0, 'Space ${ITEM}'))
('doc', (9, 14), (9, 4, '[Documentation]'), 'First  cell\nSecond ${ITEM} \\${ITEM} \\t\n\nJoinnext\\nfinal ${CURDIR}')
('args', [(9, 23, 'First'), (9, 30, 'cell'), (10, 11, 'Second ${ITEM} \\${ITEM} \\t'), (11, 7, ''), (12, 11, 'Join\\'), (13, 11, 'next\\n'), (14, 11, 'final ${CURDIR}')])
('name', 16, 'Pipe  ${ITEM}', (16, 2, 'Pipe  ${ITEM}'))
('doc', (16, 17), (16, 18, '[Documentation]'), 'First  cell   x \\| y\nSecond ${ITEM}')
('args', [(16, 36, 'First  cell'), (16, 50, 'x \\| y'), (17, 36, 'Second ${ITEM}')])
('name', 19, 'Missing documentation', (19, 0, 'Missing documentation'))
('name', 21, 'Empty documentation', (21, 0, 'Empty documentation'))
('doc', (22, 22), (22, 4, '[Documentation]'), '')
('args', [])
data-only metadata matches: True
first doc token types: ['ARGUMENT', 'COMMENT', 'CONTINUATION', 'DOCUMENTATION', 'EOL', 'SEPARATOR']
first doc token types: ['ARGUMENT', 'DOCUMENTATION']
fixture text matches token values: True
line 9: [('SEPARATOR', 0, '    '), ('DOCUMENTATION', 4, '[Documentation]'), ('SEPARATOR', 19, '    '), ('ARGUMENT', 23, 'First'), ('SEPARATOR', 28, '  '), ('ARGUMENT', 30, 'cell'), ('SEPARATOR', 34, '    '), ('COMMENT', 38, '# comment'), ('EOL', 47, '\n')]
split name, keyword, doc: ('Split', 'Name', 'Two cells')
```

[public-api]: https://robot-framework.readthedocs.io/en/v7.4.2/autodoc/robot.api.html#module-robot.api.parsing
[get-model]: https://robot-framework.readthedocs.io/en/v7.4.2/autodoc/robot.parsing.parser.html#robot.parsing.parser.parser.get_model
[get-tokens]: https://robot-framework.readthedocs.io/en/v7.4.2/autodoc/robot.parsing.lexer.html#robot.parsing.lexer.lexer.get_tokens
[token-position]: https://robot-framework.readthedocs.io/en/v7.4.2/autodoc/robot.parsing.lexer.html#robot.parsing.lexer.tokens.Token.lineno
[test-case]: https://robot-framework.readthedocs.io/en/v7.4.2/autodoc/robot.parsing.model.html#robot.parsing.model.blocks.TestCase
[documentation]: https://robot-framework.readthedocs.io/en/v7.4.2/autodoc/robot.parsing.model.html#robot.parsing.model.statements.Documentation
[doc-value]: https://robot-framework.readthedocs.io/en/v7.4.2/autodoc/robot.parsing.model.html#robot.parsing.model.statements.DocumentationOrMetadata.value
[parser-source]: https://github.com/robotframework/robotframework/blob/v7.4.2/src/robot/parsing/parser/parser.py#L92-L120
[doc-source]: https://github.com/robotframework/robotframework/blob/v7.4.2/src/robot/parsing/model/statements.py#L219-L275
[runtime-imports]: https://github.com/robotframework/robotframework/blob/v7.4.2/src/robot/running/suiterunner.py#L82-L92
[runtime-resolution]: https://github.com/robotframework/robotframework/blob/v7.4.2/src/robot/running/suiterunner.py#L147-L157
[space-format]: https://robotframework.org/robotframework/7.4.2/RobotFrameworkUserGuide.html#space-separated-format
[pipe-format]: https://robotframework.org/robotframework/7.4.2/RobotFrameworkUserGuide.html#pipe-separated-format
[doc-spaces]: https://robotframework.org/robotframework/7.4.2/RobotFrameworkUserGuide.html#spaces
[newlines]: https://robotframework.org/robotframework/7.4.2/RobotFrameworkUserGuide.html#newlines
[test-doc]: https://robotframework.org/robotframework/7.4.2/RobotFrameworkUserGuide.html#test-case-name-and-documentation
[paragraphs]: https://robotframework.org/robotframework/7.4.2/RobotFrameworkUserGuide.html#paragraphs
