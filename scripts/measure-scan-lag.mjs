#!/usr/bin/env node
// scripts/measure-scan-lag.mjs -- the SAME question as scripts/measure-signal-lag.mjs (05969ca): how long between the
// signal and the buy's recording? Measured from a source that covers the trades. (2026-11-22, the reviewer: "measure
// it from scannedAt -- that is the same measurement with working data, not a second cut".) Read only.
// signal_log turned out never to have seen most trades (96 EDGE symbols logged against 310 traded), so it could not
// answer; signal_snapshot_at_buy can: it is the signal object itself, copied at the click (app.js
// captureSignalSnapshot), and carries that signal's own scan time.
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT. No snapshot's scannedAt has been read against a buy time.
//   SAMPLE: the pre-registered 586 (trades_v2 @ 314f6e0, sell_price_unverified false); MEASURABLE: those joined by
//     position_id to a signal_snapshot_at_buy row with a snapshot (244 expected).
//   lag = position_id (Date.now() at the add) - snapshot.scannedAt (Date.now() at the scan that produced the signal,
//     core/clock.js scanFreshness). Two different events' clocks; neither is a default of the other. The add is the
//     recording moment and the scan is when the signal was computed, so the lag bounds how stale the scored signal
//     was when the buy was recorded, and bounds the decision's delay from above.
//   STATES: MEASURED (lag >= 0); NO_SCAN_TIME (a snapshot without scannedAt: counted, never given a lag);
//     CLOCK_ANOMALY (lag < 0, a scan after the click: counted apart, never read as 0); NO_SNAPSHOT (the other 342).
//   REPORTED: the states; over MEASURED, median, p75, p90, max and the 05969ca lag table; by buy_session.
//   THE BAR: the same SMALL rule as 05969ca, imported, not restated: median <= 15 minutes AND at least two thirds
//     within 30 minutes; LARGE otherwise.
//   THE READING (the reviewer's split, declared 2026-11-22 before this run):
//     SMALL -> the sample is the strategy FOR THESE TRADES; the score verdict holds with a stated coverage limit, and
//       the other 342 stay NOT ESTABLISHED.
//     LARGE -> DOWNGRADE: a substantial share of the sample has misaligned timing and there is no reason to think the
//       uncovered 342 are better behaved; the verdict becomes "not established on this sample".
//     Coverage is below 05969ca's 293 by construction; the reviewer has ruled the split applies anyway, stated with it.
//   IN NO CASE IS THE SCORE TEST RE-RUN.
//   node scripts/measure-scan-lag.mjs [--rev 314f6e0]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SMALL_MEDIAN_MIN, SMALL_WITHIN_MIN, SMALL_SHARE, NO_RERUN, quantile, lagTable } from './measure-signal-lag.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '314f6e0';
export const SMALL_TEXT = 'SMALL: the sample is the strategy FOR THESE TRADES; the score verdict holds with a stated coverage limit, and the other 342 stay NOT ESTABLISHED.';
export const LARGE_TEXT = 'LARGE: DOWNGRADE. The verdict becomes "not established on this sample": a substantial share has misaligned timing, and there is no reason to think the uncovered trades are better behaved.';

// -> { state, lagMin? }
export function classify(trade, snapRow) {
  const s = snapRow?.snapshot;
  if (!s) return { state: 'NO_SNAPSHOT' };
  if (s.scannedAt == null || !Number.isFinite(Number(s.scannedAt))) return { state: 'NO_SCAN_TIME' };
  const lag = (Number(trade.position_id) - Number(s.scannedAt)) / 60000;
  return lag < 0 ? { state: 'CLOCK_ANOMALY', lagMin: lag } : { state: 'MEASURED', lagMin: lag };
}
export function reading(lags) {
  if (!lags.length) return 'NOTHING MEASURED';
  const within = lags.filter(l => l <= SMALL_WITHIN_MIN).length / lags.length;
  return quantile(lags, 0.5) <= SMALL_MEDIAN_MIN && within >= SMALL_SHARE ? 'SMALL' : 'LARGE';
}
const fmt = m => (m == null ? '-' : m < 120 ? `${m.toFixed(1)} min` : `${(m / 60).toFixed(1)} h`);

async function main() {
  const rev = (i => (i < 0 ? REV : process.argv[i + 1]))(process.argv.indexOf('--rev'));
  const show = f => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${rev}:data/backups/${f}`, { cwd: ROOT, maxBuffer: 4e9 }).toString()));
  const trades = show('trades_v2.json').filter(r => r.sell_price_unverified === false);
  const snaps = new Map(show('signal_snapshot_at_buy.json').map(x => [String(x.position_id), x]));
  const res = trades.map(t => ({ t, ...classify(t, t.position_id != null ? snaps.get(String(t.position_id)) : null) }));
  const n = s => res.filter(x => x.state === s).length;
  console.log(`SOURCE @ ${rev}: ${trades.length} trades; signal_snapshot_at_buy joined by position_id.`);
  console.log(`STATES: MEASURED ${n('MEASURED')} | NO_SCAN_TIME ${n('NO_SCAN_TIME')} | CLOCK_ANOMALY ${n('CLOCK_ANOMALY')} | NO_SNAPSHOT ${n('NO_SNAPSHOT')}`);
  const m = res.filter(x => x.state === 'MEASURED'), lags = m.map(x => x.lagMin);
  console.log(`MEASURED ${m.length}: lag median ${fmt(quantile(lags, 0.5))}, p75 ${fmt(quantile(lags, 0.75))}, p90 ${fmt(quantile(lags, 0.9))}, max ${fmt(lags.length ? Math.max(...lags) : null)}; within ${SMALL_WITHIN_MIN} min: ${lags.filter(l => l <= SMALL_WITHIN_MIN).length}.`);
  for (const b of lagTable(m.map(x => ({ state: 'SAME_DAY', lagMin: x.lagMin }))).slice(0, -1)) console.log(`  ${b.label.padEnd(16)} ${b.n}`);
  const bySess = {}; for (const x of m) (bySess[x.t.buy_session || 'NULL'] ||= []).push(x.lagMin);
  console.log('  by buy_session (n, median):', Object.entries(bySess).map(([k, v]) => `${k} ${v.length}, ${fmt(quantile(v, 0.5))}`).join('; '));
  const r = reading(lags);
  console.log(`\nTHE READING (the bar of 05969ca: median <= ${SMALL_MEDIAN_MIN} min and >= 2/3 within ${SMALL_WITHIN_MIN} min), on ${m.length} of ${trades.length}: ${r}.`);
  console.log(r === 'SMALL' ? SMALL_TEXT : r === 'LARGE' ? LARGE_TEXT : 'Nothing measured: back to the reviewer.');
  console.log(NO_RERUN);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
