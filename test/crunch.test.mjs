import { test } from "node:test";
import assert from "node:assert/strict";

// Importing runs the env loader, which is harmless: it only fills variables that are
// unset, and only ones on its allowlist.
const { scrubSecrets, providerModels, PROVIDERS } = await import("../tools/crunch.mjs");

test("redacts credential shapes before anything leaves the box", () => {
  const cases = [
    ["OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345", /sk-abcdef/],
    ["token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", /ghp_/],
    ["fine-grained github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz", /github_pat_/],
    // Assembled at runtime, not written as a literal: GitHub's push protection
    // scans fixtures too, and correctly refuses to accept a string shaped like a
    // real Slack token even when it is fake.
    [`slack ${"xox"}b-123456789012-abcdefghijklmnop`, /xoxb-/],
    ["anthropic sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa", /sk-ant-/],
    ["aws AKIAIOSFODNN7EXAMPLE here", /AKIAIOSFODNN7EXAMPLE/],
    [`google AIza${"S".repeat(35)}`, /AIzaS/],
    ["db postgres://admin:hunter2@db.internal:5432/app", /hunter2/],
    ["curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'", /abcdefghijklmnop/],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", /eyJhbGci/],
    ["hook https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXX", /hooks\.slack\.com\/services\/T0/],
    ['{"password": "correct-horse-battery"}', /correct-horse/],
    ["DATABASE_PASSWORD=s3cr3tvalue", /s3cr3tvalue/],
  ];
  for (const [input, leaked] of cases) {
    const { text, redactions } = scrubSecrets(input);
    assert.ok(redactions > 0, `no redaction for: ${input}`);
    assert.doesNotMatch(text, leaked, `secret survived in: ${text}`);
  }
});

test("multi-line private keys are removed whole", () => {
  const input = `here is a key
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxx
yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
-----END RSA PRIVATE KEY-----
and that is all`;
  const { text } = scrubSecrets(input);
  assert.doesNotMatch(text, /MIIEow/);
  assert.match(text, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(text, /and that is all/, "surrounding text is preserved");
});

test("leaves ordinary prose and code alone", () => {
  const clean = [
    "Summarize the deploy log and tell me which service restarted.",
    "const total = items.reduce((a, b) => a + b.price, 0);",
    "The build failed at step 3 with exit code 1.",
    "See https://example.com/docs/getting-started for setup.",
  ];
  for (const c of clean) {
    const { text, redactions } = scrubSecrets(c);
    assert.equal(redactions, 0, `false positive on: ${c}`);
    assert.equal(text, c);
  }
});

test("is a CREDENTIAL redactor, not a PII scrubber — documented and asserted", () => {
  // If this ever starts passing, the help text and README must change with it.
  const { redactions } = scrubSecrets("Contact Dana Reyes at dana@example.com or 555-0142.");
  assert.equal(redactions, 0, "crunch does not claim to redact PII — use --local for that");
});

test("scrubbing is idempotent", () => {
  const once = scrubSecrets("key=sk-abcdefghijklmnopqrstuvwxyz012345").text;
  assert.equal(scrubSecrets(once).text, once);
});

test("provider chain is ordered and every entry can name a model", () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.name),
    ["openrouter", "cerebras", "groq", "zai", "mistral", "cloudflare"],
  );
  for (const p of PROVIDERS) assert.equal(typeof p.model(), "string");
});

test("an unknown provider names the real ones instead of failing blank", async () => {
  await assert.rejects(() => providerModels("nope"), /unknown provider "nope".*openrouter/s);
});
