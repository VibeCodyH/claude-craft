---
name: api-backoff-jitter
description: External API rate limits use capped exponential backoff with full jitter
metadata:
  type: reference
---

For 429 and transient 503 responses, retry after a random delay between zero and `min(30s, 500ms * 2^attempt)`. Honor `Retry-After` when it is longer. Stop after six attempts and surface the final response.

Never retry validation errors or other permanent 4xx responses.
