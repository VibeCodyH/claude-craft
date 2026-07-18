---
name: release-tagging-scheme
description: Release tags use a v-prefixed calendar version and optional patch number
metadata:
  type: reference
---

Tag releases as `vYYYY.MM.DD` and add `.N` for a second release on the same day, for example `v2031.04.09.2`. Tags are annotated and point to the release commit on the stable branch.

Prereleases append `-rc.N` and are never reused.
