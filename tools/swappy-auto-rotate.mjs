#!/usr/bin/env node
// swappy-auto-rotate — Claude Code hook (Stop + async PostToolUse; see README) that
// rotates to your next saved login the moment a usage window (5h or 7d) crosses a
// threshold — mid-turn included. The actual account swap is done by swappy,
// PiXeL16's Claude Code login rotator:
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
// to wait for it to end.
//
// ★ It picks WHERE to go, it does not just rotate. `swappy next` is a blind
// round-robin: the snapshot describes only the account you are on, so rotating on
// it alone will happily move you from an account with hours of 5h headroom onto one
// that is 100% capped and kill the turn. (Observed 2026-07-26: work at 7d 96% but
// 5h 9% got rotated onto a 5h-exhausted personal.) So this keeps a per-profile
// ledger of the last usage seen for each login, and swaps with `swappy use <name>`
// to the best account that is actually known to be healthy.
//
// The rule that follows from that, and the one worth keeping: an UNKNOWN profile is
// only worth gambling on when you are truly stuck. If the current account still has
// a live 5h window, a swap only happens to a profile the ledger knows is healthy —
// being 7d-hot is not a reason to trade a working session for a coin flip. When
// nothing beats where you are, it stays put and tells you when things reset.
//
// Env knobs (all optional):
//   SWAPPY_GUARD_THRESHOLD     trigger % on either window        (default 95)
//   SWAPPY_GUARD_COOLDOWN_MIN  minutes between swaps             (default 15)
//   SWAPPY_BIN                 swappy executable                 (default: from PATH)
//   SWAPPY_GUARD_SNAPSHOT      snapshot path   (default ~/.claude/usage-snapshot.json)
//   SWAPPY_GUARD_STAMP         cooldown stamp  (default ~/.claude/swappy-guard-stamp.json)
//   SWAPPY_GUARD_LEDGER        per-profile usage (default ~/.claude/swappy-usage-by-profile.json)
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
const LEDGER = process.env.SWAPPY_GUARD_LEDGER || path.join(os.homedir(), ".claude", "swappy-usage-by-profile.json");
const SWAPPY = process.env.SWAPPY_BIN || "swappy";
const DRY = process.env.SWAPPY_GUARD_DRYRUN === "1";
// A reading older than this says nothing about an account today. Windows carry their
// own resets_at, so this only has to outlive the longer one.
const LEDGER_MAX_AGE_MS = 8 * 24 * 3600e3;
// `swappy ls` on every PostToolUse would be a subprocess per tool call. Usage does
// not move that fast; the decision path below always probes fresh regardless.
const PROBE_MIN_MS = 60e3;
// Only attribute a snapshot to the active profile if the reading is fresh. A stale
// one recorded against whoever is active NOW is how a dead account gets filed as healthy.
const RECORD_MAX_AGE_MS = 5 * 60e3;
// After a swap, Claude Code has not re-read credentials yet and the statusline is
// still reporting the OLD account. Recording during that window would file the
// account we just fled from as the new one's usage — the exact inversion.
const POST_SWAP_QUIET_MS = 2 * 60e3;

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
// A window is hot only if it is complete AND its reset is still ahead — a past
// resets_at means the limit reset while idle, and a partial window is no evidence at
// all. Applied to ledger entries too, so a recorded 100% that has since reset stops
// counting against a profile without needing to have been active to observe it.
const isHot = (w) =>
  !!w &&
  Number.isFinite(w.used_percentage) &&
  w.used_percentage >= THRESHOLD &&
  Number.isFinite(w.resets_at) &&
  w.resets_at > nowSec;

const windows = (rl) => [
  ["5h", rl?.five_hour],
  ["7d", rl?.seven_day],
];
const hot = windows(snap.rate_limits)
  .filter(([, w]) => isHot(w))
  .map(([label, w]) => `${label} at ${w.used_percentage}%`);

// ---- per-profile ledger -------------------------------------------------------
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const led = readJson(LEDGER) || {};
if (!led.profiles || typeof led.profiles !== "object") led.profiles = {};

// `swappy ls` prints "%s %-16s %s\n" of marker, name, email. Marker is '*' when active.
const roster = () => {
  let out;
  try { out = execFileSync(SWAPPY, ["ls"], { encoding: "utf8", timeout: 10000 }); } catch { return null; }
  const names = [];
  let active = null;
  for (const line of out.split("\n")) {
    const m = line.match(/^([* ]) (\S+)(?:\s|$)/);
    if (!m) continue;
    names.push(m[2]);
    if (m[1] === "*") active = m[2];
  }
  return names.length ? { names, active } : null;
};

