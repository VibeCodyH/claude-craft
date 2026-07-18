---
name: feature-flag-lifecycle
description: Temporary feature flags require an owner expiry date and removal issue
metadata:
  type: project
---

Every temporary flag records an owner, default state, expiry date, and cleanup issue. A scheduled check fails when an active flag is more than thirty days past expiry.

Permanent operational switches are configuration, not feature flags.
