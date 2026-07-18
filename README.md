# claude-craft

Tooling for [Claude Code](https://claude.com/claude-code): memory hygiene (a linter, a pre-flight
recall hook, an agent-invokable self-check, hash-pinned staleness detection), a config-driven
protected-repo push guard, a usage-limit auto-rotate hook (companion to
[swappy](https://github.com/PiXeL16/swappy)), and a delegation skill for orchestrating cheaper
executor CLIs.

Claude Code's auto-memory is a directory of markdown files plus a `MEMORY.md` index. It's great —
until it rots. Links dangle after renames, the index drifts from the files, near-duplicate
memories pile up, and a memory that pins "how `deploy.sh` works" goes silently stale the day
`deploy.sh` changes. And even a healthy store only helps if the agent actually *recalls* the
right memory before acting on a fresh (worse) idea.

These tools attack all four problems. Zero dependencies, plain Node (18+), ESM.

## The tools

| Tool | Runs as | Does |
| --- | --- | --- |
| `memory-lint.mjs` | manual / CI | Reports dangling `[[wikilinks]]`, index drift (broken + orphaned entries), and likely duplicates. |
| `memory-preflight.mjs` | `UserPromptSubmit` hook | Injects strongly-relevant prior memories into context when the **user's prompt** is on-topic. |
| `memcheck.mjs` | invoked by the agent | Scores a **proposed approach** against the store, so a recorded ★decision outranks a fresh idea. |
| `memory-staleness.mjs` | `SessionStart` hook | Recomputes hashes for file-pinned memories and reports only drift. |
| `memory-lib.mjs` | library | Shared parser + scorer the rest import. |

The preflight/memcheck pair matters: a prompt hook only sees the *user's* words, so it can't catch
a mistake born from the agent's own plan. `memcheck` is the other half — tell your agent (in
`CLAUDE.md`) to run it against its own approach before committing to one.

## Install

```bash
git clone https://github.com/VibeCodyH/claude-craft
cp claude-craft/tools/*.mjs ~/.claude/tools/
```

Wire the hooks in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node ~/.claude/tools/memory-preflight.mjs" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node ~/.claude/tools/memory-staleness.mjs" }] }
    ]
  }
}
```

Both hooks are fail-safe: on any error they print nothing and exit 0 — they will never block a
prompt or a session.

## Usage

```bash
# lint the current project's store (or any dir)
node ~/.claude/tools/memory-lint.mjs
node ~/.claude/tools/memory-lint.mjs --json --dir path/to/memory

# self-check an approach before pitching it
node ~/.claude/tools/memcheck.mjs "rewrite the dark mode cards to use a new surface color"

# pin a memory to file contents, then let SessionStart flag drift
node ~/.claude/tools/memory-staleness.mjs --bind src/deploy.sh
#       - /abs/path/src/deploy.sh@1a2b3c4d5e6f   <- paste into the memory under `binds:`
```

## Conventions the tools understand

One memory per file, frontmatter with `name` / `description` / `metadata.type`
(`user | feedback | project | reference`), `[[wikilinks]]` between memories, and a `MEMORY.md`
index of `- [Title](file.md) — hook` lines. A `MEMORY-cold-index.md` is treated as a second,
deliberately-not-resident index tier. `feedback`/`project` memories get a scoring boost — they
carry decisions.

**Hash-pinned binds** — a memory that describes a specific file can pin it:

```yaml
binds:
      - /abs/path/to/file@1a2b3c4d5e6f   # first 12 hex of sha256(contents)
```

**Shared team store** — point `memcheck` at a git repo of memories your team maintains
(`--team <dir>` or `CLAUDE_TEAM_MEMORY_DIR`). Results are tagged `[local]` / `[team]` / `[both]`;
mirrored entries collapse with the team copy winning. Two engineers' Claude instances sharing one
curated store of platform facts works better than it has any right to.

**Domain acronyms** — the scorer drops tokens under 4 chars except a keep-list (`llm ssh api db …`).
Extend it for your domain: `CLAUDE_MEM_KEEP_SHORT="k8s rds sqs"`.

## Protected-repo push guard

`tools/protected-repo-guard.mjs` enforces "the agent may work on this clone locally but NEVER
pushes it" — useful when Claude works on an employer's or teammate's repo where a human must run
every push and open every PR. A prose rule in CLAUDE.md can be argued with; a PreToolUse deny
can't. It catches `git push` (by cwd, `cd` chains, `-C`, slug, or URL), `gh pr create|merge`,
`gh repo sync`, and `gh api` writes — while leaving local commits, branches, and the
issue/comment lane open.

Configure `~/.claude/protected-repos.json`:

```json
[{ "slug": "some-org/their-repo", "dir": "/abs/path/to/local/clone" }]
```

and add it as a `PreToolUse` hook on Bash in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node ~/.claude/tools/protected-repo-guard.mjs" }] }
    ]
  }
}
```

