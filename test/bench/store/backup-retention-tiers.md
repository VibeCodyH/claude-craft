---
name: backup-retention-tiers
description: Backup retention keeps daily weekly and monthly snapshots on separate tiers
metadata:
  type: reference
---

Keep seven daily snapshots, five weekly snapshots, and twelve monthly snapshots. Daily copies stay on fast local storage; weekly and monthly copies go to offline object storage.

Run a restore drill quarterly and record the recovered timestamp and checksum.
