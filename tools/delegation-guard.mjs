#!/usr/bin/env node
// Delegation guard — PreToolUse hook on the `Agent` (and `Workflow`) tool.
//
// Subagent fan-out is the fastest way to burn a usage window, and it happens by
// reflex: a task looks parallel, the agent spawns five helpers, each one re-derives
// context the parent already had. This puts two hard caps on it, machine-wide,
// inside a rolling window:
//
//   1. Overall   — at most CAP subagents per window.
//   2. Premium   — at most PREMIUM_CAP expensive-model subagents per window.
//
// The premium cap catches the expensive case specifically. A spawn with NO explicit
// model on the DEFAULT agent type inherits the PARENT's model, which is usually the
// most expensive one you run — so an unqualified spawn counts as premium. Named
// specialist types (Explore, Plan, and your own agents) are exempt when no model is
// given: they carry their own default from their definition.
//
// Workflow launches fan out subagents through their own agent() calls, so they route
// through the same policy. Default is "ask" — one confirmation, not a wall.
//
// On refusal the hook returns a PreToolUse deny with a reason that names the cheaper
// route, because a guard that only says "no" gets worked around.
//
// Config (env, all optional):
//   CLAUDE_DELEGATION_CAP=4              overall subagents per window
//   CLAUDE_DELEGATION_PREMIUM_CAP=2      expensive-model subagents per window
//   CLAUDE_DELEGATION_WINDOW_MIN=10      window length in minutes
//   CLAUDE_PREMIUM_MODELS=opus,fable     model aliases treated as expensive
//   CLAUDE_WORKFLOW_POLICY=ask|deny|allow
//   CLAUDE_EXECUTORS="codex exec, copilot -p, ..."   named in the refusal message
//   CLAUDE_DELEGATION_STATE=<path>       state file (default ~/.claude/.delegation-guard.json)
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const CAP = num(process.env.CLAUDE_DELEGATION_CAP, 4);
const PREMIUM_CAP = num(process.env.CLAUDE_DELEGATION_PREMIUM_CAP, 2);
const WINDOW_MIN = num(process.env.CLAUDE_DELEGATION_WINDOW_MIN, 10);
const WINDOW_MS = WINDOW_MIN * 60 * 1000;
const PREMIUM_MODELS = (process.env.CLAUDE_PREMIUM_MODELS || "opus,fable")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const WORKFLOW_POLICY = (process.env.CLAUDE_WORKFLOW_POLICY || "ask").toLowerCase();
const EXECUTORS = process.env.CLAUDE_EXECUTORS
  || "`codex exec`, `copilot -p`, `vibe --prompt`, `grok -p`";
const STATE = process.env.CLAUDE_DELEGATION_STATE
  || join(homedir(), ".claude", ".delegation-guard.json");

const now = Date.now();

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* no stdin -> allow */ }
const ti = input?.tool_input || {};

// --- Workflow: same fan-out risk, handled before the counters. A stock research
//     workflow can spawn a hundred subagents through one call; the runtime's own
//     bound is far above anything a usage window survives, so a human decision is
//     the only real cap. ---
if (input?.tool_name === "Workflow" && WORKFLOW_POLICY !== "allow") {
  const verb = WORKFLOW_POLICY === "deny" ? "blocked" : "checkpoint";
  decide(
    WORKFLOW_POLICY === "deny" ? "deny" : "ask",
    `Workflow ${verb}: a workflow's agent() calls fan out subagents, and a single stock ` +
    `workflow can spawn dozens before anyone notices. Confirm this one is bounded, or route ` +
    `the work to an executor CLI (${EXECUTORS}) or do it inline. ` +
    `Set CLAUDE_WORKFLOW_POLICY=allow to stop asking.`,
  );
}

const model = String(ti.model || "").toLowerCase();
const type = String(ti.subagent_type || "").toLowerCase();
// An unqualified spawn on the default agent type inherits the parent model.
const inheritsParent = !model && (type === "" || type === "claude" || type === "general-purpose");
const isPremium = PREMIUM_MODELS.includes(model) || inheritsParent;

// --- load state (an older format was a bare array of timestamps) ---
let all = [], premium = [];
try {
  const parsed = JSON.parse(readFileSync(STATE, "utf8"));
  if (Array.isArray(parsed)) all = parsed;
  else if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.all)) all = parsed.all;
    if (Array.isArray(parsed.premium)) premium = parsed.premium;
  }
} catch { /* missing or corrupt -> start fresh */ }
const inWindow = (t) => typeof t === "number" && now - t < WINDOW_MS;
all = all.filter(inWindow);
premium = premium.filter(inWindow);

// A denied attempt is never recorded — otherwise a refused spawn would push the
// window out and lock you out longer for having been stopped.
if (isPremium && premium.length >= PREMIUM_CAP) {
  const what = model ? model : "model-inheriting (no explicit model on a default agent type)";
  decide("deny",
    `Premium-subagent cap: ${premium.length} expensive subagents already spawned in the last ` +
    `${WINDOW_MIN} min (cap ${PREMIUM_CAP}). This one is ${what}. Pass a cheaper \`model\` for a ` +
    `bounded chunk like this, or hand it to an executor CLI (${EXECUTORS}). If the expensive ` +
    `model is genuinely required, wait out the window or ask the user.`,
  );
}

if (all.length >= CAP) {
  decide("deny",
    `Delegation cap: ${all.length} subagents already spawned in the last ${WINDOW_MIN} min ` +
    `(cap ${CAP}). Don't swarm — route this to an executor CLI (${EXECUTORS}), or do it inline. ` +
    `If a subagent is genuinely required, wait for the window to clear or ask the user.`,
  );
}

all.push(now);
if (isPremium) premium.push(now);
try {
  writeFileSync(STATE, JSON.stringify({ all, premium }));
} catch {
  // Best effort. Never block a legitimate spawn because state could not be written.
}
process.exit(0);
