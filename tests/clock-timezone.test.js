// tests/clock-timezone.test.js — core/clock.js under non-Pacific system
// timezones. docs/warrior-engine-spec-v2.md / CLAUDE.md's rule: .setHours()/
// .setDate() on a getPT()-derived Date is safe only for a difference
// against another getPT()-derived Date; constructing an absolute instant
// from a REAL Date's local fields (before PT conversion) is not.
//
// This is a general invariant regression test, not a reproduction of one
// specific historical bug. engines/warrior/gate.js's RVOL session-open
// timestamp (found 2026-08-26) is a case this SHAPE of test would catch —
// it built an absolute instant sent to Alpaca from raw local fields.
// core/clock.js:70's getCountdownToOpen() forward day-walk had the same
// code SHAPE (raw `now.getDate()` instead of `ptNow.getDate()`) and was
// fixed alongside it on invariant-compliance grounds, but deliberately
// reintroducing that exact bug and running it under LA/NY/Tokyo — across a
// plain weekday, a Saturday, a Dec-25 holiday-boundary crossing, and a
// Sunday-into-Monday day-label crossing — never produced a diverging
// result here. The reason is structural, not luck: dayPT's per-process
// local-field walk is self-correcting (isTradingDay is evaluated against
// dayPT's OWN frame consistently), so it always converges on the same
// target local-field reading ("next Monday, local 06:30") regardless of
// which day-index got it there, and ptNow's local fields always show PT's
// true wall clock regardless of process TZ — so the offset that
// SHOULD cancel in a getPT()-vs-getPT() difference also cancels here,
// via the two operands independently converging to frame-identical local
// fields. This stops holding across a DST transition between `now` and
// the target day (the process's own UTC offset isn't constant across
// one). The fix stands regardless, on CLAUDE.md rule-compliance and
// defense-in-depth grounds, not because this test demonstrates a live bug.
//
// The DST case IS real, though, and is exercised below as a documented
// KNOWN LIMITATION rather than "fixed": a countdown window that spans a
// US DST transition comes out exactly 1 hour off in a zone that doesn't
// observe DST on the US calendar (Tokyo), because .setDate()/.setHours()
// on a getPT()-derived Date resolve the transition using the RUNNING
// PROCESS's own DST rules, not PT's — there's no way to ask a Date to
// mutate "as PT" specifically. Not worth chasing (a countdown display
// off by an hour twice a year, on a machine not already set to Pacific,
// isn't worth the complexity of a real PT-aware date library) — but left
// untested, an accepted limit silently becomes an unknown regression
// surface. testDSTTransitionKnownLimitation asserts the CURRENT (known
// imperfect) behavior precisely, so this stays visible instead.
//
// This machine's own default timezone happens to already be Pacific, so
// running any of this without forcing a different TZ would prove nothing.
// Node only reads TZ at process start, so each variant runs as a genuine
// child process via _clock_tz_runner.js (spawnSync's `env` option,
// confirmed to actually reach the child — a plain shell `TZ=x node ...`
// prefix does NOT reach Node reliably in this sandbox, checked directly
// before relying on it). The runner fixes `new Date()`/Date.now() to one
// real instant across all three variants, so only the process's own
// local-timezone interpretation of that instant differs between runs —
// exactly the variable under test.
'use strict';
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { run } = require('./_lib');

const RUNNER = path.join(__dirname, '_clock_tz_runner.js');
const ZONES = ['America/Los_Angeles', 'America/New_York', 'Asia/Tokyo'];

