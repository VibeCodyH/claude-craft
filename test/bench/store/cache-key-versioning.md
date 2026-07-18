---
name: cache-key-versioning
description: Cache keys include an explicit schema version and normalized identity fields
metadata:
  type: reference
---

Format application cache keys as `<domain>:v<N>:<normalized-id>`. Increment the version when the serialized value or interpretation changes; do not scan and delete old keys during deploys.

Lowercase case-insensitive identifiers before key construction.
