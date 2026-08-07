#!/usr/bin/env node
// Delegation nudge — PostToolUse hook on Edit|Write|MultiEdit.
//
// Advisory only. It never denies and never blocks. When the MAIN loop edits many
// distinct files in a short window, that is a mechanical sweep, and a mechanical
// sweep is the single most delegatable thing an agent does — but it is also the
// thing nobody catches in the moment, because by then the human has walked away and
// the agent is head-down grinding. This surfaces a ready-to-run executor command at
// the point the pattern becomes visible.
//
// Companion to delegation-guard.mjs, which hard-caps subagent spawns. That one stops
// the expensive reflex; this one suggests the cheap alternative.
//
// Config (env, all optional):
//   CLAUDE_NUDGE_FILES=3         distinct files that make it "a sweep"
//   CLAUDE_NUDGE_WINDOW_MIN=5    rolling window
//   CLAUDE_NUDGE_COOLDOWN_MIN=8  minimum gap between nudges
//   CLAUDE_NUDGE_SKIP=/a:/b      extra path prefixes to stay silent on (colon-separated)
//   CLAUDE_NUDGE_CMD=codex       executor the suggested command uses
//   PROTECTED_REPOS_FILE         reused from protected-repo-guard.mjs (see below)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, delimiter } from "node:path";

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const WINDOW_MS = num(process.env.CLAUDE_NUDGE_WINDOW_MIN, 5) * 60 * 1000;
const COOLDOWN_MS = num(process.env.CLAUDE_NUDGE_COOLDOWN_MIN, 8) * 60 * 1000;
const DISTINCT_FILES = num(process.env.CLAUDE_NUDGE_FILES, 3);
const EXECUTOR = process.env.CLAUDE_NUDGE_CMD || "codex";
const HOME = homedir();
const STATE = process.env.CLAUDE_NUDGE_STATE || join(HOME, ".claude", ".delegation-nudge.json");

// Never nudge for: the agent's own config and memory bookkeeping (that is not grunt
// work to hand off), scratch dirs, and any repo you have marked protected. A repo
// where a human must run every push is a repo whose edits you want to have read
// yourself — so the same config that blocks the push silences the nudge.
function protectedDirs() {
  const file = process.env.PROTECTED_REPOS_FILE || join(HOME, ".claude", "protected-repos.json");
  try {
    const repos = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(repos) ? repos.map((r) => r?.dir).filter((d) => typeof d === "string" && d) : [];
  } catch { return []; }
}
const SKIP = [
  join(HOME, ".claude"),
  "/tmp/claude-",
  ...protectedDirs(),
  ...(process.env.CLAUDE_NUDGE_SKIP || "").split(delimiter).filter(Boolean),
];

// Nearest ancestor holding .git, so the suggested command is immediately runnable.
function repoRootOf(file) {
  let d = dirname(file);
  for (let i = 0; i < 12 && d && d !== "/" && d !== dirname(d); i++) {
    if (existsSync(join(d, ".git"))) return d;
    d = dirname(d);
  }
  return dirname(file);
}

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* no stdin */ }

const fp = input?.tool_input?.file_path || input?.tool_input?.filePath || "";
const now = Date.now();

// No usable path, or an excluded one -> do nothing, say nothing.
if (!fp || SKIP.some((s) => fp.startsWith(s))) process.exit(0);

let state = { edits: [], lastNudge: 0 };
try {
  const parsed = JSON.parse(readFileSync(STATE, "utf8"));
  if (parsed && Array.isArray(parsed.edits)) state = parsed;
} catch { /* fresh state */ }

state.edits = state.edits.filter((e) => e && typeof e.t === "number" && now - e.t < WINDOW_MS);
state.edits.push({ p: fp, t: now });

const distinct = new Set(state.edits.map((e) => e.p)).size;

let nudge = null;
if (distinct >= DISTINCT_FILES && now - (state.lastNudge || 0) > COOLDOWN_MS) {
  state.lastNudge = now;
  const repoRoot = repoRootOf(fp);
  const files = [...new Set(state.edits.map((e) => e.p))].map((p) => p.split("/").pop()).join(", ");
  nudge =
    `delegation-nudge: ${distinct} distinct files edited in ${WINDOW_MS / 60000} min — that is a ` +
    `mechanical sweep. Hand the REMAINING edits to an executor unless this is judgment work, ` +
    `integration, or a security/production-write path.\n\n` +
    `Ready command:\n` +
    `  ${EXECUTOR} exec -s workspace-write -C "${repoRoot}" - <<'EOF'\n` +
    `  Continue the mechanical sweep already started. First run \`git diff\` to see the pattern.\n` +
    `  Files already touched: ${files}. Find the remaining files matching the SAME pattern, apply\n` +
    `  ONLY that pattern, run the relevant check, and report the files you changed. Do not push.\n` +
    `  EOF\n\n` +
    `If staying in the main loop, say so in one line with the reason.`;
}

try { writeFileSync(STATE, JSON.stringify(state)); } catch { /* best effort */ }

if (nudge) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: nudge },
  }));
}
process.exit(0);
