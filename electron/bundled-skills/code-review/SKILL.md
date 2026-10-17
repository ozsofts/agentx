---
name: code-review
description: Review current code changes for defects, regressions, security risks, weak assumptions, and missing tests.
---

# Code review

Prioritize actionable findings over summary.

1. Read repository guidance and inspect the exact diff in scope.
2. Trace changed behavior through its callers and downstream consumers.
3. Validate error paths, boundary conditions, persistence, and permission checks.
4. Report findings by severity with precise file and line references.

If no issue is found, state that clearly and identify remaining test gaps or residual risk.
