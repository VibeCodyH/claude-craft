import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, "..", "tools", "swappy-auto-rotate.mjs");

const dir = mkdtempSync(join(tmpdir(), "swappy-guard-"));
const snapPath = join(dir, "snapshot.json");
const stampPath = join(dir, "stamp.json");
const ledgerPath = join(dir, "ledger.json");
const swappyPath = join(dir, "swappy");

// A stub swappy. MUST be wired in every run: without it the guard shells out to the
// real one and the tests would read, and record into, the developer's live logins.
// Output matches swappy's own `printf '%s %-16s %s\n'` marker/name/email.
writeFileSync(
  swappyPath,
  `#!/bin/sh
case "$1" in
  ls) printf '%s %-16s %s\\n' "*" "work" "w@x.com"; printf '%s %-16s %s\\n' " " "personal" "p@x.com" ;;
  use) echo "switched to $2" ;;
esac
`,
);
chmodSync(swappyPath, 0o755);

const snapshot = ({ ts = Date.now(), fiveHour, sevenDay } = {}) =>
  JSON.stringify({ ts, rate_limits: { five_hour: fiveHour, seven_day: sevenDay } });

const win = (pct, resetsInSec = 7200) => ({
  used_percentage: pct,
  resets_at: Math.floor(Date.now() / 1000) + resetsInSec,
});

// Ledger entry for a profile the guard has "seen" before.
const seen = (name, fiveHour, sevenDay = win(10), ts = Date.now()) =>
  writeFileSync(ledgerPath, JSON.stringify({ profiles: { [name]: { ts, five_hour: fiveHour, seven_day: sevenDay } } }));

const run = (extraEnv = {}) =>
  execFileSync(process.execPath, [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      SWAPPY_GUARD_DRYRUN: "1",
      SWAPPY_GUARD_SNAPSHOT: snapPath,
      SWAPPY_GUARD_STAMP: stampPath,
      SWAPPY_GUARD_LEDGER: ledgerPath,
      SWAPPY_BIN: swappyPath,
      ...extraEnv,
    },
  });

const fresh = () => { rmSync(stampPath, { force: true }); rmSync(ledgerPath, { force: true }); };

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("cool windows: silent no-op", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ fiveHour: win(8), sevenDay: win(1) }));
  assert.equal(run(), "");
});

test("hot 5h window triggers a swap", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ fiveHour: win(97), sevenDay: win(40) }));
  assert.match(run(), /would SWAP \(5h at 97%\)/);
});

// ★ The bug this file's rewrite exists for. 7d-hot with a LIVE 5h window means the
// session still works. Rotating onto an account nobody has measured is a coin flip
// that cost a turn on 2026-07-26, so it now takes a known-healthy destination.
test("hot 7d alone + unmeasured destination: stays put", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ fiveHour: win(9), sevenDay: win(96) }));
  const out = run();
  assert.match(out, /would STAY \(7d at 96%\)/);
  assert.match(out, /5h still live/);
});

test("hot 7d alone + known-healthy destination: swaps to it by name", () => {
  fresh();
  seen("personal", win(12), win(30));
  writeFileSync(snapPath, snapshot({ fiveHour: win(9), sevenDay: win(96) }));
  assert.match(run(), /would SWAP \(7d at 96%\) work -> personal \[known healthy\]/);
});

test("5h dead + destination known capped: stays, and says when it is back", () => {
  fresh();
  seen("personal", win(100, 2400));
  writeFileSync(snapPath, snapshot({ fiveHour: win(99), sevenDay: win(96) }));
  const out = run();
  assert.match(out, /would STAY/);
  assert.match(out, /every account is capped/);
  assert.match(out, /personal \(5h 100%, back \d/);
});

// Being stuck is what makes an unknown account worth the gamble: nothing to lose.
test("5h dead + unmeasured destination: gamble is allowed", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ fiveHour: win(99), sevenDay: win(96) }));
  assert.match(run(), /would SWAP .* work -> personal \[unmeasured/);
});

