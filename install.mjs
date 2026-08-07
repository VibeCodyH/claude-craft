#!/usr/bin/env node
// claude-craft installer.
//
// Copies the tools you pick into ~/.claude/tools and MERGES their hook wiring into
// ~/.claude/settings.json. It never overwrites that file wholesale: it reads what is
// there, adds only the entries that are missing, and writes one timestamped backup
// the first time it changes anything. Re-running is a no-op.
//
//   node install.mjs                 # everything, after showing you the plan
//   node install.mjs --dry-run       # show the plan, change nothing
//   node install.mjs memory delegation
//   node install.mjs --list
//   node install.mjs --uninstall <component ...>
//
// Hook commands are written as absolute paths. Claude Code does not expand `~` inside
// a hook command string on every platform, and a hook that silently fails to run is
// worse than one that fails loudly.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, chmodSync, rmSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const TOOLS_DIR = join(CLAUDE_DIR, "tools");
const SKILLS_DIR = join(CLAUDE_DIR, "skills");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const BIN_DIR = process.env.CLAUDE_CRAFT_BIN || join(HOME, ".local", "bin");

const t = (name) => join(TOOLS_DIR, name);

// Each component: the files it installs and the hook entries it needs. `event`,
// `matcher` and `command` together identify an entry, so a second run recognizes
// its own work and adds nothing.
const COMPONENTS = {
  memory: {
    blurb: "memory lint / recall preflight / staleness — keeps the auto-memory store honest",
    tools: ["memory-lib.mjs", "memory-lint.mjs", "memory-preflight.mjs", "memcheck.mjs", "memory-staleness.mjs"],
    hooks: [
      { event: "UserPromptSubmit", matcher: null, command: `node "${t("memory-preflight.mjs")}"`, timeout: 10 },
      { event: "SessionStart", matcher: null, command: `node "${t("memory-staleness.mjs")}"`, timeout: 10 },
    ],
  },
  delegation: {
    blurb: "subagent caps + mechanical-sweep nudge — stops fan-out from eating a usage window",
    tools: ["delegation-guard.mjs", "delegation-nudge.mjs"],
    hooks: [
      { event: "PreToolUse", matcher: "Agent|Workflow", command: `node "${t("delegation-guard.mjs")}"`, timeout: 10 },
      { event: "PostToolUse", matcher: "Edit|Write|MultiEdit", command: `node "${t("delegation-nudge.mjs")}"`, timeout: 10 },
    ],
  },
  "protected-repos": {
    blurb: "never-push guard for repos where a human runs every push",
    tools: ["protected-repo-guard.mjs"],
    hooks: [
      { event: "PreToolUse", matcher: "Bash", command: `node "${t("protected-repo-guard.mjs")}"`, timeout: 10 },
    ],
    after: (log) => {
      const cfg = join(CLAUDE_DIR, "protected-repos.json");
      if (!existsSync(cfg)) log(`  next: create ${cfg} — [{ "slug": "org/repo", "dir": "/abs/path/to/clone" }]`);
    },
  },
  rotate: {
    blurb: "usage-limit auto-rotate (needs swappy — github.com/PiXeL16/swappy)",
    tools: ["swappy-auto-rotate.mjs"],
    hooks: [
      { event: "Stop", matcher: "", command: `node "${t("swappy-auto-rotate.mjs")}"`, timeout: 15 },
      { event: "PostToolUse", matcher: "*", command: `node "${t("swappy-auto-rotate.mjs")}"`, timeout: 15, async: true },
    ],
    after: (log) => log("  next: persist rate_limits from your statusline script — see README"),
  },
  crunch: {
    blurb: "free-cloud-first bulk LLM lane with a local floor (installs the `crunch` command)",
    // Deliberately NOT also copied into ~/.claude/tools: it is a CLI, not a hook, and
    // two copies of the same file drift. Import it from the checkout to use as a library.
    tools: [],
    hooks: [],
    bins: [{ from: join(HERE, "tools", "crunch.mjs"), name: "crunch" }],
    after: (log) => {
      const env = join(HOME, ".config", "claude-craft", "crunch.env");
      if (!existsSync(env)) log(`  next: cp ${join(HERE, "crunch.env.example")} ${env} and add the keys you have`);
    },
  },
  agentcall: {
    blurb: "one calling convention for every agent CLI (installs the `agentcall` command)",
    tools: [],
    hooks: [],
    bins: [{ from: join(HERE, "bin", "agentcall"), name: "agentcall" }],
    after: (log) => log("  next: agentcall --probe   (shows which CLIs are installed and authenticated)"),
  },
  skills: {
    blurb: "the delegate skill — teaches the agent when to hand work to an executor",
    tools: [],
    hooks: [],
    skills: ["delegate"],
  },
};

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const picked = argv.filter((a) => !a.startsWith("--"));
const DRY = flags.has("--dry-run");
const UNINSTALL = flags.has("--uninstall");

