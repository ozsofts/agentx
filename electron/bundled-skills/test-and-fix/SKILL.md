---
name: test-and-fix
description: Run the most relevant tests, diagnose failures from evidence, apply focused fixes, and verify the affected behavior.
---

# Test and fix

Use the repository's existing test commands and conventions.

1. Reproduce the failure with the smallest relevant test target.
2. Trace the failure to its behavioral cause before editing.
3. Make a focused fix and add or update regression coverage when useful.
4. Re-run the focused test, then the broader suite appropriate to the change.

Preserve unrelated working-tree changes and report any verification that could not run.
