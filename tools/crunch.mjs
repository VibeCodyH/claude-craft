#!/usr/bin/env node
// crunch — bulk lane: strongest FREE cloud model first, your own box as the floor.
//
// The problem it solves: a coding agent's context is expensive, and a lot of the work
// people push through it is not reasoning at all — summarize this transcript, classify
// these 400 rows, extract fields from this dump. That work wants a cheap model, and
// several vendors give away a genuinely good one. This walks them in order and falls
// through to a local OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM)
// when every cloud tier is missing, capped, or down.
//
// Chain: OpenRouter -> Cerebras -> Groq -> Z.ai -> Mistral -> Cloudflare -> local
// floor. Reorder PROVIDERS to taste.
//
// ── The secret guard ─────────────────────────────────────────────────────────────
// Input is run through a local redactor BEFORE any cloud POST. It targets CREDENTIAL
// SHAPES (api keys, tokens, private keys, connection strings) — it is NOT a PII
// scrubber and will not catch names, emails, addresses, or account numbers. For real
// PII, use --local, which never touches the network beyond your own box.
//
// Every attempt logs to stderr (served / skipped / HTTP status) so a chain that is
// silently landing on the local floor is visible rather than mistaken for working.
//
// Zero dependencies. Node 18+ (needs global fetch).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ── env loader ───────────────────────────────────────────────────────────────────
// Keys live in a dedicated file, deliberately separate from any project .env that
// might hold production credentials — this module never reads those into memory.
// The allowlist is defense in depth. A real environment variable always wins.
const WANT = new Set([
  "OPENROUTER_API_KEY", "CEREBRAS_API_KEY", "GROQ_API_KEY", "ZAI_API_KEY",
  "MISTRAL_API_KEY", "VIBE_API_KEY",
  "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID",
  "CRUNCH_OPENROUTER_MODEL", "CRUNCH_CEREBRAS_MODEL",
  "CRUNCH_GROQ_MODEL", "CRUNCH_ZAI_MODEL", "CRUNCH_MISTRAL_MODEL",
  "CRUNCH_CLOUDFLARE_MODEL", "CRUNCH_LOCAL_BASE", "CRUNCH_LOCAL_MODEL",
]);
const ENV_FILES = [
  process.env.CRUNCH_ENV_FILE,
  path.join(os.homedir(), ".config", "claude-craft", "crunch.env"),
].filter(Boolean);
(function loadEnv() {
  for (const file of ENV_FILES) {
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const [, k, v] = m;
      if (WANT.has(k) && process.env[k] === undefined) process.env[k] = v.replace(/^["']|["']$/g, "");
    }
  }
})();

// ── secret redactor ──────────────────────────────────────────────────────────────
// Credential shapes only. Ordered longest/most-specific first so a broad rule cannot
// eat the tail of a token a narrow rule would have matched whole.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b(?:https?:\/\/)?[a-z0-9+.-]+:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi, "[REDACTED_CONNECTION_STRING]"],
  [/\bhooks\.slack\.com\/services\/[A-Za-z0-9/_+-]+/g, "[REDACTED_WEBHOOK]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_TOKEN]"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED_KEY]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_KEY]"],
  // No trailing \b: a key butted up against other word characters must still be
  // caught. Google keys are a fixed 39 chars, so a bounded count is enough.
  [/\bAIza[0-9A-Za-z_-]{35}/g, "[REDACTED_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "[REDACTED_AUTH_HEADER]"],
  // KEY=value / "key": "value" assignments where the NAME says it is a credential.
  // The optional quote BEFORE the separator is what makes this work on JSON, where
  // the key's closing quote sits between the name and the colon.
  [/\b([A-Za-z0-9_.-]*(?:SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PRIVATE[_-]?KEY)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    (_m, name, sep) => `${name}${sep}[REDACTED]`],
];

export function scrubSecrets(text) {
  let out = String(text ?? "");
  let redactions = 0;
  for (const [re, rep] of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      redactions++;
      return typeof rep === "function" ? rep(...args) : rep;
    });
  }
  return { text: out, redactions };
}

// A caller with a better redactor points CRUNCH_SCRUB_MODULE at an ESM file exporting
// `scrub(text) -> { text, redactions }`. If it cannot be loaded or throws, we fail
// CLOSED — floor to local rather than send text the intended guard never inspected.
let _scrubFn;
async function getScrub() {
  if (_scrubFn) return _scrubFn;
  const mod = process.env.CRUNCH_SCRUB_MODULE;
  if (!mod) return (_scrubFn = scrubSecrets);
  const url = path.isAbsolute(mod) ? `file://${mod}` : mod;
  const loaded = await import(url);
  const fn = loaded.scrub || loaded.default;
  if (typeof fn !== "function") throw new Error(`CRUNCH_SCRUB_MODULE ${mod} exports no scrub()`);
  return (_scrubFn = fn);
}

