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
import { join, resolve } from "node:path";
import { resolveMemoryDir } from "./memory-lib.mjs";

// Bound hash: 12 hex minimum (the documented form); longer prefixes of the
// full sha256 are accepted and verified in full.
const BIND_RE = /^\s*-\s*(?:"(\/[^"@]+)"|(\/[^@\s]+))@([0-9a-f]{12,64})\s*$/;

const hashFull = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const args = process.argv.slice(2);

if (args[0] === "--bind") {
  for (const f of args.slice(1)) {
    // The scanner only matches absolute paths, so always emit one.
    const abs = resolve(f);
    try { console.log(`      - ${abs}@${hashFull(abs).slice(0, 12)}`); }
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
      if (!hashFull(target).startsWith(bound))
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
