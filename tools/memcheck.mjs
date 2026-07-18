#!/usr/bin/env node
// memcheck — agent-invokable pre-flight self-check. Run it against a TOPIC or
// a proposed approach BEFORE pitching/committing to it, so a decision you
// already recorded overrides a fresh idea. (This is the antidote the
// UserPromptSubmit hook can't be: it scores YOUR topic, not the user's prompt.)
//
// Optionally sweeps a second, shared store (a git repo of memories your team
// maintains) alongside the local per-project memory dir. Results carry a
// [local]/[team] tag; a memory mirrored in both stores collapses to [both]
// with the team copy winning (treat the shared store as the fresher tier).
//
//   node memcheck.mjs "redo the dark mode cards to match the canvas"
//   node memcheck.mjs --dir <memory-dir> "<topic>"    (local dir override)
//   node memcheck.mjs --team <dir> "<topic>"          (also sweep a shared store)
//   CLAUDE_TEAM_MEMORY_DIR=<dir>                      (same, via env)
import fs from "node:fs";
import { resolveMemoryDir, loadMemories, scoreMemories, normalizeSlug } from "./memory-lib.mjs";

// Non-entry files commonly found in a shared store.
const TEAM_EXCLUDE = ["INDEX.md", "README.md"];

const args = process.argv.slice(2);
const dirArg = args.indexOf("--dir");
let dir = resolveMemoryDir();
if (dirArg >= 0) {
  dir = args[dirArg + 1];
  args.splice(dirArg, 2);
}
const teamArg = args.indexOf("--team");
let teamDir = process.env.CLAUDE_TEAM_MEMORY_DIR || null;
if (teamArg >= 0) {
  teamDir = args[teamArg + 1];
  args.splice(teamArg, 2);
}
const query = args.join(" ").trim();
if (!query) {
  console.log('usage: node memcheck.mjs [--team <dir>] "<topic or proposed approach>"');
  process.exit(0);
}

const memories = loadMemories(dir).map((m) => ({ ...m, store: "local" }));
if (teamDir && fs.existsSync(teamDir)) {
  const bySlug = new Map(memories.map((m) => [normalizeSlug(m.name), m]));
  for (const t of loadMemories(teamDir, { exclude: TEAM_EXCLUDE })) {
    const key = normalizeSlug(t.name);
    const local = bySlug.get(key);
    if (local) {
      Object.assign(local, t, { store: "both" });
    } else {
      const entry = { ...t, store: "team" };
      memories.push(entry);
      bySlug.set(key, entry);
    }
  }
}

const results = scoreMemories(query, memories)
  .filter((r) => r.score >= 3)
  .slice(0, 8);

if (results.length === 0) {
  console.log(`memcheck: no strong prior memory for "${query}".`);
  process.exit(0);
}

console.log(`memcheck — prior memory relevant to "${query}":`);
console.log("(★ = a decision/feedback you recorded — it outranks a fresh idea. [team] = shared store, may be a teammate's finding. Verify before acting.)");
for (const r of results) {
  const star = r.mem.type === "feedback" || r.mem.type === "project" ? "★ " : "  ";
  console.log(`\n${star}[[${r.mem.name}]]  <${r.mem.type}>  [${r.mem.store}]  (score ${r.score})`);
  console.log(`   ${r.mem.description}`);
}
process.exit(0);
