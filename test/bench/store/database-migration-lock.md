---
name: database-migration-lock
description: Schema migrations acquire a database advisory lock before applying changes
metadata:
  type: project
---

The migration runner takes one fixed advisory lock, waits up to sixty seconds, and exits without changing the schema if the lock remains occupied. The lock is held on a dedicated connection through the whole migration batch.

This avoids two deploy replicas migrating simultaneously. Connection ownership follows [[postgres-pool-boundary]].
