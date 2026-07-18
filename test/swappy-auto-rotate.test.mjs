import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, "..", "tools", "swappy-auto-rotate.mjs");

const dir = mkdtempSync(join(tmpdir(), "swappy-guard-"));
const snapPath = join(dir, "snapshot.json");
const stampPath = join(dir, "stamp.json");

const snapshot = ({ ts = Date.now(), fiveHour, sevenDay } = {}) =>
  JSON.stringify({ ts, rate_limits: { five_hour: fiveHour, seven_day: sevenDay } });

const win = (pct, resetsInSec = 7200) => ({
  used_percentage: pct,
  resets_at: Math.floor(Date.now() / 1000) + resetsInSec,
});

const run = (extraEnv = {}) =>
  execFileSync(process.execPath, [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      SWAPPY_GUARD_DRYRUN: "1",
      SWAPPY_GUARD_SNAPSHOT: snapPath,
      SWAPPY_GUARD_STAMP: stampPath,
      ...extraEnv,
    },
  });

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("cool windows: silent no-op", () => {
  rmSync(stampPath, { force: true });
  writeFileSync(snapPath, snapshot({ fiveHour: win(8), sevenDay: win(1) }));
  assert.equal(run(), "");
});

test("hot 5h window triggers a swap", () => {
  rmSync(stampPath, { force: true });
  writeFileSync(snapPath, snapshot({ fiveHour: win(97), sevenDay: win(40) }));
  assert.match(run(), /would SWAP \(5h at 97%\)/);
});

test("hot 7d window alone also triggers", () => {
  rmSync(stampPath, { force: true });
  writeFileSync(snapPath, snapshot({ fiveHour: win(10), sevenDay: win(96) }));
  assert.match(run(), /would SWAP \(7d at 96%\)/);
});

test("fresh stamp: cooldown suppresses the swap", () => {
  writeFileSync(stampPath, JSON.stringify({ atMs: Date.now() }));
  writeFileSync(snapPath, snapshot({ fiveHour: win(97) }));
  assert.match(run(), /cooldown active/);
});

test("expired stamp: swap allowed again", () => {
  writeFileSync(stampPath, JSON.stringify({ atMs: Date.now() - 16 * 60e3 }));
  writeFileSync(snapPath, snapshot({ fiveHour: win(97) }));
  assert.match(run(), /would SWAP/);
});

test("resets_at already passed: window is stale, not hot", () => {
  rmSync(stampPath, { force: true });
  writeFileSync(snapPath, snapshot({ fiveHour: win(97, -60) }));
  assert.equal(run(), "");
});

test("snapshot older than 6h: ignored", () => {
  rmSync(stampPath, { force: true });
  writeFileSync(snapPath, snapshot({ ts: Date.now() - 7 * 3600e3, fiveHour: win(97) }));
  assert.equal(run(), "");
});

test("missing snapshot: silent exit 0", () => {
  rmSync(snapPath, { force: true });
  assert.equal(run(), "");
});

test("partial window without resets_at: not hot", () => {
  rmSync(stampPath, { force: true });
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
  rmSync(stampPath, { force: true });
  writeFileSync(snapPath, snapshot({ fiveHour: win(50) }));
  assert.equal(run({ SWAPPY_GUARD_THRESHOLD: "0" }), "");
  writeFileSync(snapPath, snapshot({ fiveHour: win(97) }));
  assert.match(run({ SWAPPY_GUARD_THRESHOLD: "0" }), /would SWAP/);
});
