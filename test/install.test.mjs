import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(here, "..", "install.mjs");

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "craft-install-"));
  const cfg = join(home, ".claude");
  mkdirSync(cfg, { recursive: true });
  return { home, cfg, settings: join(cfg, "settings.json") };
}

function install(env, ...args) {
  return execFileSync(process.execPath, [INSTALL, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: env.cfg,
      CLAUDE_CRAFT_BIN: join(env.home, "bin"),
    },
  });
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

test("merges into an existing settings.json without touching anything else", () => {
  const env = freshHome();
  writeFileSync(env.settings, JSON.stringify({
    model: "opus",
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /somewhere/mine.mjs" }] }],
    },
  }, null, 2));

  install(env, "delegation");
  const s = read(env.settings);

  // Pre-existing config survives verbatim.
  assert.equal(s.model, "opus");
  assert.deepEqual(s.permissions.allow, ["Bash(npm test)"]);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, "node /somewhere/mine.mjs");

  // And the new wiring landed.
  const pre = s.hooks.PreToolUse.find((g) => g.matcher === "Agent|Workflow");
  assert.ok(pre, "PreToolUse group created with the right matcher");
  assert.match(pre.hooks[0].command, /delegation-guard\.mjs/);
  assert.match(pre.hooks[0].command, /^node "\//, "hook commands are absolute, not ~-relative");
  const post = s.hooks.PostToolUse.find((g) => g.matcher === "Edit|Write|MultiEdit");
  assert.match(post.hooks[0].command, /delegation-nudge\.mjs/);
});

test("backs the settings file up before the first change", () => {
  const env = freshHome();
  writeFileSync(env.settings, JSON.stringify({ model: "opus" }));
  install(env, "delegation");
  const backups = readdirSync(env.cfg).filter((f) => f.startsWith("settings.json.backup-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(read(join(env.cfg, backups[0])), { model: "opus" });
});

test("re-running changes nothing and writes no second backup", () => {
  const env = freshHome();
  writeFileSync(env.settings, JSON.stringify({ model: "opus" }));
  install(env, "delegation");
  const after = readFileSync(env.settings, "utf8");

  const out = install(env, "delegation");
  assert.match(out, /already wired/);
  assert.match(out, /Already up to date/);
  assert.equal(readFileSync(env.settings, "utf8"), after, "second run is byte-identical");
  assert.equal(readdirSync(env.cfg).filter((f) => f.includes(".backup-")).length, 1);
});

test("joins an existing group with the same matcher instead of adding a duplicate", () => {
  const env = freshHome();
  writeFileSync(env.settings, JSON.stringify({
    hooks: { PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: "node /mine.mjs" }] }] },
  }));
  install(env, "delegation");
  const groups = read(env.settings).hooks.PostToolUse.filter((g) => g.matcher === "Edit|Write|MultiEdit");
  assert.equal(groups.length, 1, "one group, not one per install");
  assert.equal(groups[0].hooks.length, 2);
  assert.equal(groups[0].hooks[0].command, "node /mine.mjs");
});

test("recognizes a hook hand-wired with a different path form", () => {
  const env = freshHome();
  // The same tool, wired the way someone would do it by hand from the old README.
  writeFileSync(env.settings, JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: "Agent|Workflow",
        hooks: [{ type: "command", command: "node ~/.claude/tools/delegation-guard.mjs" }],
      }],
    },
  }));
  const out = install(env, "delegation");
  assert.match(out, /already wired/);
  const group = read(env.settings).hooks.PreToolUse.find((g) => g.matcher === "Agent|Workflow");
  assert.equal(group.hooks.length, 1, "must not add a second copy that would run the tool twice");
  assert.equal(group.hooks[0].command, "node ~/.claude/tools/delegation-guard.mjs", "leaves their wiring alone");
});

test("--dry-run writes nothing at all", () => {
  const env = freshHome();
  writeFileSync(env.settings, JSON.stringify({ model: "opus" }));
  const before = readFileSync(env.settings, "utf8");
  const out = install(env, "--dry-run");
  assert.match(out, /nothing written/);
  assert.equal(readFileSync(env.settings, "utf8"), before);
  assert.equal(existsSync(join(env.cfg, "tools", "delegation-guard.mjs")), false);
});

test("works from no settings file at all", () => {
  const env = freshHome();
  install(env, "delegation");
  assert.ok(read(env.settings).hooks.PreToolUse);
  assert.equal(readdirSync(env.cfg).filter((f) => f.includes(".backup-")).length, 0,
    "nothing to back up when there was no file");
});

test("refuses to touch a settings.json it cannot parse", () => {
  const env = freshHome();
  writeFileSync(env.settings, "{ this is not json");
  assert.throws(() => install(env, "delegation"), (e) => {
    assert.equal(e.status, 1);
    assert.match(e.stderr, /not valid JSON/);
    assert.match(e.stderr, /refusing to touch it/);
    return true;
  });
  assert.equal(readFileSync(env.settings, "utf8"), "{ this is not json", "left untouched");
});

test("installs executables and the skill, and uninstall removes the wiring", () => {
  const env = freshHome();
  install(env, "agentcall", "crunch", "skills");
  assert.ok(existsSync(join(env.home, "bin", "agentcall")));
  assert.ok(existsSync(join(env.home, "bin", "crunch")));
  assert.ok(existsSync(join(env.cfg, "skills", "delegate", "SKILL.md")));

  install(env, "delegation");
  assert.ok(read(env.settings).hooks.PreToolUse);
  install(env, "--uninstall", "delegation", "agentcall");
  const s = read(env.settings);
  assert.equal(s.hooks?.PreToolUse, undefined, "empty hook groups are cleaned up, not left as []");
  assert.equal(existsSync(join(env.home, "bin", "agentcall")), false);
});

test("rejects an unknown component name", () => {
  const env = freshHome();
  assert.throws(() => install(env, "nonsense"), (e) => {
    assert.equal(e.status, 2);
    assert.match(e.stderr, /unknown component/);
    return true;
  });
});

process.on("exit", () => {
  for (const d of readdirSync(tmpdir()).filter((f) => f.startsWith("craft-install-"))) {
    rmSync(join(tmpdir(), d), { recursive: true, force: true });
  }
});
