---
name: cli-output-contract
description: Command-line tools keep stdout machine-readable and send diagnostics to stderr
metadata:
  type: feedback
---

Successful data goes to stdout. Progress, warnings, and human diagnostics go to stderr. With `--json`, stdout contains exactly one JSON value and no banners or color codes.

**Why:** scripts must be able to pipe output safely.
**How to apply:** use exit code 2 for usage errors and 1 for operational failures.
