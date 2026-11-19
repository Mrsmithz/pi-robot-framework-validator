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

**QA test case**:
A record maintained by QA that identifies a test by its ID, name, and objective.

**QA note**:
An advisory observation about whether a Robot test's name and objective follow its QA record. It cites the test and the supporting spreadsheet location.

**Uncheckable QA review**:
A QA review without enough usable spreadsheet evidence to reach a conclusion for a test.

**Global rule settings**:
Rule settings that apply across projects.

**Project rule settings**:
Rule settings specific to one project.

**Effective rule setting**:
The value a check uses after applying global and project rule settings over the default.
