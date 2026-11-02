// tests/unparseable-dates.test.js — 2026-11-02. "The date is not a date."
// Two defects, one family, in the primitive every freshness reader shares:
//   - tradingDaysBetween returned 0 for an Invalid Date (the loop compares
//     false and never runs), so an unparseable bar date read as age 0:
//     today's, CURRENT, through STALE_BARS, STALE_DAILY_BAR and the card.
//   - barsFreshness threw on a bar with no t (b.t.slice), and scanFreshness
//     calls it inside both scans' per-ticker map: one malformed snapshot
//     ended the whole scan.
// Now both are UNKNOWN: null age and null date, which every reader already
// treats as not judged (UNJUDGED), and the logger stores as NULL.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { execSync } = require('child_process');
const { readSource, run, REPO_ROOT } = require('./_lib');

function load(nowIso) {
  const ctx = { Date, Math, JSON, Set, Intl, console, String, Number, state: { settings: {} } };
  vm.createContext(ctx);
  vm.runInContext(readSource('core/clock.js') + '\n' + readSource('core/entry-gate.js') + '\n;globalThis.__realGetPT = getPT;', ctx);
  if (nowIso) { const now = new Date(nowIso); ctx.getPT = d => ctx.__realGetPT(d ?? now); }
  return ctx;
}
const NOW = Date.parse('2026-11-02T18:00:00Z'); // Monday 10:00 PST, REGULAR
const BAD_T = [undefined, null, '', 'x', 42, {}, '2026-02-30T05:00:00Z', '2026-1-05', 'garbage-date-xx', 'NaN-NaN-NaNT00:00:00Z'];

run('parseableDay: a real calendar day or null', () => {
  const c = load();
  assert.strictEqual(c.parseableDay('2026-10-30'), '2026-10-30');
  assert.strictEqual(c.parseableDay('2024-02-29'), '2024-02-29', 'a real leap day');
  for (const s of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-10-3', '2026-10-30T00:00:00Z', '', null, undefined, 20261030]) {
    assert.strictEqual(c.parseableDay(s), null, JSON.stringify(s));
  }
});

run('tradingDaysBetween: either side not a date -> null (unknown), never 0', () => {
  const c = load();
  assert.strictEqual(c.tradingDaysBetween('2026-10-30', '2026-11-02'), 1, 'valid: unchanged');
  assert.strictEqual(c.tradingDaysBetween('2026-11-02', '2026-11-02'), 0, 'same day is still 0, a real 0');
  for (const bad of ['x', '', undefined, null, '2026-02-30']) {
    assert.strictEqual(c.tradingDaysBetween(bad, '2026-11-02'), null, `from ${JSON.stringify(bad)}`);
    assert.strictEqual(c.tradingDaysBetween('2026-10-30', bad), null, `to ${JSON.stringify(bad)}`);
  }
});

run('barsFreshness: any undated or unparseable bar -> both unknown, never a throw, never age 0', () => {
  const c = load();
  const good = d => ({ t: `${d}T04:00:00Z`, c: 1 });
  assert.strictEqual(JSON.stringify(c.barsFreshness([good('2026-10-29'), good('2026-10-30')], '2026-11-02')), JSON.stringify({ barsAsOf: '2026-10-30', barsAgeTradingDays: 1 }));
  for (const t of BAD_T) {
    for (const bars of [[{ t, c: 1 }], [good('2026-10-29'), { t, c: 1 }], [{ t, c: 1 }, good('2026-11-02')]]) {
      let r;
      assert.doesNotThrow(() => { r = c.barsFreshness(bars, '2026-11-02'); }, `t=${JSON.stringify(t)}`);
      assert.strictEqual(JSON.stringify(r), JSON.stringify({ barsAsOf: null, barsAgeTradingDays: null }), `t=${JSON.stringify(t)} among ${bars.length}`);
    }
  }
  assert.strictEqual(JSON.stringify(c.barsFreshness([null], '2026-11-02')), JSON.stringify({ barsAsOf: null, barsAgeTradingDays: null }), 'a null bar');
});

run('scanFreshness: an undated dailyBar no longer throws (the scan survives); its age is unknown', () => {
  const c = load();
  for (const t of BAD_T) {
    let f;
    assert.doesNotThrow(() => { f = c.scanFreshness({ dailyBar: t === undefined ? { c: 1 } : { t, c: 1 } }, NOW); }, `t=${JSON.stringify(t)}`);
    assert.ok(f.dailyBarAsOf === null && f.dailyBarAgeTradingDays === null, `t=${JSON.stringify(t)}: ${JSON.stringify(f)}`);
    assert.strictEqual(f.scanSession, 'REGULAR', 'the scan time is still known');
    assert.strictEqual(c.dailyBarSessionAge(f).state, 'UNJUDGED', `t=${JSON.stringify(t)}`);
  }
});

run('the gates: an unknown date is NOT JUDGED (passes to the time rules), never judged current or stale', () => {
  const c = load('2026-11-02T18:00:00Z');
  for (const t of BAD_T) {
    const sig = { ...c.scanFreshness({ dailyBar: { t, c: 1 } }, NOW), ...c.barsFreshness([{ t, c: 1 }], '2026-11-02') };
    const g = c.entryGateForSignal(sig);
    assert.ok(!['STALE_BARS', 'STALE_DAILY_BAR'].includes(g.rule), `t=${JSON.stringify(t)}: ${JSON.stringify(g)}`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(g)), JSON.parse(JSON.stringify(c.entryGateNow())), 'exactly the time-only answer');
  }
  // Contrast: a real stale date still gates (the fix didn't open the gates).
  const stale = { ...c.scanFreshness({ dailyBar: { t: '2026-10-30T04:00:00Z', c: 1 } }, NOW), barsAsOf: '2026-10-30', barsAgeTradingDays: 1 };
  assert.strictEqual(c.entryGateForSignal(stale).rule, 'STALE_DAILY_BAR');
  assert.strictEqual(c.entryGateForSignal({ barsAsOf: '2026-09-15', barsAgeTradingDays: 26 }).rule, 'STALE_BARS');
});

run('stored data: the new barsFreshness reproduces every stored bars_as_of (pinned backup d6e277d)', () => {
  let raw;
  try { raw = JSON.parse(execSync('git show d6e277d:data/backups/signal_log.json', { cwd: REPO_ROOT, maxBuffer: 2e9 }).toString()); }
  catch (e) { console.log('  (d6e277d not readable from git; skipped)'); return; }
  const rows = (Array.isArray(raw) ? raw : raw.rows).filter(r => r.bars_as_of != null);
  const c = load();
  const differ = rows.filter(r => c.barsFreshness(r.signal_snapshot?.bars || [], r.signal_date).barsAsOf !== String(r.bars_as_of).slice(0, 10));
  assert.strictEqual(rows.length, 1338);
  assert.deepStrictEqual(differ.map(r => r.id), [], 'every stored date is what the fixed function derives');
});
