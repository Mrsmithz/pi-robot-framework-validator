# Robot Framework validation

This project checks Robot Framework files against lint rules and reviews them for readability and QA wording in Pi.

## Language

**Rule**:
A named check for a Robot Framework style or convention. Rule settings control whether a rule runs and how it is applied.

**Finding**:
A report of a Robocop rule violation. It identifies the file, line, and rule.

**Review guideline**:
A plain-English convention the agent uses when reviewing a Robot test. It is not a deterministic lint rule.

**Readability note**:
An advisory observation about what a business reader cannot readily understand in a Robot test or where the test does not follow a review guideline. It is a judgment, not a rule violation.

**Reference example**:
An approved Robot Framework suite or resource used to compare a similar change. It is evidence for advisory review, not a lint rule.

**Reference note**:
An advisory observation that links changed Robot code or layout to a comparable reference example and explains why the comparison matters.

**QA test case**:
A record maintained by QA that identifies a test by its ID, name, and objective.

**QA source**:
The project spreadsheet that supplies the QA test cases for a check.

**QA mapping**:
A confirmed description of where the QA source holds the test case ID, name, and objective. A QA mapping describes the layout, not the file or its contents.

**QA finding**:
A confirmed discrepancy between a Robot test and its QA source. It comes from a deterministic check, not a reviewer judgment.

**Uncheckable QA comparison**:
A QA comparison that cannot reach a conclusion for a test or field because the Robot or QA evidence is missing, ambiguous, or unusable.

**Global rule settings**:
Rule settings that apply across projects.

**Project rule settings**:
Rule settings specific to one project.

**Effective rule setting**:
The value a check uses after applying global and project rule settings over the default.
