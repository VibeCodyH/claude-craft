import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, "..", "tools", "delegation-guard.mjs");
const NUDGE = join(here, "..", "tools", "delegation-nudge.mjs");

const dir = mkdtempSync(join(tmpdir(), "delegation-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const statePath = join(dir, "guard-state.json");
const nudgeState = join(dir, "nudge-state.json");
const protectedFile = join(dir, "protected-repos.json");

function runGuard(input, env = {}) {
  const out = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_DELEGATION_STATE: statePath, ...env },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
}

function runNudge(filePath, env = {}) {
  const out = execFileSync(process.execPath, [NUDGE], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: filePath } }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_NUDGE_STATE: nudgeState,
      PROTECTED_REPOS_FILE: protectedFile,
      ...env,
    },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
}

const spawn = (extra = {}) => ({ tool_name: "Agent", tool_input: { subagent_type: "Explore", model: "sonnet", ...extra } });

test("guard allows spawns under the cap and records them", () => {
  writeFileSync(statePath, JSON.stringify({ all: [], premium: [] }));
  assert.equal(runGuard(spawn()), null);
  assert.equal(runGuard(spawn()), null);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.all.length, 2);
  assert.equal(state.premium.length, 0, "an explicit cheap model is not premium");
});

test("guard denies past the overall cap and does NOT record the refusal", () => {
  const past = Date.now();
  writeFileSync(statePath, JSON.stringify({ all: [past, past], premium: [] }));
  const res = runGuard(spawn(), { CLAUDE_DELEGATION_CAP: "2" });
  assert.equal(res.permissionDecision, "deny");
  assert.match(res.permissionDecisionReason, /Delegation cap/);
  // A refused spawn must not extend the window — otherwise being stopped locks you
  // out longer than the cap actually allows.
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).all.length, 2);
});

test("guard counts an unqualified default-type spawn as premium", () => {
  const now = Date.now();
  writeFileSync(statePath, JSON.stringify({ all: [now], premium: [now, now] }));
  const res = runGuard({ tool_name: "Agent", tool_input: { subagent_type: "general-purpose" } });
  assert.equal(res.permissionDecision, "deny");
  assert.match(res.permissionDecisionReason, /Premium-subagent cap/);
  assert.match(res.permissionDecisionReason, /model-inheriting/);
});

test("guard exempts a named specialist type with no model", () => {
  const now = Date.now();
  writeFileSync(statePath, JSON.stringify({ all: [now], premium: [now, now] }));
  assert.equal(runGuard({ tool_name: "Agent", tool_input: { subagent_type: "Explore" } }), null,
    "a named agent type carries its own default model, so it is not premium");
});

test("guard drops entries that fell out of the window", () => {
  const old = Date.now() - 60 * 60 * 1000;
  writeFileSync(statePath, JSON.stringify({ all: [old, old, old, old, old], premium: [old, old] }));
  assert.equal(runGuard(spawn()), null);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).all.length, 1);
});

test("guard asks on Workflow by default, denies when told to, allows when told to", () => {
  writeFileSync(statePath, JSON.stringify({ all: [], premium: [] }));
  assert.equal(runGuard({ tool_name: "Workflow", tool_input: {} }).permissionDecision, "ask");
  assert.equal(runGuard({ tool_name: "Workflow", tool_input: {} },
    { CLAUDE_WORKFLOW_POLICY: "deny" }).permissionDecision, "deny");
  assert.equal(runGuard({ tool_name: "Workflow", tool_input: {} },
    { CLAUDE_WORKFLOW_POLICY: "allow" }), null);
});

test("guard survives corrupt state instead of blocking", () => {
  writeFileSync(statePath, "{not json");
  assert.equal(runGuard(spawn()), null);
});

test("nudge stays silent below the threshold, then fires once", () => {
  rmSync(nudgeState, { force: true });
  writeFileSync(protectedFile, "[]");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });

  assert.equal(runNudge(join(repo, "a.ts")), null);
  assert.equal(runNudge(join(repo, "b.ts")), null);
  const res = runNudge(join(repo, "c.ts"));
  assert.match(res.additionalContext, /3 distinct files/);
  assert.match(res.additionalContext, new RegExp(`-C "${repo}"`), "suggests the repo root");
  // Cooldown: a fourth edit right away must not nag again.
  assert.equal(runNudge(join(repo, "d.ts")), null);
});

test("nudge counts distinct files, not repeated edits to one", () => {
  rmSync(nudgeState, { force: true });
  writeFileSync(protectedFile, "[]");
  const repo = join(dir, "repo2");
  mkdirSync(join(repo, ".git"), { recursive: true });
  for (let i = 0; i < 5; i++) assert.equal(runNudge(join(repo, "same.ts")), null);
});

test("nudge stays silent inside a protected repo", () => {
  rmSync(nudgeState, { force: true });
  const repo = join(dir, "protected-repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(protectedFile, JSON.stringify([{ slug: "org/repo", dir: repo }]));
  for (const f of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
    assert.equal(runNudge(join(repo, f)), null,
      "a repo the agent may not push is a repo whose edits it should read itself");
  }
});
