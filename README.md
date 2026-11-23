# Pi Robot Framework Validator

Review the Robot Framework changes an agent makes before it hands them back in Pi. Robocop checks configured rules. The extension compares QA wording locally and asks a separate reviewer for advisory readability and project reference notes.

## Install

Use Pi 1.5.2 or later. Install a Robocop-compatible CLI that supports `robocop check` with an explicit config and the `json_report` report. The extension does not install Robocop.

```sh
pi install git:github.com/Mrsmithz/pi-robot-framework-validator
```

Run the same command from a trusted project with `--local` to install it only there. Use one installation scope. To test a checkout, run `npm ci` in the checkout. Then start Pi in the Robot project root with `pi -e /path/to/pi-robot-framework-validator/src/index.ts`.

For the local QA check, install Robot Framework 7.4.2 in the Python environment the extension will use. For example, from the Robot project:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install robotframework==7.4.2
```

In the project settings, set `qa.python` to the absolute path to `.venv/bin/python`. If the default `python3` on Pi's `PATH` already has the tested Robot version, you can leave the setting unset. The extension parses source files without running suites, importing their libraries, or installing Python packages.

## Review changes

Start Pi at the Robot project root. Ask the agent to review the Robot changes from the current task, or name the files and lines you want reviewed. The extension reminds the agent to run the check before handoff, not after each edit. It does not scan the working tree or ask for a workbook when there are no changed tests. A resource-only change can get lint and advisory notes without a QA prompt.

The result separates four checks:

| Check | What to expect |
| --- | --- |
| Robocop | Findings with file, line, and rule ID. Existing Robocop config owns all lint rules. |
| QA wording | Exact results for the parsed test name after the ID and test-level `[Documentation]`. The tool cites Robot and QA locations without returning workbook wording to the agent. |
| Readability | Advisory notes with Robot locations and the applicable guideline when available. |
| Reference comparison | Advisory notes citing both the change and comparable, approved examples. No applicable example is **Skipped**, not a match. |

**Uncheckable** means a required check could not finish or a field could not be compared. **Not applicable** means the check had no eligible target. Independent checks continue. Fix any missing input and ask the agent to rerun affected checks before handoff. The extension does not block handoff or edit tests or QA records.

## Set up QA wording checks

1. Set `qa.folder` to a directory inside the trusted project. Put a CSV or XLSX with QA records in that directory. If there is more than one eligible file, choose the source in Pi's picker. Pi does not remember that choice.
2. Ask the agent to set up a QA mapping. Give it the XLSX sheet if applicable, the header row number, and the column letters for the test case ID, name, and objective. For example, `Regression`, row `3`, ID `A`, name `C`, and objective `F`.
3. Review the layout in Pi's confirmation dialog. Confirm to save the mapping as `default`, or ask for a different name. Ask for that name when you review a layout other than the default.

Pi saves the layout in `.pi/robot-validator-qa-mappings.json`, not the workbook path or QA rows. When the sheet or mapped headers change, confirm the new layout. For a file without headers, specify the columns and, for XLSX, the sheet for one review without saving. If you ask for an AI mapping suggestion, Pi previews the selected header row and shows the exact model recipient before sending it. Approve only if the row contains column headings, not QA records. An ambiguous suggestion needs a manual mapping. The comparison never sends QA rows to a model.

Use the first word of a Robot test name as the QA ID. IDs are exact text. `00123` and `123` are different. Use the exact QA name and objective in the test name and `[Documentation]`. Only line endings are normalized after parsing. Duplicate IDs, blank QA fields, unavailable workbooks, and unresolved Robot variables can leave a comparison **Uncheckable**. If the XLSX reader cannot interpret a number format or a formula has no cached value, export the needed columns as text to CSV and confirm that layout. The extension does not calculate formulas.

## Configure

Put global settings in `robot-validator.toml` in Pi's agent directory, normally `~/.pi/agent`. Put project settings in `<project>/.pi/robot-validator.toml`. Project settings and all four review checks require Pi project trust. If Pi did not ask, use `/trust` before running checks. Ask the agent to show effective settings, their sources, and the reviewer model without running a review.

Example global settings:

```toml
[robocop]
command = "custom-robocop"

