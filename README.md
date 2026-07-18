# claude-craft

Tooling for [Claude Code](https://claude.com/claude-code)'s file-based memory: a linter, a
pre-flight recall hook, an agent-invokable self-check, and hash-pinned staleness detection.

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

## Tests

```bash
node --test test/memory-suite.test.mjs
```

## License

MIT
