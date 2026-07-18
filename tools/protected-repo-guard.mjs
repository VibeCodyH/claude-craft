#!/usr/bin/env node
// Protected-repo push gate (PreToolUse hook on Bash) — mechanical enforcement
// of "the agent may work on this clone locally but NEVER pushes it".
//
// Local commits, branches, and issue filing stay allowed; the boundary is the
// PUSH. This hook DENIES any Bash command that would push, create a PR, or
// merge against a protected repo — whether by cwd, `cd`/`-C` into the clone,
// repo slug/URL, or `gh -R`. A prose rule in CLAUDE.md can be argued with;
// this can't.
//
// Config: JSON array at ~/.claude/protected-repos.json (override with
// PROTECTED_REPOS_FILE):
//   [{ "slug": "some-org/their-repo", "dir": "/abs/path/to/local/clone" }]
// `slug` is required; `dir` is optional but recommended (catches pushes run
// from inside the clone that never mention the slug).
//
// Fail-open on parse errors: the hook is belt-and-suspenders over the prose
// rule, and a broken hook must never brick every Bash call.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

const HOME = os.homedir();
const CONFIG = process.env.PROTECTED_REPOS_FILE || `${HOME}/.claude/protected-repos.json`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let repos = [];
try {
  repos = JSON.parse(readFileSync(CONFIG, "utf8"))
    .map((r) => {
      const slug = String(r.slug || "").toLowerCase();
      const dir = r.dir
        ? String(r.dir).replace(/^~/, HOME).replace(/\/+$/, "").toLowerCase()
        : null;
      return {
        slug,
        dir,
        slugRe: new RegExp(escapeRe(slug), "i"),
        dirRe: dir ? new RegExp(escapeRe(dir) + `(?=[/"'\\s]|$)`, "i") : null,
      };
    })
    .filter((r) => r.slug);
} catch {
  process.exit(0); // no/broken config -> nothing protected
}

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
const command = String(input?.tool_input?.command || "");
const cwd = String(input?.cwd || process.cwd());
if (!command || !repos.length) process.exit(0);

const underDir = (repo, p) => {
  if (!repo.dir) return false;
  const n = String(p).replace(/["']/g, "").replace(/\/+$/, "").toLowerCase();
  return n === repo.dir || n.startsWith(repo.dir + "/");
};

function deny(repo, what) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Protected-repo guard: ${what} targets ${repo.slug}, which is configured as ` +
        `never-push for the agent (${CONFIG}). Local commits, branches, and issue filing ` +
        `remain allowed — stage the exact push/PR command for a human to run instead.`,
    },
  }));
  process.exit(0);
}

// Walk the chain segment by segment, tracking the effective directory so
// `cd <clone> && git push` and `git -C <clone> push` are both caught.
let dir = cwd;
for (const rawSeg of command.split(/&&|\|\||;|\n/)) {
  // Strip leading subshell/grouping tokens so `(cd <clone> && git push)`
  // doesn't hide the cd from the tracker.
  const seg = rawSeg.trim().replace(/^[({\s]+/, "");
  if (!seg) continue;

  const cd = seg.match(/^cd\s+(?:--\s+)?("[^"]+"|'[^']+'|\S+)/);
  if (cd) {
    const target = cd[1].replace(/["']/g, "");
    dir = target.startsWith("~") ? target.replace("~", HOME) : resolve(dir, target);
    continue;
  }

  for (const repo of repos) {
    const segMentions = repo.slugRe.test(seg) || (repo.dirRe && repo.dirRe.test(seg));

    // git ... push (flags, -C <path>, -c k=v allowed between "git" and "push")
    const git = seg.match(/\bgit\b((?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--[\w-]+(?:=\S+)?|-\w+))*)\s+push\b/i);
    if (git) {
      const dashC = git[1] && git[1].match(/-C\s+("[^"]+"|'[^']+'|\S+)/);
      const gitDir = dashC
        ? resolve(dir, dashC[1].replace(/["']/g, "").replace(/^~/, HOME))
        : dir;
      if (underDir(repo, gitDir) || segMentions) deny(repo, "`git push`");
    }

    // gh pr create|merge / gh repo sync — repo from -R slug, or inferred from
    // dir. Flags may sit between the command group and the verb
    // (`gh pr -R org/repo create`), so don't require them contiguous.
    if (/\bgh\s+pr\b[^\n]*\b(create|merge)\b/i.test(seg) || /\bgh\s+repo\b[^\n]*\bsync\b/i.test(seg)) {
      if (segMentions || underDir(repo, dir)) deny(repo, "`gh pr/repo` write");
    }

    // gh api writes against the repo (issue/comment/label lane stays open)
    if (/\bgh\s+api\b/i.test(seg) && repo.slugRe.test(seg)) {
      const isWrite = /(?:-X|--method)[=\s]+(POST|PUT|PATCH|DELETE)\b/i.test(seg) || /\s(-f|-F|--field|--raw-field)[=\s]/.test(seg);
      const issueLane = /\/(issues|comments|labels)\b/i.test(seg);
      if (isWrite && !issueLane) deny(repo, "`gh api` write");
    }
  }
}

process.exit(0);