// ── provider chain ───────────────────────────────────────────────────────────────
// Ordered strongest-free-first. A provider is only tried when the ones before it are
// absent, failed, or rate-limited. Rule of thumb: smart-but-tightly-capped first (they
// cascade on 429), fast high-quota workhorses next, small quotas last, box floor after.
// All of these expose an OpenAI-compatible /chat/completions with a Bearer token.
//
// Model ids drift. `crunch --models <provider>` lists what a provider actually serves
// right now; override any of them with the matching CRUNCH_*_MODEL variable.
// GitHub Models used to sit second here, and it was the nicest entry in the chain:
// it reused your `gh auth login` token, so it needed no key at all. It is being
// retired — as of 2026-08-07 the inference endpoint answers 410
// "github_models_retirement_brownout" — so it is out rather than costing every call
// a dead round trip. Re-add it as an entry with
// `token: () => execFileSync("gh", ["auth", "token"], ...)` if it comes back.
const PROVIDERS = [
  {
    name: "openrouter",
    base: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    // Free slugs rotate constantly as vendors start and end promos, and a slug that
    // stops being free returns 404 (which cascades) rather than an error you would
    // notice. `crunch --models openrouter | grep ':free'` lists the live ones.
    // Verified free 2026-08-07. Drop the `:free` suffix to spend credits instead.
    model: () => process.env.CRUNCH_OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
  },
  {
    name: "cerebras",
    base: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY",
    // The workhorse of the chain: large model, very fast, generous daily token quota.
    model: () => process.env.CRUNCH_CEREBRAS_MODEL || "gpt-oss-120b",
  },
  {
    name: "groq",
    base: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    // gpt-oss supports json_schema response_format here; some llama builds 400 on it.
    model: () => process.env.CRUNCH_GROQ_MODEL || "openai/gpt-oss-120b",
  },
  {
    name: "zai",
    base: "https://api.z.ai/api/paas/v4",
    keyEnv: "ZAI_API_KEY",
    model: () => process.env.CRUNCH_ZAI_MODEL || "glm-4.7-flash",
  },
  {
    name: "mistral",
    base: "https://api.mistral.ai/v1",
    // VIBE_API_KEY is where the `vibe` CLI keeps its Mistral key — honored so the
    // two do not need separate copies of the same credential.
    token: () => process.env.MISTRAL_API_KEY || process.env.VIBE_API_KEY,
    skipHint: "MISTRAL_API_KEY not set",
    model: () => process.env.CRUNCH_MISTRAL_MODEL || "mistral-small-latest",
  },
  {
    name: "cloudflare",
    // Needs BOTH a token and an account id; smallest free quota, so it sits last.
    base: () =>
      process.env.CLOUDFLARE_ACCOUNT_ID
        ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`
        : null,
    keyEnv: "CLOUDFLARE_API_KEY",
    model: () => process.env.CRUNCH_CLOUDFLARE_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  },
];

// Providers that already returned 429 THIS run — skipped for the rest of it rather
// than paying a rate-limit round trip on every remaining call of a bulk job.
const exhausted = new Set();

const TIMEOUT_MS = Number(process.env.CRUNCH_TIMEOUT_MS) || 60000;
const LOCAL_BASE = () => (process.env.CRUNCH_LOCAL_BASE || "http://localhost:11434/v1").replace(/\/$/, "");

function log(quiet, msg) {
  if (!quiet) process.stderr.write(`[crunch] ${msg}\n`);
}

function resolveProvider(p) {
  if (exhausted.has(p.name)) return { skip: `${p.name}: skip — rate-limited earlier this run` };
  const key = p.token ? p.token() : process.env[p.keyEnv];
  if (!key) return { skip: `${p.name}: skip — ${p.skipHint || `${p.keyEnv} not set`}` };
  const base = typeof p.base === "function" ? p.base() : p.base;
  if (!base) return { skip: `${p.name}: skip — CLOUDFLARE_ACCOUNT_ID not set (token present, account id missing)` };
  return { key, base: base.replace(/\/$/, ""), model: p.model() };
}

function buildBody(model, prompt, { system, json, schema, temperature, maxTokens }) {
  const messages = [];
  let sys = system;
  if (json && !schema) sys = `${sys ? sys + " " : ""}Output ONLY valid JSON — no markdown, no code fences, no prose.`;
  if (sys) messages.push({ role: "system", content: sys });
  if (Array.isArray(prompt)) messages.push(...prompt);
  else messages.push({ role: "user", content: String(prompt) });
  const body = { model, messages, temperature };
  if (maxTokens) body.max_tokens = maxTokens;
  if (schema) body.response_format = { type: "json_schema", json_schema: { name: "out", schema, strict: true } };
  return body;
}

function parseOut(text, { json, schema }) {
  if (!json && !schema) return text;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned);
}

async function postChat(base, key, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!res.ok) return { status: res.status, error: (await res.text().catch(() => "")).slice(0, 160) };
    return { text: (await res.json()).choices?.[0]?.message?.content ?? "" };
  } finally {
    // Held until the body is fully read, so a slow response body cannot hang the call.
    clearTimeout(timer);
  }
}

// The floor. Model id is whatever you set, else the first one the server reports —
// so a fresh Ollama with one model pulled works with no configuration at all.
async function localChat(prompt, opts = {}) {
  const base = LOCAL_BASE();
  let model = opts.model || process.env.CRUNCH_LOCAL_MODEL;
  if (!model) {
    const res = await fetch(`${base}/models`).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => null) : null;
    model = (Array.isArray(data) ? data : data?.data || [])[0]?.id;
    if (!model) {
      throw new Error(
        `no local model available at ${base} — start Ollama/LM Studio, or set ` +
        `CRUNCH_LOCAL_MODEL / CRUNCH_LOCAL_BASE (every cloud provider was unavailable too)`,
      );
    }
  }
  const body = buildBody(model, prompt, { ...opts, temperature: opts.temperature ?? 0.2 });
  const r = await postChat(base, process.env.CRUNCH_LOCAL_KEY || "", body);
  if (r.error !== undefined) throw new Error(`local floor HTTP ${r.status}: ${r.error}`);
  return parseOut(r.text, opts);
}

/**
 * crunch(prompt, opts) — cloud-first bulk lane with a local floor.
 *
 * opts: { system, json, schema, temperature=0.2, model, maxTokens,
 *         preScrubbed=false, localOnly=false, quiet=false }
 *   - model      overrides the LOCAL floor model only; cloud models come from PROVIDERS.
 *   - preScrubbed  skip redaction — the caller guarantees the input is safe.
 *   - localOnly    skip the cloud chain entirely, and skip redaction with it: --local
 *                  exists to process sensitive data locally, and scrubbing would gut
 *                  the very data you kept local to work on.
 *
 * Returns assistant text, or a parsed object when {json} or {schema} is set.
 */
export async function crunch(prompt, opts = {}) {
  const { preScrubbed = false, localOnly = false, quiet = false, temperature = 0.2 } = opts;

  if (localOnly) {
    log(quiet, "localOnly → box floor, unscrubbed (nothing leaves this machine)");
    return localChat(prompt, opts);
  }

  let send = prompt;
  let callOpts = opts;
  if (!preScrubbed) {
    let scrub;
    try { scrub = await getScrub(); }
    catch (e) {
      // The configured guard is broken. Fail closed.
      log(quiet, `scrub module failed to load (${e.message}) → box floor, not cloud`);
      return localChat(prompt, opts);
    }
    try {
      let redactions = 0;
      const one = (t) => { const s = scrub(String(t ?? "")); redactions += s.redactions || 0; return s.text; };
      send = Array.isArray(prompt)
        // Normalized to {role, content} so extra message fields (tool_calls, name,
        // metadata) cannot serialize to the cloud without passing the redactor.
        ? prompt.map((m) => ({ role: m?.role ?? "user", content: one(m?.content) }))
        : one(prompt);
      callOpts = { ...opts, system: opts.system == null ? opts.system : one(opts.system) };
      if (redactions) log(quiet, `redacted ${redactions} credential match(es) before cloud`);
    } catch (e) {
      log(quiet, `scrub threw (${e.message}) → box floor, not cloud`);
      return localChat(prompt, opts);
    }
  }

  for (const p of PROVIDERS) {
    let r;
    try { r = resolveProvider(p); }
    catch (e) { log(quiet, `${p.name}: resolve error (${e.message}) → next`); continue; }
    if (r.skip) { log(quiet, r.skip); continue; }
    try {
      const out = await postChat(r.base, r.key, buildBody(r.model, send, { ...callOpts, temperature }));
      if (out.error !== undefined) {
        if (out.status === 429) exhausted.add(p.name);
        log(quiet, `${p.name}: HTTP ${out.status} → next (${out.error})`);
        continue;
      }
      // A 200 with empty content (some reasoning models put everything in a separate
      // field) is a miss, not an answer — cascade rather than return "".
      if (!out.text.trim()) { log(quiet, `${p.name}: HTTP 200 but empty content → next`); continue; }
      log(quiet, `served by ${p.name} (${r.model})`);
      return parseOut(out.text, callOpts);
    } catch (e) {
      log(quiet, `${p.name}: ${e.name === "AbortError" ? "timeout" : e.message} → next`);
    }
  }

  log(quiet, "all cloud providers unavailable → box floor");
  return localChat(send, callOpts);
}

// List what a provider actually serves — for fixing a model id that has drifted.
export async function providerModels(name) {
  const p = PROVIDERS.find((x) => x.name === name);
  if (!p) throw new Error(`unknown provider "${name}" (have: ${PROVIDERS.map((x) => x.name).join(", ")})`);
  const r = resolveProvider(p);
  if (r.skip) throw new Error(r.skip);
  const res = await fetch(`${r.base}/models`, { headers: { Authorization: `Bearer ${r.key}` } });
  if (!res.ok) throw new Error(`${name}: models HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : data.data || []).map((m) => m.id || m.name).filter(Boolean);
}

