// Shared memory-store parser for the memory tools (linter, memcheck,
// pre-flight hook, staleness check). Zero deps, ESM. Parses the native
// Claude Code auto-memory store: a per-project dir of `*.md` files with
// frontmatter (name/description/metadata.type) + a body that may contain
// [[wikilinks]], plus a MEMORY.md index of `[Title](file.md)` lines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the memory dir for a given working directory. Claude Code encodes
 * the project path by replacing `:`, `\`, and `/` with `-`, under
 * ~/.claude/projects/<encoded>/memory. e.g. /home/you/projects ->
 * -home-you-projects.
 */
export function resolveMemoryDir(cwd = process.cwd()) {
  const encoded = cwd.replace(/[:\\/]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded, "memory");
}

/** Files that are NOT memory entries (the index + cold-storage index). */
const NON_ENTRY = new Set(["MEMORY.md", "MEMORY-cold-index.md"]);

/** Minimal frontmatter extractor — not a full YAML parser. Pulls top-level
 *  `name:`/`description:` and the nested `metadata: { type: }`. */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = { name: null, description: null, type: null };
  if (!m) return { fm, body: raw };
  const block = m[1];
  const body = raw.slice(m[0].length);
  let inMetadata = false;
  for (const line of block.split(/\r?\n/)) {
    const top = line.match(/^(\w+):\s*(.*)$/);
    if (top) {
      const key = top[1];
      let val = top[2].trim().replace(/^["']|["']$/g, "");
      if (key === "metadata") {
        inMetadata = true;
        continue;
      }
      inMetadata = false;
      if (key === "name") fm.name = val;
      else if (key === "description") fm.description = val;
      else if (key === "type") fm.type = val; // type at top level (some files)
      continue;
    }
    if (inMetadata) {
      const sub = line.match(/^\s+(\w+):\s*(.*)$/);
      if (sub && sub[1] === "type") fm.type = sub[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body };
}

/** Extract [[wikilink]] targets from a body. */
function extractLinks(body) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1].trim());
  return out;
}

/** Load every memory entry from the dir. Returns [] if the dir is absent.
 *  `opts.exclude` adds store-specific non-entry filenames (e.g. a shared
 *  store's INDEX.md / README.md). */
export function loadMemories(dir, opts = {}) {
  const exclude = new Set([...NON_ENTRY, ...(opts.exclude ?? [])]);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !exclude.has(f));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    out.push({
      file,
      stem: file.replace(/\.md$/, ""),
      name: fm.name || file.replace(/\.md$/, ""),
      description: fm.description || "",
      type: fm.type || "unknown",
      body,
      links: extractLinks(body),
    });
  }
  return out;
}

/** Normalize a slug for comparison: stores mix `_` (filename style) and
 *  `-` (name: style) and case, so collapse both. */
export function normalizeSlug(s) {
  return (s || "").toLowerCase().replace(/_/g, "-").trim();
}

/** Set of every resolvable target — each memory's name: slug AND its filename
 *  stem, normalized. A [[link]] resolves if it's in here. */
export function buildResolutionSet(memories) {
  const set = new Set();
  for (const m of memories) {
    set.add(normalizeSlug(m.name));
    set.add(normalizeSlug(m.stem));
  }
  return set;
}

/** Parse MEMORY.md into index entries. `target` is the link target (a *.md
 *  filename or a URL). Returns { entries, exists } where exists=false means
 *  no MEMORY.md. */
export function loadIndex(dir, filename = "MEMORY.md") {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, filename), "utf8");
  } catch {
    return { entries: [], exists: false };
  }
  const entries = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    entries.push({ text: m[1].trim(), target: m[2].trim() });
  }
  return { entries, exists: true };
}

// ── Scoring (used by memcheck + the pre-flight hook) ────────────────────────

const STOPWORDS = new Set(
  ("the a an and or but to of in on for with at by from as is are was were be been being " +
    "this that these those it its we you i he she they them our your my me do does did " +
    "can could should would will shall may might must not no yes if then else when while " +
    "how what why who which where into out up down over under about can lets let make made " +
    "want need use used using get got give given run ran new now via per also just only").split(/\s+/),
);

/** High-value short tokens (<4 chars) kept despite the length floor — acronyms
 *  that are often the MOST important word in a prompt but would otherwise be
 *  silently dropped (e.g. "the unraid LLM" → LLM deleted). Extend with your
 *  own domain acronyms via CLAUDE_MEM_KEEP_SHORT (space-separated). */
const KEEP_SHORT = new Set(
  ("llm gpu ssh api ip ha pos sms db ci nas vpn dns " +
    (process.env.CLAUDE_MEM_KEEP_SHORT || "")).toLowerCase().split(/\s+/).filter(Boolean),
);

/** Tokenize to lowercased significant words (>=4 chars OR a kept acronym,
 *  non-stopword). */
export function tokenize(text) {
  const toks = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => (t.length >= 4 || KEEP_SHORT.has(t)) && !STOPWORDS.has(t));
  return new Set(toks);
}

/** Preflight gate: fire only on a strong top match, then show the matches
 *  clustered near the top. Shared by the hook and the bench runner so the
 *  measured behavior is the shipped behavior. */
export function gatePreflight(results, { minScore = 7, cluster = 0.6, max = 3 } = {}) {
  const top = results[0];
  if (!top || top.score < minScore) return [];
  return results
    .filter((r) => r.score >= Math.max(minScore, top.score * cluster))
    .slice(0, max);
}

/**
 * Score memories against a query string. name/description hits weigh more
 * than body hits. Returns matches sorted desc, each { mem, score, hits }.
 * `decisionBoost` nudges feedback/project (decision-bearing) memories up.
 */
export function scoreMemories(query, memories, { decisionBoost = 1.25 } = {}) {
  const q = tokenize(query);
  if (q.size === 0) return [];
  const results = [];
  for (const mem of memories) {
    const nameToks = tokenize(mem.name.replace(/[-_]/g, " "));
    const descToks = tokenize(mem.description);
    const bodyToks = tokenize(mem.body);
    let score = 0;
    const hits = [];
    for (const t of q) {
      let s = 0;
      if (nameToks.has(t)) s += 3;
      if (descToks.has(t)) s += 3;
      else if (bodyToks.has(t)) s += 1;
      if (s > 0) {
        score += s;
        hits.push(t);
      }
    }
    if (score === 0) continue;
    if (mem.type === "feedback" || mem.type === "project") score *= decisionBoost;
    results.push({ mem, score: Math.round(score * 100) / 100, hits });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
