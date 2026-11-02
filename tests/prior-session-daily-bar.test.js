// tests/prior-session-daily-bar.test.js — 2026-11-01. Two ways a signal from
// one moment was presented as current and bought:
//   PRIOR_SESSION   DNUT and NRGV: a 10-28 scan still on screen at 07:18 on
//                   10-29, shown at 85; that morning's data scored 55 and 50.
//                   barsAgeTradingDays is measured against the scan's own
//                   date, so a scan reads as current forever.
//   STALE_DAILY_BAR APUS, BIAF and IPDN on 10-30: no IEX trade yet by 07:33,
//                   so the snapshot's dailyBar ("the most recent daily bar")
//                   was 10-29's, shown as +6.4% / +4.6% / +5.6% when SIP had
//                   them at -7.8% / -2.0% / -7.6%. STALE_BARS allows age 1
//                   because it never asked whether the scan was in a session.
// Advice only, like every rule in core/entry-gate.js; recording stays open.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { execSync } = require('child_process');
const { readSource, run, REPO_ROOT } = require('./_lib');

function load(nowIso) {
  const ctx = { Date, Math, JSON, Set, Intl, console, String, Number, state: { settings: {} } };
  vm.createContext(ctx);
  vm.runInContext(readSource('core/clock.js') + '\n' + readSource('core/entry-gate.js') +
    '\n;globalThis.__gate = entryGateForSignal; globalThis.__fresh = scanFreshness; globalThis.__realGetPT = getPT;', ctx);
  if (nowIso) { const now = new Date(nowIso); ctx.getPT = d => ctx.__realGetPT(d ?? now); }
  return ctx;
}
const bar = d => ({ t: `${d}T04:00:00Z`, c: 1, v: 1 });
const ms = iso => Date.parse(iso);

run('scanFreshness: scan time, its session, and the dailyBar date with three states', () => {
  const c = load();
  // 10-30 07:33 PT = 14:33Z (PDT).
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c.__fresh({ dailyBar: bar('2026-10-29') }, ms('2026-10-30T14:33:00Z')))),
    { scannedAt: ms('2026-10-30T14:33:00Z'), scanSession: 'REGULAR', dailyBarAsOf: '2026-10-29', dailyBarAgeTradingDays: 1 });
  assert.strictEqual(c.__fresh({ dailyBar: bar('2026-10-30') }, ms('2026-10-30T14:33:00Z')).dailyBarAgeTradingDays, 0);
  const none = c.__fresh({}, ms('2026-10-30T14:33:00Z'));
  assert.ok(none.dailyBarAsOf === null && none.dailyBarAgeTradingDays === null, 'no dailyBar is unknown, never 0');
  assert.strictEqual(c.__fresh({ dailyBar: bar('2026-10-29') }, ms('2026-10-30T12:00:00Z')).scanSession, 'PRE_MARKET');
});

run("STALE_DAILY_BAR: yesterday's dailyBar on a scan taken in a session is not buyable", () => {
  const c = load('2026-10-30T14:40:00Z'); // 07:40 PT, outside the 7:00-7:30 window
  const apus = { ...c.__fresh({ dailyBar: bar('2026-10-29') }, ms('2026-10-30T14:33:00Z')), barsAsOf: '2026-10-29', barsAgeTradingDays: 1 };
  const g = c.__gate(apus);
  assert.ok(g.gated && g.rule === 'STALE_DAILY_BAR', JSON.stringify(g));
  assert.strictEqual(g.label, "Scored on 2026-10-29's price, not today's: no trade on the feed yet when scanned — not buyable");
  const fresh = c.__fresh({ dailyBar: bar('2026-10-30') }, ms('2026-10-30T14:33:00Z'));
  assert.strictEqual(c.__gate(fresh).rule, null, "today's dailyBar is current");
  // Scanned 06:00 and viewed 06:10, both pre-market: yesterday's bar is the
  // newest there is, so no rule fires (viewed after the open, PRIOR_SESSION would).
  const cPre = load('2026-10-30T13:10:00Z');
  const pre = cPre.__fresh({ dailyBar: bar('2026-10-29') }, ms('2026-10-30T13:00:00Z'));
  assert.strictEqual(cPre.__gate(pre).rule, null, "before the open yesterday's bar is the newest there is");
  assert.strictEqual(c.__gate({ dailyBarAgeTradingDays: null, scanSession: 'REGULAR' }).rule, null, 'unknown is not judged');
});

