# Benchmark memory index

- [Postgres pool boundary](postgres-pool-boundary.md) — worker processes own small pools instead of sharing a client
- [CI flake quarantine](ci-flake-quarantine.md) — isolate repeated intermittent failures with an expiry
- [Homelab proxy layout](homelab-proxy-layout.md) — one edge proxy fronts private service containers
- [API backoff jitter](api-backoff-jitter.md) — cap exponential retries and randomize their delay
- [Dark token convention](dark-token-convention.md) — theme components use semantic color roles
- [Release tagging scheme](release-tagging-scheme.md) — annotated calendar-version tags identify releases
- [Database migration lock](database-migration-lock.md) — serialize schema changes with an advisory lock
- [Log redaction policy](log-redaction-policy.md) — allowlist log fields and protect stable identifiers
- [Backup retention tiers](backup-retention-tiers.md) — retain daily weekly and monthly recovery points
- [Feature flag lifecycle](feature-flag-lifecycle.md) — flags carry owners expiries and cleanup work
- [CLI output contract](cli-output-contract.md) — reserve stdout for consumable command results
- [Cache key versioning](cache-key-versioning.md) — version cache schemas in normalized keys
- [VPN admin access](vpn-admin-access.md) — keep infrastructure dashboards on the private tunnel
- [Dependency update window](dependency-update-window.md) — batch routine package bumps on Tuesdays
- [Incident note template](incident-note-template.md) — record impact timeline cause recovery and owners
- [Branch naming preference](branch-naming-preference.md) — use short typed lowercase branch names
- [Webhook idempotency ledger](webhook-idempotency-ledger.md) — claim delivery IDs before side effects
- [Image build provenance](image-build-provenance.md) — label artifacts with source and lockfile identity
