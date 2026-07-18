---
name: postgres-pool-boundary
description: Each worker process owns a small PostgreSQL pool rather than sharing one connection
metadata:
  type: project
---

The queue workers use a pool of three PostgreSQL connections per process. A connection must never be shared concurrently across workers because transactions and session state can leak between jobs.

For local scripts, a single-client pool is acceptable. See [[database-migration-lock]].
