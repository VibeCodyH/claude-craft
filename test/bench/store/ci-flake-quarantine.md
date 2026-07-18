---
name: ci-flake-quarantine
description: Quarantine intermittently failing CI tests after two unrelated failures
metadata:
  type: feedback
---

Move a test to the quarantine job after it fails on two unrelated commits within seven days. Quarantined tests remain required nightly but do not block pull requests.

**Why:** blind retries conceal regressions while random failures waste review time.
**How to apply:** link a tracking issue and assign an expiry date no more than fourteen days away.
