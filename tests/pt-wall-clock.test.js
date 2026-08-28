// tests/pt-wall-clock.test.js — core/clock.js's ptWallClockToInstant(),
// added for Phase 4's replay harness (docs/warrior-engine-spec-v2.md).
// Converts a PT wall-clock date+time into a real absolute instant without
// ever mutating a Date's local fields (see its own header comment) —
// specifically to avoid sending Alpaca a wrong start/end on a machine not
// already set to Pacific, the exact class of bug CLAUDE.md's rule this
// session's timezone sweep exists to prevent.
'use strict';
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { readSource, evalModule, run } = require('./_lib');

const RUNNER = path.join(__dirname, '_clock_tz_runner.js');
const ZONES = ['America/Los_Angeles', 'America/New_York', 'Asia/Tokyo'];

function loadClock() {
  const src = readSource('core/clock.js');
  global.state = { settings: {} };
  evalModule(src, { expose: ['ptWallClockToInstant'] });
  return global.ptWallClockToInstant;
}

async function testKnownPDTDate() {
  const ptWallClockToInstant = loadClock();
  const result = ptWallClockToInstant('2026-07-15', 6, 30);
  console.log('2026-07-15 6:30am PT (PDT, UTC-7) ->', result.toISOString());
  assert.strictEqual(result.toISOString(), '2026-07-15T13:30:00.000Z');
}

async function testKnownPSTDate() {
  const ptWallClockToInstant = loadClock();
  const result = ptWallClockToInstant('2026-01-15', 6, 30);
  console.log('2026-01-15 6:30am PT (PST, UTC-8) ->', result.toISOString());
  assert.strictEqual(result.toISOString(), '2026-01-15T14:30:00.000Z');
}

async function testReplayDefaultWindowBoundaries() {
  // 1:00am PT is replay.js's default fetch-window start (4:00am ET) and
  // already core/clock.js's own isPreMarketHours() boundary (tMin=60) —
  // not an independently-chosen number. 1:00pm PT is regular close.
  const ptWallClockToInstant = loadClock();
  const start = ptWallClockToInstant('2026-08-26', 1, 0);
  const end = ptWallClockToInstant('2026-08-26', 13, 0);
  const windowMinutes = (end.getTime() - start.getTime()) / 60000;
  console.log(`window: ${start.toISOString()} -> ${end.toISOString()} = ${windowMinutes} min`);
  assert.strictEqual(windowMinutes, 720, 'default replay window must be exactly 720 minutes — the number the chunk-size proof is computed against');
}

function runUnderTZ(tz) {
  const res = spawnSync(process.execPath, [RUNNER, String(Date.now())], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`runner failed under TZ=${tz}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

async function testCrossTimezoneInvariance() {
  // ptWallClockToInstant must NOT depend on the running machine's own
  // timezone at all (unlike getPT()-derived values) — this is the whole
  // point of computing it via Intl with an explicit zone rather than any
  // local-time mutator. Genuine child processes, same reasoning as
  // clock-timezone.test.js: Node only reads TZ at start.
  const results = ZONES.map(tz => ({ tz, ...runUnderTZ(tz) }));
  results.forEach(r => console.log(`${r.tz}: pdt=${r.ptWallClock_pdt} pst=${r.ptWallClock_pst}`));
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].ptWallClock_pdt, results[0].ptWallClock_pdt, `PDT conversion differs under ${results[i].tz} vs ${results[0].tz}`);
    assert.strictEqual(results[i].ptWallClock_pst, results[0].ptWallClock_pst, `PST conversion differs under ${results[i].tz} vs ${results[0].tz}`);
  }
}

(async () => {
  await run('pt-wall-clock: known PDT date converts correctly', testKnownPDTDate);
  await run('pt-wall-clock: known PST date converts correctly', testKnownPSTDate);
  await run('pt-wall-clock: replay default window is exactly 720 minutes', testReplayDefaultWindowBoundaries);
  await run('pt-wall-clock: identical across timezones (no system-TZ dependency)', testCrossTimezoneInvariance);
})();
