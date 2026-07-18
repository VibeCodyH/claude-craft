---
name: webhook-idempotency-ledger
description: Webhook consumers claim event IDs in a durable idempotency ledger
metadata:
  type: project
---

Before side effects, a consumer inserts the provider event ID into a ledger with a unique constraint. A duplicate delivery returns success without repeating work. Failed processing records the error and may be reclaimed after the lease expires.

Keep ledger rows for ninety days.