export { PROVIDERS };

// ── CLI ──────────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") flags.json = true;
    else if (a === "--local") flags.localOnly = true;
    else if (a === "--pre-scrubbed" || a === "--raw-ok") flags.preScrubbed = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a === "--task") flags.task = args[++i];
    else if (a === "--system") flags.system = args[++i];
    else if (a === "--model") flags.model = args[++i];
    else if (a === "--models") flags.models = args[++i] ?? "cerebras";
    else if (a === "-h" || a === "--help") flags.help = true;
    else positional.push(a);
  }

  const TASKS = {
    summarize: "Summarize the following clearly and concisely. Lead with the key point.",
    classify: "Classify the following. Reply with a short label and a one-line reason.",
    extract: "Extract the key structured facts from the following as compact JSON.",
    tldr: "Give a one-sentence TL;DR of the following.",
  };

  const readStdin = () => {
    try { return process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8").trim(); }
    catch { return ""; }
  };

  const run = async () => {
    if (flags.help) {
      console.log(`crunch — bulk lane: strongest FREE cloud model first, your box as the floor.

  crunch "prompt"                        one-off (cloud-first, redacted)
  echo "long text" | crunch --task summarize
  crunch --task classify --json "<text>"
  crunch --local "prompt"                your box only — nothing leaves the machine
  crunch --pre-scrubbed "prompt"         skip redaction (caller vouches for the input)
  crunch --models <provider>             list the model ids a provider really serves

Flags: --task <${Object.keys(TASKS).join("|")}> --system "<s>" --json
       --model <local-floor-id> --local --pre-scrubbed --quiet
Chain: ${PROVIDERS.map((p) => p.name).join(" → ")} → local (${LOCAL_BASE()})
Keys: ~/.config/claude-craft/crunch.env (GitHub reuses your \`gh auth login\`).
A provider that 429s is skipped for the rest of the run. Input is redacted for
CREDENTIAL shapes unless --pre-scrubbed; that is not a PII scrubber — use --local.`);
      return;
    }
    if (flags.models) {
      console.log((await providerModels(flags.models)).join("\n") || "(none)");
      return;
    }
    const stdin = readStdin();
    const promptArg = positional.join(" ");
    let system = flags.system;
    if (flags.task) {
      const preset = TASKS[flags.task] || `Task: ${flags.task}.`;
      system = system ? `${system} ${preset}` : preset;
    }
    const userText = flags.task ? stdin || promptArg : [promptArg, stdin].filter(Boolean).join("\n\n");
    if (!userText) {
      console.error("No input. Pass a prompt and/or pipe text in. See --help.");
      process.exit(1);
    }
    const out = await crunch(userText, {
      system,
      json: !!flags.json,
      model: flags.model,
      localOnly: !!flags.localOnly,
      preScrubbed: !!flags.preScrubbed,
      quiet: !!flags.quiet,
    });
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  };

  run().catch((e) => { console.error("ERROR: " + e.message); process.exit(1); });
}