function runUnderTZ(tz, epochMs) {
  const res = spawnSync(process.execPath, [RUNNER, String(epochMs)], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`runner failed under TZ=${tz}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

async function testClosedMarketCountdownIdenticalAcrossTimezones() {
  // Saturday 2026-08-29, 10:00am PT = 17:00 UTC. Market closed, so
  // getMarketStatus() calls getCountdownToOpen() — the function whose
  // forward day-walk was fixed to use ptNow.getDate() instead of a real
  // Date's local .getDate() (see file header on why this specific case
  // doesn't actually discriminate that fix from the original bug).
  const epochMs = Date.parse('2026-08-29T17:00:00Z');
  const results = ZONES.map(tz => runUnderTZ(tz, epochMs));
  results.forEach((r, i) => console.log(`${ZONES[i]}: status=${r.marketStatus.status} countdown="${r.countdown}"`));

  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].marketStatus.status, results[0].marketStatus.status, `market status differs under ${ZONES[i]} vs ${ZONES[0]} at the identical real instant — timezone-dependent bug`);
    assert.strictEqual(results[i].countdown, results[0].countdown, `getCountdownToOpen() differs under ${ZONES[i]} vs ${ZONES[0]} — timezone-dependent bug`);
  }
}

async function testHoursSincePreviousCloseIdenticalAcrossTimezones() {
  // Monday 2026-08-31, 5:00am PT (before open) = 12:00 UTC. Exercises the
  // backward day-walk finding the preceding Friday's close.
  const epochMs = Date.parse('2026-08-31T12:00:00Z');
  const results = ZONES.map(tz => runUnderTZ(tz, epochMs));
  results.forEach((r, i) => console.log(`${ZONES[i]}: hoursSincePreviousClose=${r.hoursSincePreviousClose}`));

  for (let i = 1; i < results.length; i++) {
    assert.ok(
      Math.abs(results[i].hoursSincePreviousClose - results[0].hoursSincePreviousClose) < 0.001,
      `hoursSincePreviousClose differs under ${ZONES[i]} (${results[i].hoursSincePreviousClose}) vs ${ZONES[0]} (${results[0].hoursSincePreviousClose}) — timezone-dependent bug`
    );
  }
}

async function testOpenSessionIdenticalAcrossTimezones() {
  // Wednesday 2026-08-26, 11:00am PT (mid-regular-session; 1:00pm PT is
  // the exact OPEN/AH boundary, tMin<780, so deliberately not used here)
  // = 18:00 UTC — baseline positive control: the common case must also agree.
  const epochMs = Date.parse('2026-08-26T18:00:00Z');
  const results = ZONES.map(tz => runUnderTZ(tz, epochMs));
  results.forEach((r, i) => console.log(`${ZONES[i]}: status=${r.marketStatus.status} countdown="${r.marketStatus.countdown}"`));

  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].marketStatus.status, results[0].marketStatus.status);
    assert.strictEqual(results[i].marketStatus.countdown, results[0].marketStatus.countdown);
  }
  assert.strictEqual(results[0].marketStatus.status, 'OPEN', 'sanity check on the chosen epoch itself, not just cross-TZ agreement');
}

function parseCountdownMinutes(s) {
  const m = s.match(/^(\d+)h (\d+)m$/);
  if (!m) throw new Error(`unparseable countdown string: "${s}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

async function testDSTTransitionKnownLimitation() {
  // Friday 2026-03-06, 6:00pm PT (PST, UTC-8) = 2026-03-07T02:00:00Z.
  // Market closed; the forward walk to Monday's open crosses Sunday
  // 2026-03-08, when US clocks spring forward. LA and NY both observe
  // that transition (same calendar date, different real UTC moment —
  // "2am local" in each zone independently) so they still agree with
  // each other. Tokyo observes no DST at all, so its .setDate()/
  // .setHours() arithmetic never applies the missing hour, landing
  // exactly 60 minutes off from LA/NY. See file header — this is the
  // accepted, documented limitation, not a bug being reintroduced.
  const epochMs = Date.parse('2026-03-07T02:00:00Z');
  const results = ZONES.map(tz => runUnderTZ(tz, epochMs));
  results.forEach((r, i) => console.log(`${ZONES[i]}: countdown="${r.countdown}"`));

  const [la, ny, tokyo] = results.map(r => parseCountdownMinutes(r.countdown));
  assert.strictEqual(ny, la, 'LA and NY both observe US DST on the same calendar date — expected to still agree with each other');
  assert.strictEqual(tokyo, la + 60, `Tokyo is expected to read exactly 1h ahead of LA across this transition (known limitation) — got a ${tokyo - la} minute gap instead, which means the limitation's SHAPE changed and this needs a fresh look, not a silent update`);
}

(async () => {
  await run('clock-timezone: closed-market countdown identical across TZ (forward day-walk path)', testClosedMarketCountdownIdenticalAcrossTimezones);
  await run('clock-timezone: hoursSincePreviousClose identical across TZ (backward walk)', testHoursSincePreviousCloseIdenticalAcrossTimezones);
  await run('clock-timezone: OPEN-session status/countdown identical across TZ', testOpenSessionIdenticalAcrossTimezones);
  await run('clock-timezone: KNOWN LIMITATION — DST-spanning countdown is 1h off in a non-US-DST zone (documented, not fixed)', testDSTTransitionKnownLimitation);
})();