if (flags.has("--help") || flags.has("-h")) {
  console.log(`claude-craft installer

  node install.mjs [--dry-run] [component ...]
  node install.mjs --list
  node install.mjs --uninstall <component ...>

With no components named, installs everything. Components:`);
  for (const [k, c] of Object.entries(COMPONENTS)) console.log(`  ${k.padEnd(16)} ${c.blurb}`);
  console.log(`\nTarget: ${CLAUDE_DIR}  (override with CLAUDE_CONFIG_DIR)`);
  process.exit(0);
}
if (flags.has("--list")) {
  for (const [k, c] of Object.entries(COMPONENTS)) console.log(`${k.padEnd(16)} ${c.blurb}`);
  process.exit(0);
}

const unknown = picked.filter((p) => !COMPONENTS[p]);
if (unknown.length) {
  console.error(`unknown component(s): ${unknown.join(", ")}\nknown: ${Object.keys(COMPONENTS).join(", ")}`);
  process.exit(2);
}
if (UNINSTALL && !picked.length) {
  // "Install everything" is a reasonable default. "Remove everything" is not.
  console.error("--uninstall needs at least one component name (see --list).");
  process.exit(2);
}
const selected = picked.length ? picked : Object.keys(COMPONENTS);

// --- settings.json ----------------------------------------------------------
function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  const raw = readFileSync(SETTINGS, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Refuse rather than replace. Overwriting a settings file we could not parse
    // would destroy hand-written config we cannot see.
    console.error(`\n${SETTINGS} is not valid JSON (${e.message}).`);
    console.error("Fix or move it first — refusing to touch it.");
    process.exit(1);
  }
}

// Already installed == the same event and matcher already run this TOOL. Comparing
// the whole command string is not enough: someone who hand-wired the hook with `~`
// or `$HOME` instead of an absolute path would get a second copy, and the tool would
// then run twice per event. Match on the script filename instead.
const scriptOf = (cmd) => (String(cmd).match(/([\w.-]+\.(?:mjs|js|cjs|sh))\b/) || [])[1];

function hasHook(settings, { event, matcher, command }) {
  const groups = settings.hooks?.[event] || [];
  const want = scriptOf(command);
  return groups.some((g) =>
    (matcher === null || (g.matcher ?? "") === matcher)
    && (g.hooks || []).some((h) => h.command === command || (want && scriptOf(h.command) === want)));
}

function addHook(settings, { event, matcher, command, timeout, async: isAsync }) {
  settings.hooks ||= {};
  settings.hooks[event] ||= [];
  const entry = { type: "command", command };
  if (timeout) entry.timeout = timeout;
  if (isAsync) entry.async = true;
  // Join an existing group with the same matcher so the file does not accumulate
  // one single-hook group per install.
  const group = settings.hooks[event].find((g) => (g.matcher ?? "") === (matcher ?? ""));
  if (group) (group.hooks ||= []).push(entry);
  else settings.hooks[event].push(matcher === null ? { hooks: [entry] } : { matcher, hooks: [entry] });
}