Fail-open by design: no config or a broken config protects nothing rather than bricking every
Bash call. The guard is belt-and-suspenders over your prose rule, not a replacement for it.

## Usage-limit auto-rotate (companion to swappy)

`tools/swappy-auto-rotate.mjs` closes the loop on multi-account usage limits: when either
subscription window (5-hour or 7-day) crosses a threshold (default 95%), a Stop hook rotates you
to your next saved login automatically and sends a desktop notification. The swap itself is done
by **[swappy](https://github.com/PiXeL16/swappy)** — PiXeL16's excellent minimal Claude Code
login rotator. Install and set that up first (`swappy save <name>` per account); this hook is
just the trigger finger.

Two things make the design work:

1. **No polling, no API calls.** Claude Code already hands your statusline the official
   `rate_limits` percentages every turn. Persist them from your statusline command script:

   ```js
   // statusline receives the payload as JSON on stdin — add:
   if (payload.rate_limits) {
     fs.writeFileSync(path.join(os.homedir(), ".claude", "usage-snapshot.json"),
       JSON.stringify({ ts: Date.now(), rate_limits: payload.rate_limits }));
   }
   ```

2. **Mid-session swaps take effect.** Claude Code picks up credentials changed on disk on the
   session's next action (changelog 2.1.186 fixed the stale-cache case), so the hook swaps the
   moment a turn crosses the line — rescuing the session that is running hot, and migrating any
   other running sessions on their next action too.

Register as a `Stop` hook, plus an async `PostToolUse` hook so long turns get rescued mid-turn:

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node ~/.claude/tools/swappy-auto-rotate.mjs", "timeout": 15 }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node ~/.claude/tools/swappy-auto-rotate.mjs", "timeout": 15, "async": true }] }
    ]
  }
}
```

Why both: a Stop hook only fires between turns, and one marathon turn can ride from 90% to a
hard limit without ever reaching Stop (field-tested: 98% before a human noticed). The statusline
snapshot updates *during* turns, so the PostToolUse wiring catches the crossing after the next
tool call; `"async": true` keeps it off the critical path, and the cooldown stamp already
dedups the two wirings.

Guard rails: windows whose `resets_at` already passed are ignored (the limit reset while you
were idle), malformed or >6h-old snapshots are ignored, and when *every* account is over the
threshold a cooldown stamp (default 15 min) stops exhausted accounts from ping-ponging — the
stamp is claimed *before* swapping so concurrent sessions can't double-rotate, and a failed
swap backs off only 2 minutes instead of consuming the full cooldown. All subprocess calls are
timeboxed so the hook can never stall a turn. Tune via `SWAPPY_GUARD_THRESHOLD`,
`SWAPPY_GUARD_COOLDOWN_MIN`, `SWAPPY_BIN`; test decisions safely with `SWAPPY_GUARD_DRYRUN=1`.

## Delegation skill

`skills/delegate/` teaches the agent a fixed division of labor: **Claude plans and reviews,
cheaper executor CLIs (Codex, Copilot, Gemini, Mistral, Grok) do the mechanical building.**
It encodes the trigger test (what to delegate vs keep), the spec → delegate → review loop, and
field-tested gotchas — headless sandbox flags that silently no-op, reviewer models that inflate
findings, refusal profiles that differ by vendor. Install:

```bash
cp -r skills/delegate ~/.claude/skills/
```

## Measured signal/noise

Memory-repo benchmarks (LoCoMo, LongMemEval) measure QA accuracy over long chat histories —
the wrong question for a hook that injects context into a coding agent. What actually matters
there is: does it surface the right memory when the prompt is on-topic, and *stay silent* when
it isn't? So this repo ships a labeled eval instead: a synthetic 18-memory store and 36
developer-realistic queries (24 on-topic incl. hard paraphrases, 12 off-topic), run through the
exact shipped gating code:

| Tier | Recall | False-fire |
| --- | --- | --- |
| `preflight` (hook — every prompt) | 14/24 (58%) | **0/12 (0%)** |
| `memcheck` (agent-invoked) | 20/24 (83%) | 1/12 (8%) |

The asymmetry is the design: the hook fires on every prompt, so it is tuned to never inject
noise; `memcheck` is asked for deliberately, so it trades a little noise for recall. The misses
are paraphrase-heavy queries with few shared tokens — the known ceiling of a lexical scorer,
and the price of zero dependencies. Reproduce with `npm run bench` (`--verbose` lists every
miss); CI floors in the test suite pin false-fire at 0 and recall above 50%/75%.

## Tests

```bash
npm test
```

## License

MIT