// A recorded 100% whose window has since reset must stop counting against a profile.
// Otherwise an account is written off until it next happens to be active.
test("destination's recorded cap has since reset: healthy again", () => {
  fresh();
  seen("personal", win(100, -600), win(40), Date.now() - 2 * 3600e3);
  writeFileSync(snapPath, snapshot({ fiveHour: win(99), sevenDay: win(96) }));
  assert.match(run(), /would SWAP .* -> personal \[known healthy\]/);
});

test("a ledger entry older than 8 days is not evidence", () => {
  fresh();
  seen("personal", win(100, 2400), win(99), Date.now() - 9 * 24 * 3600e3);
  writeFileSync(snapPath, snapshot({ fiveHour: win(99), sevenDay: win(96) }));
  assert.match(run(), /would SWAP .* -> personal \[unmeasured/);
});

test("the active profile's usage is recorded under its own name", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ fiveHour: win(8), sevenDay: win(1) }));
  run();
  const led = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(led.profiles.work.five_hour.used_percentage, 8);
  assert.equal(led.profiles.personal, undefined);
});

// ★ A stale reading attributed to whoever is active NOW is how a dead account gets
// filed as healthy. Two minutes of snapshot age is fine; an hour is not evidence.
test("a stale snapshot is not recorded against the active profile", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ ts: Date.now() - 3600e3, fiveHour: win(8) }));
  run();
  const led = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { profiles: {} };
  assert.equal(led.profiles.work, undefined);
});

test("no roster from swappy: refuses to guess", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ fiveHour: win(97) }));
  assert.match(run({ SWAPPY_BIN: join(dir, "nope") }), /no roster/);
});

test("fresh stamp: cooldown suppresses the swap", () => {
  fresh();
  writeFileSync(stampPath, JSON.stringify({ atMs: Date.now() }));
  writeFileSync(snapPath, snapshot({ fiveHour: win(97) }));
  assert.match(run(), /cooldown active/);
});

test("expired stamp: swap allowed again", () => {
  fresh();
  writeFileSync(stampPath, JSON.stringify({ atMs: Date.now() - 16 * 60e3 }));
  writeFileSync(snapPath, snapshot({ fiveHour: win(97) }));
  assert.match(run(), /would SWAP/);
});

test("resets_at already passed: window is stale, not hot", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ fiveHour: win(97, -60) }));
  assert.equal(run(), "");
});

test("snapshot older than 6h: ignored", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ ts: Date.now() - 7 * 3600e3, fiveHour: win(97) }));
  assert.equal(run(), "");
});

test("missing snapshot: silent exit 0", () => {
  rmSync(snapPath, { force: true });
  assert.equal(run(), "");
});

test("partial window without resets_at: not hot", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ fiveHour: { used_percentage: 97 } }));
  assert.equal(run(), "");
});

test("snapshot with missing/garbage ts: ignored", () => {
  rmSync(stampPath, { force: true });
  writeFileSync(snapPath, JSON.stringify({ rate_limits: { five_hour: win(97) } }));
  assert.equal(run(), "");
  writeFileSync(snapPath, snapshot({ ts: Date.now() + 3600e3, fiveHour: win(97) }));
  assert.equal(run(), "");
});

test("failed-swap stamp backs off 2 min, not the full cooldown", () => {
  writeFileSync(snapPath, snapshot({ fiveHour: win(97) }));
  writeFileSync(stampPath, JSON.stringify({ atMs: Date.now() - 60e3, failed: true }));
  assert.match(run(), /cooldown active/);
  writeFileSync(stampPath, JSON.stringify({ atMs: Date.now() - 3 * 60e3, failed: true }));
  assert.match(run(), /would SWAP/);
});

test("invalid threshold env falls back to default 95", () => {
  fresh();
  writeFileSync(snapPath, snapshot({ fiveHour: win(50) }));
  assert.equal(run({ SWAPPY_GUARD_THRESHOLD: "0" }), "");
  writeFileSync(snapPath, snapshot({ fiveHour: win(97) }));
  assert.match(run({ SWAPPY_GUARD_THRESHOLD: "0" }), /would SWAP/);
});