run('PRIOR_SESSION: a scan from before the most recent open is not buyable, and says when it was taken', () => {
  // DNUT: scanned 10-28 13:05 PT (20:05Z), viewed 10-29 07:40 PT.
  const dnut = { scannedAt: ms('2026-10-28T20:05:00Z'), barsAsOf: '2026-10-28', barsAgeTradingDays: 0 };
  const g = load('2026-10-29T14:40:00Z').__gate(dnut);
  assert.ok(g.gated && g.rule === 'PRIOR_SESSION', JSON.stringify(g));
  assert.strictEqual(g.label, 'Scanned 2026-10-28 13:05 PT, before the 2026-10-29 open — rescan for a current score; not buyable');
  assert.strictEqual(load('2026-10-29T12:00:00Z').__gate(dnut).rule, null, "pre-market, last evening's scan is the latest there is");
  assert.strictEqual(load('2026-10-29T14:40:00Z').__gate({ scannedAt: ms('2026-10-29T13:45:00Z') }).rule, null, 'scanned 06:45 today: current');
  assert.strictEqual(load('2026-10-29T14:40:00Z').__gate({ scannedAt: ms('2026-10-29T13:20:00Z') }).rule, 'PRIOR_SESSION', 'scanned 06:20 today, pre-market: before the open');
  // Friday 14:00 PT scan: current over the weekend and Monday pre-market, prior once Monday opens.
  const fri = { scannedAt: ms('2026-10-30T21:00:00Z') };
  assert.strictEqual(load('2026-11-02T13:00:00Z').__gate(fri).rule, null, 'Monday 05:00 PST');
  assert.strictEqual(load('2026-11-02T14:31:00Z').__gate(fri).rule, 'PRIOR_SESSION', 'Monday 06:31 PST');
  // Thanksgiving: no session on 11-26, so Wednesday's scan stays current that day.
  assert.strictEqual(load('2026-11-26T18:00:00Z').__gate({ scannedAt: ms('2026-11-25T22:00:00Z') }).gated, true, 'still gated: CLOSED');
  assert.notStrictEqual(load('2026-11-26T18:00:00Z').__gate({ scannedAt: ms('2026-11-25T22:00:00Z') }).rule, 'PRIOR_SESSION');
  assert.strictEqual(load('2026-10-29T14:40:00Z').__gate({}).rule, null, 'scannedAt unknown is not judged');
});

run('the bought data: exactly the five, of 88, are not buyable under the new rules (pinned backup d6e277d)', () => {
  let rows;
  try { rows = JSON.parse(execSync('git show d6e277d:data/backups/signal_snapshot_at_buy.json', { cwd: REPO_ROOT, maxBuffer: 1e9 }).toString()); }
  catch (e) { console.log('  (d6e277d not readable from git; skipped)'); return; }
  const c = load();
  // Those 88 predate scanFreshness, so it's recomputed: dailyBar = the newest
  // bar (its date matched the snapshot's on all 88), at the buy minute, the
  // only time stored. APUS, BIAF and IPDN are STALE_DAILY_BAR. DNUT and NRGV
  // land there too with the buy minute standing in; with their real scan
  // time (10-28, which their age-0 bars show) they'd be PRIOR_SESSION.
  // Either way not buyable, and the other 83 are untouched.
  const hit = rows.filter(r => {
    const s = r.snapshot, buy = Number(r.position_id);
    const f = c.__fresh({ dailyBar: s.bars[s.bars.length - 1] }, buy);
    c.getPT = d => c.__realGetPT(d ?? new Date(buy));
    return ['STALE_DAILY_BAR', 'PRIOR_SESSION'].includes(c.__gate({ ...s, ...f }).rule);
  }).map(r => r.snapshot.ticker).sort();
  assert.deepStrictEqual(hit, ['APUS', 'BIAF', 'DNUT', 'IPDN', 'NRGV']);
  assert.strictEqual(rows.length, 88);
});

run('wiring: both scans stamp it, the setting is recorded, old signals get their scan time, re-scoring reads it', () => {
  const app = readSource('app.js'), lg = readSource('scripts/log-signals-edge.mjs');
  assert.ok(app.includes('Object.assign(s, scanFreshness(snap, scanMs));') && app.includes("s.scoreSettings = { disableMacroOverlay: !!state.settings.disableMacroOverlay };"));
  assert.ok(lg.includes('Object.assign(s, global.scanFreshness(snap, scanMs));') && lg.includes("'scanFreshness'") && lg.includes('s.scoreSettings = { disableMacroOverlay: !!global.state.settings.disableMacroOverlay };'));
  assert.ok(app.includes('for (const s of state.signals) if (s && s.scannedAt == null) s.scannedAt = state.lastScanTime;'), 'loadState backfills scannedAt');
  const gate = readSource('core/entry-gate.js');
  assert.ok(gate.includes('return entryGatePriorSession(signal) || entryGateStaleDailyBar(signal) || entryGateNow();'));
  assert.ok(readSource('scripts/lib/rescore-snapshot.mjs').includes('disableMacroOverlay ?? o.scoreSettings?.disableMacroOverlay ?? false'));
});
