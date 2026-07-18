#!/usr/bin/env node
// Memory staleness check (SessionStart hook) — hash-bound file bindings.
// A memory that pins a specific file adds bind lines (in frontmatter metadata
// or body):
//     binds:
//       - /abs/path/to/file@1a2b3c4d5e6f      <- first 12 hex of sha256(contents)
// Default mode scans the memory dir, recomputes hashes, and prints ONLY drift
// (silent when everything is fresh, so SessionStart stays quiet).
//   --bind <file...>   print ready-to-paste bind lines for the given files
//   --dir <path>       override the memory dir
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveMemoryDir } from "./memory-lib.mjs";

const BIND_RE = /^\s*-\s*(?:"(\/[^"@]+)"|(\/[^@\s]+))@([0-9a-f]{8,64})\s*$/;

const hash12 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);

const args = process.argv.slice(2);

if (args[0] === "--bind") {
  for (const f of args.slice(1)) {
    try { console.log(`      - ${f}@${hash12(f)}`); }
    catch { console.error(`cannot read: ${f}`); process.exitCode = 1; }
  }
  process.exit();
}

const dirIdx = args.indexOf("--dir");
const dir = dirIdx !== -1 ? args[dirIdx + 1] : resolveMemoryDir();

let files;
try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); }
catch { process.exit(0); } // no memory dir -> nothing to check

const drift = [];
for (const mem of files) {
  let lines;
  try { lines = readFileSync(join(dir, mem), "utf8").split("\n"); } catch { continue; }
  for (const line of lines) {
    const m = line.match(BIND_RE);
    if (!m) continue;
    const [, quoted, bare, bound] = m;
    const target = quoted || bare;
    try {
      const now = hash12(target);
      if (!now.startsWith(bound.slice(0, 12)) && !bound.startsWith(now))
        drift.push(`${mem}: ${target} CHANGED since bound — verify the memory, then rebind`);
    } catch {
      drift.push(`${mem}: ${target} MISSING — memory references a deleted/moved file`);
    }
  }
}

if (drift.length) {
  console.log("⚠️ [memory-staleness] bound files drifted (rebind: node memory-staleness.mjs --bind <file>):");
  for (const d of drift) console.log(`  - ${d}`);
}
