---
name: feedback-dark-mode
description: Dark mode cards should match the canvas background color exactly
metadata:
  type: feedback
---

Cards use the canvas token, not a separate surface color.

**Why:** mixed surfaces read as visual noise in dark mode.
**How to apply:** reuse the canvas variable; see [[project-deploy-pipeline]] and [[missing-memory]].
