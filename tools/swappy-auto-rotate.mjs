#!/usr/bin/env node
// swappy-auto-rotate — Claude Code Stop hook that rotates to your next saved login
// the moment a usage window (5h or 7d) crosses a threshold. The actual account swap
// is done by swappy, PiXeL16's Claude Code login rotator:
//   https://github.com/PiXeL16/swappy
//
// Data source: a snapshot file your statusline writes each turn from the rate_limits
// payload Claude Code hands it (see README for the four-line snippet). Contract:
//   { "ts": <epoch ms>, "rate_limits": { "five_hour": { "used_percentage": <int>,
//     "resets_at": <epoch sec> }, "seven_day": { ... } } }
//
// Why a Stop hook works mid-session: Claude Code picks up credentials changed on
// disk on the session's next action (its changelog 2.1.186 fixed the stale-cache
// case), so swapping immediately rescues the session that is running hot — no need
// to wait for it to end. If EVERY saved account is over the threshold the post-swap
// snapshot comes back hot next turn; a cooldown stamp caps rotation at one swap per
// SWAPPY_GUARD_COOLDOWN_MIN so exhausted accounts never ping-pong.
//
// Env knobs (all optional):
//   SWAPPY_GUARD_THRESHOLD     trigger % on either window        (default 95)
//   SWAPPY_GUARD_COOLDOWN_MIN  minutes between swaps             (default 15)
//   SWAPPY_BIN                 swappy executable                 (default: from PATH)
//   SWAPPY_GUARD_SNAPSHOT      snapshot path   (default ~/.claude/usage-snapshot.json)
//   SWAPPY_GUARD_STAMP         cooldown stamp  (default ~/.claude/swappy-guard-stamp.json)
//   SWAPPY_GUARD_DRYRUN=1      print the decision instead of swapping

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const THRESHOLD = num(process.env.SWAPPY_GUARD_THRESHOLD, 95);
const COOLDOWN_MIN = num(process.env.SWAPPY_GUARD_COOLDOWN_MIN, 15);
const FAIL_RETRY_MIN = 2; // a failed swap rotated nothing — back off briefly, not the full cooldown
const MAX_SNAP_AGE_MS = 6 * 3600e3; // older = no live session wrote it recently; ignore
const SNAP = process.env.SWAPPY_GUARD_SNAPSHOT || path.join(os.homedir(), ".claude", "usage-snapshot.json");
const STAMP = process.env.SWAPPY_GUARD_STAMP || path.join(os.homedir(), ".claude", "swappy-guard-stamp.json");
const SWAPPY = process.env.SWAPPY_BIN || "swappy";
const DRY = process.env.SWAPPY_GUARD_DRYRUN === "1";

const notify = (msg, urgent = false) => {
  const attempts =
    process.platform === "darwin"
      ? [["osascript", ["-e", `display notification ${JSON.stringify(msg)} with title "swappy-auto-rotate"`]]]
      : [["notify-send", ["-a", "swappy-auto-rotate", ...(urgent ? ["-u", "critical"] : []), "Claude usage", msg]]];
  for (const [cmd, args] of attempts) {
    try { execFileSync(cmd, args, { timeout: 3000, stdio: "ignore" }); return; } catch {}
  }
};

// Never let a stamp problem (read-only dir, full disk) crash a Stop hook.
const writeStamp = (extra = {}) => {
  try {
    writeFileSync(STAMP, JSON.stringify({ atMs: Date.now(), at: new Date().toISOString(), ...extra }));
  } catch {}
};

let snap;
try { snap = JSON.parse(readFileSync(SNAP, "utf8")); } catch { process.exit(0); }
if (!snap?.rate_limits || !Number.isFinite(snap.ts)) process.exit(0);
const age = Date.now() - snap.ts;
if (age > MAX_SNAP_AGE_MS || age < -60e3) process.exit(0); // stale — or from the future (clock skew / garbage)

const nowSec = Date.now() / 1000;
const hot = [];
for (const [label, w] of [["5h", snap.rate_limits.five_hour], ["7d", snap.rate_limits.seven_day]]) {
  // A window is hot only if it is complete AND its reset is still ahead — a past resets_at
  // means the limit reset while idle, and a partial window is no evidence at all.
  if (
    w &&
    Number.isFinite(w.used_percentage) &&
    w.used_percentage >= THRESHOLD &&
    Number.isFinite(w.resets_at) &&
    w.resets_at > nowSec
  ) {
    hot.push(`${label} at ${w.used_percentage}%`);
  }
}
if (!hot.length) process.exit(0);

try {
  const last = JSON.parse(readFileSync(STAMP, "utf8"));
  const waitMin = last.failed ? FAIL_RETRY_MIN : COOLDOWN_MIN;
  if (Number.isFinite(last.atMs) && Date.now() - last.atMs < waitMin * 60e3) {
    if (DRY) console.log("[swappy-auto-rotate] DRYRUN cooldown active, would skip");
    process.exit(0);
  }
} catch {}

if (DRY) {
  console.log(`[swappy-auto-rotate] DRYRUN would SWAP (${hot.join(", ")})`);
  process.exit(0);
}
// Claim the cooldown BEFORE swapping so concurrent sessions' Stop hooks can't both rotate.
writeStamp({ claimed: true });
try {
  const res = execFileSync(SWAPPY, ["next"], { encoding: "utf8", timeout: 10000 });
  writeStamp();
  notify(`${hot.join(", ")} — ${res.trim()} (live on your next action)`);
} catch (e) {
  writeStamp({ failed: true });
  notify(`${hot.join(", ")} — auto-rotate FAILED: ${String(e.stderr || e.message || e).trim().slice(0, 200)}`, true);
}
process.exit(0);