[rules."robocop:line-too-long"]
enabled = true
line_length = 100

[readability]
enabled = true
# model = "provider/model-id"

[readability.guidelines.business-terms]
text = "Use the terms the business team uses for customer and account fields."
```

Example project settings:

```toml
[robocop]
config = "config/robocop.toml"

[rules."robocop:line-too-long"]
line_length = 120

[qa]
folder = "qa"
# python = "/absolute/path/to/project/.venv/bin/python"

[readability.guidelines.named-verification]
text = "Group assertions in a keyword that names the expected outcome."

[references.local.customer-api]
path = "tests/api/customer.robot"
category = "api"
```

`robocop.command` and `qa.python` are executable names on `PATH` or absolute paths, not command lines. The Robocop baseline defaults to `robocop.toml` at the project root. Rule overrides use Robocop's `list rules`, `docs`, and TOML `extends`. Some overrides or inherited settings require a writable baseline directory for a temporary sibling config. The extension does not change the baseline.

By default, the advisory reviewer uses Pi's current model. Set `readability.model` to an exact `provider/model-id` to use a different reviewer without switching the main model. The reviewer receives scoped source, relevant keyword excerpts, guidelines, and applicable approved examples. It receives no chat history or tool definitions and never receives QA rows. There is no automatic model fallback. Disable individual rules or guidelines with `enabled = false`. `readability.enabled = false` disables guideline notes without disabling reference comparison.

The built-in guidelines are `business-readable`, `given-when-then`, and `named-verification`. If Robocop already checks `Given`, `When`, and `Then`, disable the advisory `given-when-then` guideline to avoid duplicate notes.

### Approve reference examples

List each approved local example in the trusted project settings. Assign a category such as `api` or `ui`. The agent compares only files of a comparable category, using real project-relative paths for layout advice. One example can support a suggestion. It cannot establish a project-wide convention on its own.

To opt in to Bitbucket Cloud snippets, configure a pinned example:

```toml
[references]
bitbucket = true

[references.snippets.shared-api]
workspace = "example-workspace"
snippet = "example-snippet"
revision = "0123456789abcdef0123456789abcdef01234567"
file = "example.robot"
category = "api"
projectPath = "tests/api/example.robot"
```

Install and configure your existing `mcp-bitbucket` workflow separately. Approve the exact receiving models in Pi before the agent fetches private code. The agent uses only the configured file at the full Git revision and forwards relevant excerpts with original line numbers. Omit `projectPath` if the original path is unknown. Such an example cannot support layout advice. If MCP cannot establish the pinned revision, Pi skips the reference rather than fetching the latest copy. The extension checks the excerpt's declared identity against its approved list. The main agent must verify provenance through MCP before handing it off. The extension does not control that MCP connection or manage credentials.

## Verify setup

1. In a trusted project, ask Pi to show the validator settings. Check the Robocop baseline, QA folder, Python executable, and model recipient.
2. Review one known mismatch using a synthetic QA workbook. Confirm the field and both source locations appear, with no workbook wording in the result.
3. Change a mapped header and rerun. Confirm QA is **Uncheckable** while Robocop and advisory reviews continue.
4. Review a changed resource with a comparable reference. Confirm reference notes are advisory and QA is **Not applicable**.

For development, run `npm ci`, `npm run check`, and `npm test`. Set `ROBOT_PARSER_PYTHON` to the absolute path to Python with Robot Framework 7.4.2 to include the live parser tests. Set `ROBOCOP_9_4_PATH` to the absolute path to Robocop 9.4.0 to include the stock lint integration tests.
