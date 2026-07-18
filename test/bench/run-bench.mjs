#!/usr/bin/env node
// Signal/noise eval for the recall tools. Runs the labeled query set in
// queries.json against the synthetic store in store/ and reports, per tier:
//   recall     — on-topic queries where at least one expected memory surfaced
//   false-fire — off-topic queries where the tier surfaced anything at all
// Tiers measured exactly as shipped:
//   preflight  — gatePreflight() over scoreMemories() (the UserPromptSubmit hook)
//   memcheck   — score >= 3, top 8 (the agent-invoked self-check)
// `--verbose` lists every miss and false fire.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMemories, scoreMemories, gatePreflight, normalizeSlug } from "../../tools/memory-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes("--verbose");

const memories = loadMemories(join(here, "store"));
const queries = JSON.parse(readFileSync(join(here, "queries.json"), "utf8"));
if (!memories.length || !queries.length) {
  console.error("bench: missing store/ or queries.json");
  process.exit(1);
}

// Guard the dataset itself: every expect slug must exist in the store.
const known = new Set(memories.map((m) => normalizeSlug(m.name)));
for (const q of queries) {
  for (const slug of q.expect) {
    if (!known.has(normalizeSlug(slug))) {
      console.error(`bench: queries.json expects unknown memory "${slug}"`);
      process.exit(1);
    }
  }
}

const TIERS = {
  preflight: (results) => gatePreflight(results),
  memcheck: (results) => results.filter((r) => r.score >= 3).slice(0, 8),
};

const report = {};
for (const [tier, gate] of Object.entries(TIERS)) {
  const misses = [];
  const falseFires = [];
  let onTopic = 0;
  let offTopic = 0;
  let recalled = 0;
  for (const q of queries) {
    const shown = gate(scoreMemories(q.query, memories)).map((r) => normalizeSlug(r.mem.name));
    if (q.expect.length) {
      onTopic++;
      if (q.expect.some((e) => shown.includes(normalizeSlug(e)))) recalled++;
      else misses.push(q);
    } else {
      offTopic++;
      if (shown.length) falseFires.push({ ...q, shown });
    }
  }
  report[tier] = { onTopic, offTopic, recalled, misses, falseFires };
}

const pct = (n, d) => `${n}/${d} (${Math.round((n / d) * 100)}%)`;
console.log(`memory recall bench — ${memories.length} memories, ${queries.length} queries\n`);
for (const [tier, r] of Object.entries(report)) {
  console.log(`${tier.padEnd(10)} recall ${pct(r.recalled, r.onTopic)} · false-fire ${pct(r.falseFires.length, r.offTopic)}`);
  if (verbose) {
    for (const m of r.misses) console.log(`  miss:  "${m.query}" (wanted ${m.expect.join(", ")})`);
    for (const f of r.falseFires) console.log(`  fire:  "${f.query}" → ${f.shown.join(", ")}`);
  }
}
