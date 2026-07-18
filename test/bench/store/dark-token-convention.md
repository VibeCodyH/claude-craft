---
name: dark-token-convention
description: Dark mode components consume semantic color tokens instead of literal shades
metadata:
  type: feedback
---

Components must use semantic tokens such as `--color-canvas`, `--color-surface`, and `--color-text-muted`. Do not add component-specific dark hex values or `dark:` utility overrides.

**Why:** theme contrast should be corrected centrally.
**How to apply:** introduce a semantic role only when no existing role expresses the intent.
