# Issue tracker: GitHub

Issues and specs live in `Mrsmithz/pi-robot-framework-validator`. Use the `gh` CLI.

## Issue operations

- Publish a ticket or spec: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,assignees,comments`.
- List: `gh issue list --state open`. Add `--label <label>` when filtering by label.
- Comment: `gh issue comment <number> --body-file <file>`.
- Close: post the explanation as a comment, then run `gh issue close <number>`.

Confirm the target with `gh repo view --json nameWithOwner` before creating issues. Pass `--repo Mrsmithz/pi-robot-framework-validator` if `gh` would resolve another target.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

- Create the map as one issue labeled `wayfinder:map`.
- Create each ticket with `gh issue create --parent <map> --label wayfinder:<type>`. The types are `research`, `prototype`, `grilling`, and `task`. Wayfinder issues carry only Wayfinder labels.
- Add native blocking relationships after ticket creation: `gh issue edit <child> --add-blocked-by <blocker>`.
- Find the frontier: list child issues in map order with `gh api --paginate 'repos/{owner}/{repo}/issues/<map>/sub_issues'`. Skip closed and assigned tickets. Count open blockers with `gh api 'repos/{owner}/{repo}/issues/<child>' --jq .issue_dependencies_summary.blocked_by`. The first unassigned open child with zero open blockers is next.
- Claim before starting: `gh issue edit <ticket> --add-assignee @me`.
- Resolve: comment with the decision, close the ticket, and append its title, link, and one-line gist to the map's Decisions so far section.
