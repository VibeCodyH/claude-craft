---
name: log-redaction-policy
description: Structured logs omit credentials and hash stable user identifiers
metadata:
  type: feedback
---

Never log authorization headers, cookies, reset links, or request bodies from authentication routes. Hash account identifiers with the deployment-specific logging salt before emitting them.

**Why:** debug convenience does not justify durable sensitive data.
**How to apply:** allowlist structured fields rather than maintaining a denylist.
