# Pi Robot Framework Validator

Review Robot Framework tests in Pi before handing them back. The agent runs your Robocop lint rules, checks test names and objectives against a QA spreadsheet with a reviewer model, and reviews whether someone in the business can follow the tests.

## Install

Use Pi 1.5.2 or later and put your Robocop-compatible CLI on Pi's `PATH`. The CLI must support `robocop check` with an explicit config and the `json_report` report. Install Robocop separately; this package does not install it.

Once this repository contains a published package revision, install it with:

```sh
pi install git:github.com/Mrsmithz/pi-robot-framework-validator
```

To install for one trusted project instead, run the same command with `--local` from that project. Use one installation scope. To try a checkout before installing, run `npm ci` in the checkout, then start Pi from the Robot project root with `pi -e /path/to/pi-robot-framework-validator/src/index.ts`.

## Review tests

Start Pi at the Robot project root. Ask the agent to review specific `.robot` files, or explicitly ask and confirm a whole-project review. The extension reminds the agent before work starts to review any Robot tests it changes before handoff. There is no slash command or check after every edit.

For each review, the agent names the model that would receive QA data and asks which local CSV or XLSX file to use. You can limit the selection to a sheet or an A1 range. For example: `qa/cases.xlsx`, sheet `Regression`, range `A4:F45`. Share only data that you are allowed to send to the receiving provider. The agent can choose relevant rows or submit the whole selected workbook. Pi asks you to confirm the file, scope, and recipient before it reads anything. It does not reuse a selection from an earlier review. If you decline or your Pi mode cannot confirm, Robocop and readability can still run and QA is **Uncheckable**.

The review reports three results separately:

- **Robocop findings** include the Robot file, line, rule ID, and message. A failed or incompatible Robocop run is **Uncheckable**, not clean.
- **QA wording notes** compare the selected Robot tests with QA by test case ID. Keep `<ID> <name>` and `[Documentation]` verbatim. The reviewer cites the Robot line and the relevant spreadsheet cell. Sheet numbers start at 1 within the selected sheets. It does not require fixed column names, audit unautomated QA cases, or guarantee exact whitespace matching. If the workbook is too large or the layout or match is ambiguous, provide a smaller range or clarify the relevant fields. Update the QA record first if the QA wording itself needs to change.
- **Readability notes** cite a Robot line, the issue, and the applicable guideline when there is one. They are advisory. The extension does not run Robot suites or edit tests.

If an XLSX selection contains dates, unsupported number formats, or formulas without cached results, select only the QA columns or export them as text to CSV. The extension does not calculate formulas.

## Configure

Put global settings in `robot-validator.toml` in Pi's configured agent directory (normally `~/.pi/agent`). Put overrides in `<project>/.pi/robot-validator.toml`. Project overrides and Robocop require Pi project trust because Robocop can load custom rules. If Pi did not ask about project trust at startup, use `/trust` to explicitly trust the project before running Robocop. Remove an override to inherit the lower-priority value. Ask the agent to show Robot validator settings to see effective values, their sources, and the receiving model without running a review.

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

[readability.guidelines.named-verification]
text = "Group related assertions in a keyword that names the expected outcome."
```

`robocop.command` is one executable name or an absolute path, not a command line. The default is `robocop`. The baseline config defaults to `robocop.toml` at the project root. The extension does not modify that file. Rule overrides use Robocop's `list rules`, `docs`, and TOML `extends`. Overrides and baselines that inherit settings or configure JSON output require a writable baseline directory for a temporary sibling config. Set `enabled = false` to disable a lint rule or a guideline.

By default, the reviewer uses the current Pi model. Set `readability.model` to an exact `provider/model-id` configured in Pi to use a different reviewer for QA and readability without switching the main model. Each review request receives only its inputs. Readability receives the selected tests, relevant keyword excerpts, and active guidelines. QA receives the selected tests and approved QA cells. Neither receives chat history or tools, and QA results return field and cell references without quoting spreadsheet contents. If the model is unavailable, the review reports that instead of switching models. `readability.enabled = false` disables readability notes only; QA review can still run.

The built-in guidelines are `business-readable`, `given-when-then`, and `named-verification`. If your custom Robocop already checks `Given`, `When`, and `Then`, you can disable the `given-when-then` guideline to avoid duplicate notes. The extension does not implement its own lint rules.

## Verify setup

1. In a trusted Robot project, ask Pi to show the validator settings. Confirm the baseline path, command, and review recipient.
2. Review a file known to be clean, a file with a known Robocop violation, and a run with an invalid Robocop config path. Confirm the results distinguish no findings, findings, and **Uncheckable**. Try a project limit override and confirm that the baseline file stays unchanged.
3. Ask the agent to change a test and confirm that it asks for a QA file before handoff. Use synthetic QA data when testing a hosted model. Confirm the QA and readability notes are separate from Robocop. Decline the spreadsheet on another run and confirm that only QA is **Uncheckable**.
4. If you use a separate reviewer model, confirm the disclosed recipient changes while the main Pi model does not.

For development, run `npm ci`, `npm run check`, and `npm test`. To include the stock Robocop integration test, set `ROBOCOP_9_4_PATH` to the absolute path of a Robocop 9.4.0 executable before running `npm test`.