const snapAge = Date.now() - snap.ts;
const probeStale = !Number.isFinite(led.probedAt) || Date.now() - led.probedAt > PROBE_MIN_MS;
// The decision path always probes fresh: picking a destination off a minute-old
// roster is the one place a wrong answer costs a turn.
const r = hot.length || probeStale ? roster() : null;

if (r?.active && snapAge < RECORD_MAX_AGE_MS && !(Number.isFinite(led.quietUntil) && Date.now() < led.quietUntil)) {
  led.profiles[r.active] = { ts: snap.ts, five_hour: snap.rate_limits.five_hour, seven_day: snap.rate_limits.seven_day };
  led.probedAt = Date.now();
  try { writeFileSync(LEDGER, JSON.stringify(led, null, 2)); } catch {}
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

// ---- where to go --------------------------------------------------------------
if (!r) {
  // No roster means swappy is missing or broken. `next` would be a blind guess.
  if (DRY) console.log("[swappy-auto-rotate] DRYRUN no roster from swappy, would skip");
  else { writeStamp({ failed: true }); notify(`${hot.join(", ")} — cannot read swappy profiles; not swapping`, true); }
  process.exit(0);
}

const clock = (sec) =>
  Number.isFinite(sec) ? new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?";

const healthy = [];
const unknown = [];
const blocked = [];
for (const name of r.names) {
  if (name === r.active) continue;
  const e = led.profiles[name];
  if (!e || !Number.isFinite(e.ts) || Date.now() - e.ts > LEDGER_MAX_AGE_MS) { unknown.push(name); continue; }
  const eh = windows(e).filter(([, w]) => isHot(w));
  if (eh.length) {
    blocked.push(`${name} (${eh.map(([l, w]) => `${l} ${w.used_percentage}%, back ${clock(w.resets_at)}`).join("; ")})`);
  } else {
    // Rank by 5h headroom: that is the window that ends a session today.
    healthy.push({ name, pct: Number.isFinite(e.five_hour?.used_percentage) ? e.five_hour.used_percentage : 100 });
  }
}
healthy.sort((a, b) => a.pct - b.pct);

// ★ Gamble on an unknown profile only when the current 5h window is itself dead.
// 7d-hot with a live 5h means the session still works, and trading that for an
// account nobody has measured is how this hook used to break a running turn.
const stuck = isHot(snap.rate_limits.five_hour);
const target = healthy[0]?.name || (stuck ? unknown[0] : undefined);

if (!target) {
  const why = stuck
    ? `every account is capped${blocked.length ? ": " + blocked.join(", ") : ""}`
    : `staying on ${r.active}: 5h still live, and nothing else is known-healthy`;
  if (DRY) { console.log(`[swappy-auto-rotate] DRYRUN would STAY (${hot.join(", ")}) — ${why}`); process.exit(0); }
  writeStamp({ stayed: true });
  // ★ Only speak up when you are actually stuck. Staying on a 7d-hot account whose
  // 5h window is fine is the CORRECT outcome and nothing is wrong, so saying it
  // every cooldown period is pure nagging. Being capped with nowhere to go is news.
  if (stuck) notify(`${hot.join(", ")} — ${why}`, true);
  process.exit(0);
}

const via = healthy.length ? "known healthy" : "unmeasured, but you are capped anyway";
if (DRY) {
  console.log(`[swappy-auto-rotate] DRYRUN would SWAP (${hot.join(", ")}) ${r.active} -> ${target} [${via}]`);
  process.exit(0);
}
// Claim the cooldown BEFORE swapping so concurrent sessions' Stop hooks can't both rotate.
writeStamp({ claimed: true });
try {
  const res = execFileSync(SWAPPY, ["use", target], { encoding: "utf8", timeout: 10000 });
  writeStamp();
  led.quietUntil = Date.now() + POST_SWAP_QUIET_MS;
  try { writeFileSync(LEDGER, JSON.stringify(led, null, 2)); } catch {}
  notify(`${hot.join(", ")} — ${res.trim() || `switched to ${target}`} (live on your next action)`);
} catch (e) {
  writeStamp({ failed: true });
  notify(`${hot.join(", ")} — auto-rotate FAILED: ${String(e.stderr || e.message || e).trim().slice(0, 200)}`, true);
}
process.exit(0);
