#!/usr/bin/env node
// Memory linter — scans the active project's memory store for rot:
//   1. Dangling [[wikilinks]] (target isn't any memory's name: slug)
//   2. Index drift (MEMORY.md links to a missing file; memory file with no
//      index line)
//   3. Likely duplicates (heavy description overlap)
// Read-only. Exit 0 always (it's a report, not a gate). `--json` for machine
// output, `--dir <path>` to point at a specific memory dir.
//
// (Stale repo-path detection is deferred — memory bodies reference paths
//  across many repos, so attribution is unreliable and would false-flag
//  live paths.)
import fs from "node:fs";
import path from "node:path";
import { resolveMemoryDir, loadMemories, loadIndex, tokenize, buildResolutionSet, normalizeSlug } from "./memory-lib.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const dirArg = args.indexOf("--dir");
const dir = dirArg >= 0 ? args[dirArg + 1] : resolveMemoryDir();

const memories = loadMemories(dir);
// Union both index files — a cold-storage index holds reference entries that
// are deliberately NOT in MEMORY.md, so they're indexed, not orphans.
const mainIndex = loadIndex(dir, "MEMORY.md");
const coldIndex = loadIndex(dir, "MEMORY-cold-index.md");
const indexEntries = [...mainIndex.entries, ...coldIndex.entries];
const indexExists = mainIndex.exists;

if (memories.length === 0) {
  const msg = `No memory entries found at ${dir}`;
  console.log(asJson ? JSON.stringify({ dir, error: msg }) : msg);
  process.exit(0);
}

// 1. Dangling links ----------------------------------------------------------
const resolvable = buildResolutionSet(memories);
// The two index files are valid [[link]] targets too.
resolvable.add(normalizeSlug("MEMORY-cold-index"));
resolvable.add(normalizeSlug("MEMORY"));
const exampleLinkTargets = new Set([
  "link",
  "links",
  "memory-name",
  "name",
  "neighbors",
  "wikilink",
  "wikilinks",
]);
function isIgnorableLink(link) {
  const normalized = normalizeSlug(link);
  if (exampleLinkTargets.has(normalized)) return true;
  if (link.includes(",")) return true; // bracketed tuples like [[r,g,b]], not memory links
  return false;
}
const dangling = [];
for (const m of memories) {
  for (const link of m.links) {
    if (/\s/.test(link)) continue; // contains spaces → prose-in-brackets, not a wikilink
    if (isIgnorableLink(link)) continue;
    if (!resolvable.has(normalizeSlug(link))) dangling.push({ file: m.file, link });
  }
}

// 2. Index drift -------------------------------------------------------------
const fileSet = new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".md")));
const indexedTargets = new Set();
const brokenIndex = [];
for (const e of indexEntries) {
  if (/^https?:\/\//i.test(e.target)) continue; // URL entry — not a file
  const target = e.target.split("#")[0].split("/").pop();
  if (!target.endsWith(".md")) continue;
  indexedTargets.add(target);
  if (!fileSet.has(target)) brokenIndex.push({ text: e.text, target });
}
const orphans = memories
  .filter((m) => !indexedTargets.has(m.file))
  .map((m) => m.file);

// 3. Likely duplicates -------------------------------------------------------
const descToks = memories.map((m) => ({ file: m.file, toks: tokenize(m.description) }));
const dupes = [];
for (let i = 0; i < descToks.length; i++) {
  for (let j = i + 1; j < descToks.length; j++) {
    const a = descToks[i].toks;
    const b = descToks[j].toks;
    if (a.size < 3 || b.size < 3) continue;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    const jaccard = union ? inter / union : 0;
    if (inter >= 4 && jaccard >= 0.45) {
      dupes.push({ a: descToks[i].file, b: descToks[j].file, shared: inter, jaccard: Math.round(jaccard * 100) / 100 });
    }
  }
}

// ── Output ──────────────────────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify({ dir, counts: { memories: memories.length, dangling: dangling.length, brokenIndex: brokenIndex.length, orphans: orphans.length, dupes: dupes.length }, dangling, brokenIndex, orphans, dupes }, null, 2));
  process.exit(0);
}

const L = (s = "") => console.log(s);
L(`Memory lint — ${dir}`);
L(`  ${memories.length} entries · index ${indexExists ? "present" : "MISSING"}`);
L("");

L(`Dangling [[links]] (${dangling.length}) — rename/typo, or an intentional forward-ref:`);
if (dangling.length === 0) L("  ✓ none");
else for (const d of dangling) L(`  • ${d.file} → [[${d.link}]]`);
L("");

L(`Index drift:`);
if (brokenIndex.length === 0 && orphans.length === 0) L("  ✓ clean");
if (brokenIndex.length) {
  L(`  MEMORY.md links to ${brokenIndex.length} missing file(s):`);
  for (const b of brokenIndex) L(`    • "${b.text}" → ${b.target}`);
}
if (orphans.length) {
  L(`  ${orphans.length} memory file(s) with NO index line (add one to MEMORY.md):`);
  for (const o of orphans) L(`    • ${o}`);
}
L("");

L(`Likely duplicates (${dupes.length}) — heavy description overlap, consider consolidating:`);
if (dupes.length === 0) L("  ✓ none");
else for (const d of dupes) L(`  • ${d.a}  ⇄  ${d.b}  (${d.shared} shared, jaccard ${d.jaccard})`);

process.exit(0);
