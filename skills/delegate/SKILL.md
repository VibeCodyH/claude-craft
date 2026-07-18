---
name: delegate
description: Offload builds, grunt work, and second-opinion reviews to executor CLIs — Codex (`codex exec`), Copilot (`copilot -p`), Gemini/Antigravity (`agy -p`), Mistral (`vibe --prompt`), Grok (`grok -p`) — while Claude plans and reviews. DEFAULT to delegating mechanical / multi-file / parallelizable work and fresh cross-model reviews; ROTATE workers.
---

# Delegate: Claude plans, executors build, Claude reviews

Claude is the expensive, smart loop — spend it on **judgment**: the spec, the architecture call,
the review, the integration. The mechanical hands — boilerplate, the same refactor across 30
files, a first-draft test suite — are work cheaper agentic CLIs can do on their own quota while
Claude keeps thinking. The deal is fixed: **you plan, they execute, you review.** Never ship an
executor's output unread.

Adapt the executor list to whatever CLIs are installed; the loop is the point, not the roster.

## Fast path (pick a command NOW — don't re-read the whole doc)

If this loaded because work is delegatable, choose one and fire it, then review the output:

- **Build (scoped):** `codex exec -s workspace-write -C <repo> - < promptfile`
  (rotate: `copilot -p "<spec>" --allow-all-tools`, `agy -p "<spec>" --dangerously-skip-permissions`,
  or `grok -p "<spec>" --cwd <repo> --allow 'Edit' --allow 'Read' --allow 'Bash(<test cmd>)'`)
- **Map / read-only exploration:** `codex exec -s read-only -C <repo> - < promptfile`
- **Fresh second-opinion review:** `grok -p "<review prompt>" --cwd <repo> --disallowed-tools 'edit,write,bash'`
  (or `vibe --prompt "<review>" --enabled-tools read --max-turns 3`, or `agy -p "<review — read-only>"`)
- **Prompt delivery:** write the prompt to a file and feed it on **stdin** (`-` for codex) — a
  long/multi-line prompt as a shell arg breaks on quotes/`$`/newlines. Set the working dir
  explicitly (`-C` / `--cwd` / `cd` first) or you get an untrusted-dir refusal.
- **Rotate** across executors; **≤2 parallel** jobs unless slices are truly independent.

Then Claude reviews the diff/output before anything ships.

## When to delegate (the trigger test)

**Delegate** when the work is bulk, mechanical, or parallelizable, OR you want independent eyes:

- Scaffolding, boilerplate, repetitive refactors across many files
- First-draft test suites, format/data conversions, codemods
- Broad exploration you'd otherwise fan out to subagents
- A **second-opinion code review** before anything ships — a different model's eyes catch
  different bugs

**Do NOT delegate** — keep it in Claude's own loop:

- Repos configured as protected/never-push (see `protected-repo-guard.mjs` in this repo) —
  executors don't get write access to code the agent itself isn't trusted to push
- Architecture decisions, anything needing real judgment, security / production-write paths
- Tasks small enough that writing the spec costs more than just doing it

## The loop

1. **Plan (Claude).** Write a TIGHT spec — the spec *is* the contract; vague spec = garbage out.
   Include exact files to touch, **acceptance criteria / the success test**, constraints, and an
   explicit "do NOT touch X." This is the judgment work; don't delegate it.
2. **Delegate.** Hand the spec to the right executor with the correct cwd + approval mode. Big or
   slow → run it in the background and keep moving; collect when done. Don't babysit.
3. **Review (Claude) — never skipped.** Read the `git diff`, run the build + tests, audit against
   the spec.
4. **Iterate.** Feed findings back — resume the session or fire a fresh run with the diff attached.

## Picking builder vs reviewer

- **Small/precise edit:** Claude specs → an executor builds → Claude reviews. Don't do it solo by
  reflex just because it's small — that's the habit this skill exists to break.
- **Build:** rotate the builder; add a *different* executor as second reviewer on high-stakes
  changes (cross-model catches more).
- **Review-only:** run two independent opinions (different models), then Claude synthesizes.
- **Divvy-up (bigger work):** Claude plans → independent slices to different executors in
  parallel → they cross-review → Claude reviews the reviews.
- **One builder, one reviewer** — don't fan the same build to two executors and merge blindly.

## Field-tested gotchas (verify against your versions)

- **Promptfiles beat inline args:** multi-line prompts as shell arguments break on quoting.
  Feed the file via stdin where the CLI supports it (codex's `-`), or pipe it (`cat spec.md | agy -p ...`).
- **Headless sandbox flags can silently no-op.** Grok's `--sandbox` logs a warning and runs
  unsandboxed when there's no controlling terminal — gate with `--allow` / `--disallowed-tools`
  instead of trusting a sandbox flag in headless mode. Test your executor's isolation before
  relying on it.
- **Executors fail loudly at call time** (quota, auth) — don't pre-check; fall back to another
  executor or do it solo. Expect flakes: an empty report with exit 0 happens; treat "no findings"
  from a reviewer that shows no evidence of reading files as a failed run, not a clean bill.
- **Refusal profiles differ by vendor.** Some models refuse security-audit prompts outright;
  others do defensive audits happily but hard-refuse exploit PoCs. Learn each executor's line
  before routing security work; keep a working note of who refuses what.
- **Reviewer inflation is real.** Some models over-flag (e.g. calling a parameterized query SQL
  injection) — verify every delegated finding before repeating it as your own.
- **Never let an executor autonomously ship a write** (push, PR, issue-close). Scoped builds
  that Claude gates before anything lands; review lanes get read-only tool sets.
- **Secrets never go in a delegated prompt** — the executor CLI runs locally, but its prompt and
  output transit a third-party API.

## Making it stick (optional hooks)

A skill is advice; hooks make it a default. Pair this with:

- a **PostToolUse nudge** that fires when the main loop hand-edits N files in a few minutes and
  prints a ready-to-run executor command, and
- a **PreToolUse cap** that denies the Nth parallel subagent spawn, forcing the overflow to
  cheaper executors.

Both are straightforward to write against the hook JSON contract; `protected-repo-guard.mjs` in
this repo shows the deny-response shape.
