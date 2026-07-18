import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(here, "..", "tools");
const FIXTURES = join(here, "fixtures", "memory");

const run = (script, ...args) =>
  execFileSync(process.execPath, [join(TOOLS, script), ...args], { encoding: "utf8" });

test("memory-lint finds the planted rot and nothing else", () => {
  const report = JSON.parse(run("memory-lint.mjs", "--json", "--dir", FIXTURES));
  assert.equal(report.counts.memories, 3);
  assert.equal(report.counts.dangling, 1);
  assert.equal(report.dangling[0].link, "missing-memory");
  assert.equal(report.counts.brokenIndex, 1);
  assert.equal(report.brokenIndex[0].target, "gone.md");
  assert.deepEqual(report.orphans, ["reference-deploy-notes.md"]);
  assert.equal(report.counts.dupes, 1);
});

test("memcheck surfaces the recorded decision for an on-topic query", () => {
  const out = run("memcheck.mjs", "--dir", FIXTURES, "restyle the dark mode cards to match the canvas");
  assert.match(out, /\[\[feedback-dark-mode\]\]/);
  assert.match(out, /★/); // feedback memories are decision-starred
});

test("memcheck stays quiet off-topic", () => {
  const out = run("memcheck.mjs", "--dir", FIXTURES, "upgrade the kubernetes ingress controller");
  assert.match(out, /no strong prior memory/);
});

test("bench floors hold: preflight never false-fires, recall above floor", () => {
  const out = run(join("..", "test", "bench", "run-bench.mjs"));
  const grab = (tier) => out.match(new RegExp(`${tier}\\s+recall (\\d+)/(\\d+) \\(\\d+%\\) · false-fire (\\d+)/`)).slice(1).map(Number);
  const [pRecalled, pOnTopic, pFires] = grab("preflight");
  assert.equal(pFires, 0, "preflight must stay silent off-topic");
  assert.ok(pRecalled / pOnTopic >= 0.5, `preflight recall floor: ${pRecalled}/${pOnTopic}`);
  const [mRecalled, mOnTopic] = grab("memcheck");
  assert.ok(mRecalled / mOnTopic >= 0.75, `memcheck recall floor: ${mRecalled}/${mOnTopic}`);
});

test("protected-repo guard denies pushes, allows everything else", () => {
  const guard = (command, cwd = "/home/dev/elsewhere") =>
    execFileSync(process.execPath, [join(TOOLS, "protected-repo-guard.mjs")], {
      encoding: "utf8",
      input: JSON.stringify({ tool_input: { command }, cwd }),
      env: { ...process.env, PROTECTED_REPOS_FILE: join(here, "fixtures", "protected-repos.json") },
    });
  const denied = (out) => out.includes('"permissionDecision":"deny"');

  assert.ok(denied(guard("git push", "/opt/clones/website")), "push from inside the clone");
  assert.ok(denied(guard("cd /opt/clones/website && git push origin main")), "cd chain into the clone");
  assert.ok(denied(guard("git -C /opt/clones/website push")), "-C into the clone");
  assert.ok(denied(guard("gh pr create -R acme/website --title x")), "gh pr create by slug");
  assert.ok(denied(guard("git push git@github.com:acme/website.git main")), "push by URL");
  assert.ok(denied(guard("(cd /opt/clones/website && git push)")), "subshell-grouped cd chain");
  assert.ok(denied(guard("gh pr -R acme/website create --title x")), "gh flag between group and verb");
  assert.ok(denied(guard(`git -C "/opt/clones/website" push`, "/opt")), "quoted -C path");

  assert.equal(guard("git push", "/opt/clones/other-repo"), "", "push elsewhere stays allowed");
  assert.equal(guard("git commit -m wip", "/opt/clones/website"), "", "local commit stays allowed");
  assert.equal(guard("gh api repos/acme/website/issues -X POST -f title=bug"), "", "issue lane stays open");
});

test("memory-staleness flags drift and stays silent when fresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-stale-"));
  try {
    const target = join(dir, "pinned.txt");
    writeFileSync(target, "v1 contents\n");
    const good = createHash("sha256").update("v1 contents\n").digest("hex").slice(0, 12);

    writeFileSync(join(dir, "bound.md"), `---\nname: bound\ndescription: pins a file\nmetadata:\n  type: reference\n---\nbinds:\n      - ${target}@${good}\n`);
    assert.equal(run("memory-staleness.mjs", "--dir", dir).trim(), "");

    writeFileSync(target, "v2 contents — drifted\n");
    assert.match(run("memory-staleness.mjs", "--dir", dir), /CHANGED since bound/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
