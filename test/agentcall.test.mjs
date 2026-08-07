import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const AGENTCALL = join(here, "..", "bin", "agentcall");

const bashMajor = Number(
  execFileSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).trim(),
);
const skip = bashMajor < 4 ? "needs bash 4+ (this box has bash 3)" : false;

const run = (...args) =>
  execFileSync("bash", [AGENTCALL, ...args], { encoding: "utf8", env: { ...process.env } });

test("parses as valid bash", () => {
  // Catches the syntax error that would otherwise only surface on someone's first call.
  execFileSync("bash", ["-n", AGENTCALL]);
});

test("--print-command shows the real invocation without running anything", { skip }, () => {
  const out = run("--print-command", "grok", "-d", here, "hello");
  // The three flags that were each, at some point, silently wrong.
  assert.match(out, /--always-approve/, "missing this cancels tool calls silently");
  assert.match(out, /--output-format json/);
  assert.match(out, /-p hello\s*$/m, "-p eats the next arg, so the prompt goes last");
});

test("codex adapter routes output to a file rather than the reasoning stream", { skip }, () => {
  assert.match(run("--print-command", "codex", "-d", here, "hi"), /-o OUTFILE/);
});

test("read-only is the default mode and rw drops the read-only flags", { skip }, () => {
  assert.match(run("--print-command", "codex", "-d", here, "hi"), /-s read-only/);
  assert.doesNotMatch(run("--print-command", "codex", "-d", here, "-m", "rw", "hi"), /read-only/);
});

test("--list documents every builtin agent", { skip }, () => {
  const out = run("--list");
  for (const a of ["codex", "claude", "grok", "kimi", "vibe", "glm", "agy", "opencode", "copilot", "coderabbit"]) {
    assert.match(out, new RegExp(`^${a}\\s`, "m"), `${a} missing from --list`);
  }
});

test("rejects a bad mode and an unknown agent instead of guessing", { skip }, () => {
  for (const args of [["codex", "-m", "sideways", "hi"], ["nosuchagent", "hi"]]) {
    assert.throws(() => run(...args), (e) => {
      assert.equal(e.status, 2);
      assert.match(e.stderr, /agentcall:/);
      return true;
    });
  }
});
