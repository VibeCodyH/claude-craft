# claude-craft

Hooks, tools, and one skill for [Claude Code](https://claude.com/claude-code), covering the four
things that quietly cost the most: a memory store that rots, subagent fan-out that eats a usage
window, bulk work sent to an expensive model, and an agent pushing to a repo it should not.

Zero dependencies, plain Node (18+), ESM.

## Quick start

**On macOS, install the two prerequisites first.** `agentcall` is the one bash script here and it
needs bash 4+; macOS ships 3.2, where expanding an empty array under `set -u` is a fatal error.
Two adapters parse JSON output with `jq`. Everything else is Node and works as-is.

```bash
brew install bash jq
```

```bash
git clone https://github.com/VibeCodyH/claude-craft
cd claude-craft
node install.mjs --dry-run     # show the plan
node install.mjs               # copy the tools, merge the hook wiring
```

The installer reads your existing `~/.claude/settings.json`, adds only the hook entries that are
missing, and writes one timestamped backup before its first change. Re-running it is a no-op. If
the file is not valid JSON it stops and tells you, rather than replacing config it cannot read.

Install a subset by name, and remove the wiring the same way:

```bash
node install.mjs --list
node install.mjs memory delegation
node install.mjs --uninstall rotate
```

Restart Claude Code afterward to pick up the hooks.

## What's in it

| Component | Runs as | Does |
| --- | --- | --- |
| `memory` | hooks + CLI | Lint, recall, and staleness detection for the auto-memory store. |
| `delegation` | hooks | Caps subagent fan-out; nudges mechanical sweeps toward a cheaper executor. |
| `agentcall` | CLI | One calling convention for every agent CLI you have installed. |
| `crunch` | CLI + library | Bulk LLM lane: strongest free cloud model first, your own box as the floor. |
| `protected-repos` | hook | Blocks pushes and PRs on repos where a human runs every push. |
| `rotate` | hooks | Swaps logins at a usage threshold, via [swappy](https://github.com/PiXeL16/swappy). |
| `skills` | skill | `delegate`: when to hand work to an executor, and how. |

## Memory

Claude Code's auto-memory is a directory of markdown files plus a `MEMORY.md` index. It's great —
until it rots. Links dangle after renames, the index drifts from the files, near-duplicate
memories pile up, and a memory that pins "how `deploy.sh` works" goes silently stale the day
`deploy.sh` changes. And even a healthy store only helps if the agent actually *recalls* the
right memory before acting on a fresh (worse) idea.

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

Both hooks are fail-safe: on any error they print nothing and exit 0. They will never block a
prompt or a session.

### Measured signal/noise

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

### Conventions the tools understand

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

## Delegation

Two failures cost real money, and both are reflexes rather than decisions. The first: a task looks
parallel, so the agent spawns five subagents, each starting cold and re-deriving context the parent
already had. The second: the agent hand-edits forty files itself, one at a time, while an executor
CLI sits idle on its own quota.

`delegation-guard.mjs` (PreToolUse on `Agent` and `Workflow`) puts two hard caps on the first, in a
rolling window:

- **Overall:** at most 4 subagents per 10 minutes.
- **Premium:** at most 2 expensive-model subagents in the same window.

The premium cap is the one that earns its keep. A spawn with no explicit `model` on the default
agent type inherits the parent's model, which is normally the most expensive one you run, so an
unqualified spawn counts as premium. Named specialist types with no model are exempt, because they
carry their own default. A refused spawn is not recorded, so being stopped never extends the window.

`delegation-nudge.mjs` (PostToolUse on edits) handles the second. When the main loop touches 3
distinct files in 5 minutes, it prints a ready-to-run executor command for the rest of the sweep.
It never blocks. It stays silent inside any repo listed in `protected-repos.json`, on the theory
that a repo you must push by hand is a repo whose edits you want to have read yourself.

Every threshold is an environment variable. Defaults in parentheses:

```
CLAUDE_DELEGATION_CAP (4)          CLAUDE_NUDGE_FILES (3)
CLAUDE_DELEGATION_PREMIUM_CAP (2)  CLAUDE_NUDGE_WINDOW_MIN (5)
CLAUDE_DELEGATION_WINDOW_MIN (10)  CLAUDE_NUDGE_COOLDOWN_MIN (8)
CLAUDE_PREMIUM_MODELS (opus,fable) CLAUDE_NUDGE_SKIP (colon-separated paths)
CLAUDE_WORKFLOW_POLICY (ask)       CLAUDE_NUDGE_CMD (codex)
CLAUDE_EXECUTORS (named in the refusal message)
```

`CLAUDE_WORKFLOW_POLICY=ask` is the default because a workflow's own `agent()` calls fan out
subagents, and a stock research workflow can spawn dozens of them before anyone notices. Set it to
`deny` or `allow` once you know which workflows you run.

### agentcall

Every agent CLI has a different flag for "yes, you may use your tools" and a different way of
emitting its final answer. Getting one of those wrong does not produce an error. It produces a
confident review of a diff the model never opened. `bin/agentcall` normalizes them:

```bash
agentcall codex -d ~/src/app -m ro < review-prompt.md   # same shape for every agent
agentcall --probe                    # which CLIs are installed and authenticated
agentcall --list                     # what each is good for, and its known traps
agentcall --print-command grok -d . "hi"   # inspect the invocation, run nothing
agentcall --new mytool               # scaffold an adapter for a new CLI
```

It ships adapters for codex, claude, grok, kimi, vibe, glm, agy, opencode, copilot, and
coderabbit. Each one encodes a trap found by hitting it:

- **codex** streams its entire reasoning trace without `-o FILE`. One 4-file PR produced 152KB.
- **grok**'s `-p` is `--single` and consumes the next argument, so the prompt has to go last.
  Without `--always-approve` its tool calls are cancelled silently, and the partial narration
  reads exactly like a short bad review.
- **opencode** denies tool calls without `--auto`, with the same failure mode.
- **coderabbit** exits 0 whether it found problems or never ran. Read the `type:"complete"` record.
- **agy** auto-denies its own tools, so it can never fetch its own input, and refuses any
  security-framed prompt. It is a decent text cruncher on stdin and not a reviewer.

`--print-command` exists because every one of those bugs was invisible until something downstream
looked wrong. A new CLI is a drop-in file at `~/.config/agentcall/agents.d/<name>.sh`, not a patch
to the script. A drop-in whose name matches a builtin overrides it, which is how you fix a recipe
that upstream changed.

The `delegate` skill in `skills/` is the policy layer over all of this: what to hand off, what to
keep, how to write the spec, and how to review what comes back.

## crunch

A lot of what gets pushed through a coding agent is not reasoning. It is summarize this transcript,
classify these 400 rows, extract fields from this dump. That work wants a cheap model, and several
vendors give away a good one. `crunch` walks them in order and falls through to a local
OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM) when every cloud tier is missing,
capped, or down.

```bash
crunch "write a one-line commit message for: added retry backoff"
git log --oneline -50 | crunch --task summarize
crunch --task classify --json "<text>"
crunch --local "<sensitive text>"        # your box only, nothing leaves the machine
crunch --models cerebras                 # list the model ids a provider really serves
```

Chain: `openrouter → cerebras → groq → zai → mistral → cloudflare → local`. A provider with no key
is skipped, so one key is enough to start. A provider that returns 429 is skipped for the rest of
the run rather than costing a round trip on every remaining call of a bulk job. Every attempt logs
to stderr, so a chain that is quietly landing on the local floor looks different from one that is
working. Copy `crunch.env.example` to `~/.config/claude-craft/crunch.env` and fill in what you have.

Free model slugs rotate. A slug that stops being free returns 404, which cascades to the next
provider instead of failing loudly, so a chain can quietly get slower without breaking. Run
`crunch --models openrouter | grep ':free'` and update `CRUNCH_OPENROUTER_MODEL` when that happens.
GitHub Models was in this chain until 2026-08-07 and is not any more: its endpoint now answers 410
`github_models_retirement_brownout`. It was the best entry while it lasted, because it reused your
`gh auth login` token and needed no key.

**On the redactor.** Input is scrubbed for credential shapes before any cloud request: API keys,
tokens, JWTs, private key blocks, connection strings, and `NAME=value` pairs whose name says
credential. It is not a PII scrubber and will not catch names, emails, addresses, or account
numbers. There is a test asserting that, so the limit stays honest. For real PII use `--local`,
which skips both the cloud chain and the redactor, because scrubbing would gut the data you kept
local in order to work on.

Point `CRUNCH_SCRUB_MODULE` at your own ESM module exporting `scrub(text) -> { text, redactions }`
to substitute a better one. If it fails to load or throws, crunch falls through to the local floor
rather than sending text the intended guard never inspected.

Importable as a library from the checkout: `import { crunch } from "<checkout>/tools/crunch.mjs"`.
The installer puts the CLI on your PATH and deliberately does not keep a second copy under
`~/.claude/tools`, because two copies of the same file drift apart.

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

Fail-open by design: no config or a broken config protects nothing rather than bricking every
Bash call. The guard is belt-and-suspenders over your prose rule, not a replacement for it.

## Usage-limit auto-rotate

`tools/swappy-auto-rotate.mjs` closes the loop on multi-account usage limits: when either
subscription window (5-hour or 7-day) crosses a threshold (default 95%), a Stop hook rotates you
to your next saved login automatically and sends a desktop notification. The swap itself is done
by **[swappy](https://github.com/PiXeL16/swappy)** — PiXeL16's excellent minimal Claude Code
login rotator. Install and set that up first (`swappy save <name>` per account); this hook is
just the trigger finger.

Three things make the design work:

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

3. **It picks a destination instead of rotating blindly.** The snapshot only describes the
   account you are *on*, so `swappy next` can move you from an account with hours of 5-hour
   headroom onto one that is 100% capped and kill the turn. (Observed: work at 7d 96% but 5h 9%,
   rotated onto a 5h-exhausted personal.) The hook keeps a per-profile ledger of the last usage
   seen for each login — it is running every turn anyway — and swaps with `swappy use <name>` to
   the account it knows is healthy.

   The rule that falls out of that is worth stating on its own: **an unmeasured account is only
   worth gambling on when you are already stuck.** If your current 5-hour window is still live,
   the hook only swaps to a profile the ledger knows is healthy; being 7-day-hot is not a reason
   to trade a working session for a coin flip. When nothing beats where you are it stays put, and
   says so *only* if you are genuinely capped — a correct "everything still works" is not worth a
   notification every cooldown period.

The installer wires it as both a `Stop` hook and an async `PostToolUse` hook. Why both: a Stop hook
only fires between turns, and one marathon turn can ride from 90% to a hard limit without ever
reaching Stop (field-tested: 98% before a human noticed). The statusline snapshot updates *during*
turns, so the PostToolUse wiring catches the crossing after the next tool call; `"async": true`
keeps it off the critical path, and the cooldown stamp already dedups the two wirings.

Guard rails: windows whose `resets_at` already passed are ignored (the limit reset while you
were idle), malformed or >6h-old snapshots are ignored, and when *every* account is over the
threshold a cooldown stamp (default 15 min) stops exhausted accounts from ping-ponging — the
stamp is claimed *before* swapping so concurrent sessions can't double-rotate, and a failed
swap backs off only 2 minutes instead of consuming the full cooldown. All subprocess calls are
timeboxed so the hook can never stall a turn.

The ledger has its own rails, because a wrong entry there sends you to a dead account: a reading
is only filed against the active profile if the snapshot is under 5 minutes old, recording pauses
for 2 minutes after a swap (Claude Code has not re-read credentials yet, so the statusline is
still reporting the account you just left), entries older than 8 days stop counting as evidence,
and a recorded cap whose `resets_at` has since passed stops counting against that profile without
needing to have been active to observe it. If `swappy ls` cannot be read at all the hook refuses
to swap rather than guess. Tune via `SWAPPY_GUARD_THRESHOLD`, `SWAPPY_GUARD_COOLDOWN_MIN`,
`SWAPPY_GUARD_LEDGER`, `SWAPPY_BIN`; test decisions safely with `SWAPPY_GUARD_DRYRUN=1`.

## Manual install

If you would rather not run the installer, copy what you want and wire it yourself:

```bash
cp claude-craft/tools/*.mjs ~/.claude/tools/
cp -r claude-craft/skills/delegate ~/.claude/skills/
cp claude-craft/bin/agentcall claude-craft/tools/crunch.mjs ~/.local/bin/
```

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/.claude/tools/memory-preflight.mjs" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/.claude/tools/memory-staleness.mjs" }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node /abs/path/.claude/tools/protected-repo-guard.mjs" }] },
      { "matcher": "Agent|Workflow", "hooks": [{ "type": "command", "command": "node /abs/path/.claude/tools/delegation-guard.mjs" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "node /abs/path/.claude/tools/delegation-nudge.mjs" }] },
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node /abs/path/.claude/tools/swappy-auto-rotate.mjs", "timeout": 15, "async": true }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /abs/path/.claude/tools/swappy-auto-rotate.mjs", "timeout": 15 }] }
    ]
  }
}
```

Use absolute paths. `~` in a hook command is not expanded on every platform, and a hook that fails
to run fails silently.

## Tests

```bash
npm test
npm run bench
```

## License

MIT