function removeHook(settings, { event, command }) {
  const groups = settings.hooks?.[event];
  if (!groups) return false;
  let removed = false;
  for (const g of groups) {
    const before = (g.hooks || []).length;
    g.hooks = (g.hooks || []).filter((h) => h.command !== command);
    if (g.hooks.length !== before) removed = true;
  }
  settings.hooks[event] = groups.filter((g) => (g.hooks || []).length > 0);
  if (!settings.hooks[event].length) delete settings.hooks[event];
  return removed;
}

let backedUp = false;
function backupOnce(log) {
  if (backedUp || DRY || !existsSync(SETTINGS)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${SETTINGS}.backup-${stamp}`;
  copyFileSync(SETTINGS, dest);
  log(`  backed up settings.json -> ${dest}`);
  backedUp = true;
}

// --- run --------------------------------------------------------------------
const log = (s) => console.log(s);
const settings = readSettings();
let changed = false;
const notes = [];

if (!DRY) {
  mkdirSync(TOOLS_DIR, { recursive: true });
  mkdirSync(BIN_DIR, { recursive: true });
}

log(UNINSTALL ? "Removing:" : `Installing into ${CLAUDE_DIR}:`);

for (const name of selected) {
  const c = COMPONENTS[name];
  log(`\n${name} — ${c.blurb}`);

  if (UNINSTALL) {
    for (const h of c.hooks) {
      if (hasHook(settings, h)) {
        log(`  unhook ${h.event}${h.matcher ? ` [${h.matcher}]` : ""}`);
        if (!DRY) { backupOnce(log); removeHook(settings, h); }
        changed = true;
      }
    }
    for (const b of c.bins || []) {
      const dest = join(BIN_DIR, b.name);
      if (existsSync(dest)) { log(`  rm ${dest}`); if (!DRY) rmSync(dest); }
    }
    // Tool files and skills are left in place: they are inert without the hook
    // wiring, and something else may have come to depend on them.
    continue;
  }

  for (const f of c.tools) {
    const src = join(HERE, "tools", f);
    if (!existsSync(src)) { log(`  SKIP ${f} (not in this checkout)`); continue; }
    log(`  ${existsSync(t(f)) ? "update" : "copy  "} tools/${f}`);
    if (!DRY) copyFileSync(src, t(f));
  }

  for (const b of c.bins || []) {
    const dest = join(BIN_DIR, b.name);
    log(`  ${existsSync(dest) ? "update" : "copy  "} ${dest}`);
    if (!DRY) { copyFileSync(b.from, dest); chmodSync(dest, 0o755); }
  }

  for (const s of c.skills || []) {
    const src = join(HERE, "skills", s);
    if (!existsSync(src)) { log(`  SKIP skill ${s} (not in this checkout)`); continue; }
    log(`  ${existsSync(join(SKILLS_DIR, s)) ? "update" : "copy  "} skills/${s}`);
    if (!DRY) copyDir(src, join(SKILLS_DIR, s));
  }

  for (const h of c.hooks) {
    if (hasHook(settings, h)) { log(`  hook ${h.event} already wired`); continue; }
    log(`  wire  ${h.event}${h.matcher ? ` [${h.matcher}]` : ""}`);
    if (!DRY) { backupOnce(log); addHook(settings, h); }
    changed = true;
  }

  if (c.after) c.after((s) => notes.push(s));
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src)) {
    const from = join(src, e), to = join(dest, e);
    if (statSync(from).isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

if (changed && !DRY) {
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  log(`\nwrote ${SETTINGS}`);
} else if (DRY) {
  log("\n--dry-run: nothing written.");
} else if (!UNINSTALL) {
  log("\nAlready up to date.");
}

if (notes.length) { log(""); notes.forEach((n) => log(n)); }

if (!UNINSTALL && !DRY) {
  const onPath = (process.env.PATH || "").split(":").includes(resolve(BIN_DIR));
  if (!onPath && selected.some((n) => COMPONENTS[n].bins?.length)) {
    log(`\nnote: ${BIN_DIR} is not on your PATH — add it to use \`crunch\` / \`agentcall\` by name.`);
  }
  log("\nRestart Claude Code (or start a new session) to pick up the hooks.");
}
