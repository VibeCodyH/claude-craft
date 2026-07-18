---
name: image-build-provenance
description: Container images record source revision build time and dependency lock digest
metadata:
  type: feedback
---

Every image must expose OCI labels for the source revision, build timestamp, repository path, and dependency lockfile digest. Release manifests also record the immutable image digest.

**Why:** a running artifact should be traceable without guessing from a mutable tag.
**How to apply:** inject labels in the build pipeline, not at runtime.
