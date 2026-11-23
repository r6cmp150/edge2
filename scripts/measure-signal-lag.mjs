#!/usr/bin/env node
// scripts/measure-signal-lag.mjs -- how long after a signal was first shown was each of the 586 buys recorded? Read
// only. (2026-11-22, the reviewer: "five of nineteen, and the lag question it opens".) Two independent sources, neither
// a default of the other: the buy's recording moment (the add's own clock) and signal_log.first_shown_at (written by
// the scan that showed the signal). lag = recorded buy time - first shown.
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT. Before writing this, only signal_log's shape was read (its
// columns, writers, date range and dedup), never a lag.
//   SAMPLE: the pre-registered 586: trades_v2 @ 314f6e0, sell_price_unverified false.
//   SIGNALS: data/backups/signal_log/2026-09, -10, -11.json @ 314f6e0, engine EDGE, tier SHOWN only (a signal above the
//     display line; BELOW_THRESHOLD rows are not "shown as a signal" and are counted apart). One row per (signal_date,
//     symbol, tier): the FIRST writer's sighting survives. The app wrote rows to 2026-10-22, the scheduled logger from
//     2026-10-22; the logger's runs were late (the crons ran hours behind), so its first_shown_at can come AFTER a buy
//     Roman made from his own screen. Lags are reported by writer.
//   BUY MOMENT: position_id (Date.now() at the add) when present, else buy_date + buy_time (Pacific, minute). This is
//     the RECORDING moment (decision <= recording), so a lag is an upper bound on how long the decision waited.
//   MATCH: the ticker's SHOWN rows. SAME DAY: the earliest first_shown_at on the buy's own PT date, if it is at or
//     before the buy. EARLIER DAY: otherwise the latest SHOWN row on a date in the 7 calendar days before, if any
//     (the buy came a day or more after a signal). Its lag is measured from that row's first_shown_at.
//   STATES, every trade in exactly one, never a lag substituted:
//     PRE_LOG      bought before the log's first day (2026-09-11): not measurable.
//     SAME_DAY     lag >= 0, same day.          EARLIER_DAY  lag >= 0, from an earlier day's signal.
//     LOGGED_AFTER the only same-day SHOWN row is after the buy (the log saw it only later), and none earlier.
//     NO_SIGNAL    no SHOWN row for the ticker from 7 days before through the buy day (split: BELOW_THRESHOLD only,
//                  or nothing at all). trades_v2.source is 'App Signal' on all 586, but that is the sale form's
//                  pre-selected label, not evidence a signal was shown.
//   REPORTED: the count in each state; over SAME_DAY + EARLIER_DAY (MEASURED), the lag's median, p75, p90, max and a
//     table (0-5 min, 5-15, 15-30, 30-60, 1-3 h, 3 h+ same day, earlier day); the same split by writer; and the
//     concentration habit does not apply (no aggregate of money).
//   THE READING, fixed now (the reviewer's two outcomes, made mechanical):
//     NOT ESTABLISHED if fewer than 293 (half of 586) trades are MEASURED: the sample's lag is then not known.
//     Otherwise SMALL if the median lag is at most 15 minutes AND at least two thirds of MEASURED are within 30
//     minutes; LARGE otherwise. SMALL: "the sample is the strategy, and everything stands as stated". LARGE: the score
//     test's verdict downgrades from "no relationship" to "not established on this sample". NOT ESTABLISHED: the same
//     downgrade is not triggered by this measurement, but "the sample is the strategy" is not shown either.
//   IN NO CASE IS THE SCORE TEST RE-RUN (the reviewer, 2026-11-22). A large lag means a clean sample must be
//     collected with the decision time recorded properly, not that this one is re-cut.
//   node scripts/measure-signal-lag.mjs [--rev 314f6e0]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '314f6e0';
export const LOG_FIRST_DAY = '2026-09-11', LOOKBACK_DAYS = 7, MIN_MEASURED = 293, SMALL_MEDIAN_MIN = 15, SMALL_WITHIN_MIN = 30, SMALL_SHARE = 2 / 3;
export const NO_RERUN = 'IN NO CASE IS THE SCORE TEST RE-RUN: a large lag means a clean sample must be collected with the decision time recorded properly, not that this one is re-cut (the reviewer, 2026-11-22).';
export const LAG_BUCKETS = [[0, 5, '0-5 min'], [5, 15, '5-15 min'], [15, 30, '15-30 min'], [30, 60, '30-60 min'], [60, 180, '1-3 h'], [180, Infinity, '3 h+ (same day)']];

const ptMinuteUtc = (date, hm) => { const off = date >= '2026-11-01' ? 8 : 7; const [h, m] = String(hm).slice(0, 5).split(':').map(Number); return Date.parse(`${date}T00:00:00Z`) + ((h + off) * 60 + m) * 60000; };
export const buyMoment = r => (r.position_id != null && Number(r.position_id) > 1.7e12 ? Number(r.position_id) : ptMinuteUtc(String(r.buy_date).slice(0, 10), r.buy_time));
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// rows: the EDGE signal_log rows (any tier). -> { state, lagMin?, row? }
export function classify(trade, rows) {
  const day = String(trade.buy_date).slice(0, 10), at = buyMoment(trade);
  if (day < LOG_FIRST_DAY) return { state: 'PRE_LOG' };
  const mine = rows.filter(r => r.symbol === trade.ticker), from = addDays(day, -LOOKBACK_DAYS);
  const shown = mine.filter(r => r.tier === 'SHOWN' && r.signal_date >= from && r.signal_date <= day);
  const same = shown.filter(r => r.signal_date === day).sort((a, b) => Date.parse(a.first_shown_at) - Date.parse(b.first_shown_at));
  if (same.length && Date.parse(same[0].first_shown_at) <= at) return { state: 'SAME_DAY', lagMin: (at - Date.parse(same[0].first_shown_at)) / 60000, row: same[0] };
  const earlier = shown.filter(r => r.signal_date < day).sort((a, b) => Date.parse(b.first_shown_at) - Date.parse(a.first_shown_at));
  if (earlier.length) return { state: 'EARLIER_DAY', lagMin: (at - Date.parse(earlier[0].first_shown_at)) / 60000, row: earlier[0] };
  if (same.length) return { state: 'LOGGED_AFTER', afterMin: (Date.parse(same[0].first_shown_at) - at) / 60000, row: same[0] };
  const below = mine.some(r => r.tier === 'BELOW_THRESHOLD' && r.signal_date >= from && r.signal_date <= day);
  return { state: 'NO_SIGNAL', below };
}
export const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return null; const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
export function reading(measuredLags) {
  if (measuredLags.length < MIN_MEASURED) return 'NOT ESTABLISHED';
  const within = measuredLags.filter(l => l <= SMALL_WITHIN_MIN).length / measuredLags.length;
  return quantile(measuredLags, 0.5) <= SMALL_MEDIAN_MIN && within >= SMALL_SHARE ? 'SMALL' : 'LARGE';
}
export function lagTable(results) {
  const same = results.filter(x => x.state === 'SAME_DAY').map(x => x.lagMin);
  return [...LAG_BUCKETS.map(([lo, hi, label]) => ({ label, n: same.filter(l => l >= lo && l < hi).length })), { label: 'earlier day', n: results.filter(x => x.state === 'EARLIER_DAY').length }];
}
const fmt = m => (m == null ? '-' : m < 120 ? `${m.toFixed(1)} min` : `${(m / 60).toFixed(1)} h`);

async function main() {
  const rev = (i => (i < 0 ? REV : process.argv[i + 1]))(process.argv.indexOf('--rev'));
  const show = f => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${rev}:data/backups/${f}`, { cwd: ROOT, maxBuffer: 4e9 }).toString()));
  const trades = show('trades_v2.json').filter(r => r.sell_price_unverified === false);
  const rows = ['2026-09', '2026-10', '2026-11'].flatMap(m => show(`signal_log/${m}.json`)).filter(r => r.engine_source === 'EDGE');
  console.log(`SOURCE @ ${rev}: ${trades.length} trades (sell_price_unverified false); ${rows.length} EDGE signal_log rows (${rows.filter(r => r.tier === 'SHOWN').length} SHOWN).`);
  const res = trades.map(t => ({ t, ...classify(t, rows) }));
  const n = s => res.filter(x => x.state === s).length;
  console.log(`STATES: PRE_LOG ${n('PRE_LOG')} | SAME_DAY ${n('SAME_DAY')} | EARLIER_DAY ${n('EARLIER_DAY')} | LOGGED_AFTER ${n('LOGGED_AFTER')} | NO_SIGNAL ${n('NO_SIGNAL')} (of which a BELOW_THRESHOLD row only: ${res.filter(x => x.state === 'NO_SIGNAL' && x.below).length})`);
  const measured = res.filter(x => x.state === 'SAME_DAY' || x.state === 'EARLIER_DAY');
  const lags = measured.map(x => x.lagMin);
  console.log(`MEASURED: ${measured.length} of ${trades.length}. Lag median ${fmt(quantile(lags, 0.5))}, p75 ${fmt(quantile(lags, 0.75))}, p90 ${fmt(quantile(lags, 0.9))}, max ${fmt(lags.length ? Math.max(...lags) : null)}; within ${SMALL_WITHIN_MIN} min: ${lags.filter(l => l <= SMALL_WITHIN_MIN).length}.`);
  for (const b of lagTable(res)) console.log(`  ${b.label.padEnd(16)} ${b.n}`);
  for (const [w, f] of [['app-written rows (to 10-22)', x => !!x.row?.build_version], ['logger-written rows (from 10-22)', x => !x.row?.build_version]]) {
    const ls = measured.filter(f).map(x => x.lagMin);
    console.log(`  by writer, ${w}: ${ls.length}, median ${fmt(quantile(ls, 0.5))}, p90 ${fmt(quantile(ls, 0.9))}`);
  }
  const after = res.filter(x => x.state === 'LOGGED_AFTER').map(x => x.afterMin);
  console.log(`LOGGED_AFTER: ${after.length}; the log's first sighting came after the buy by median ${fmt(quantile(after, 0.5))}, max ${fmt(after.length ? Math.max(...after) : null)}.`);
  const r = reading(lags);
  console.log(`\nTHE READING (declared: NOT ESTABLISHED under ${MIN_MEASURED} measured; SMALL = median <= ${SMALL_MEDIAN_MIN} min and >= 2/3 within ${SMALL_WITHIN_MIN} min): ${r}.`);
  console.log(r === 'SMALL' ? 'SMALL: the sample is the strategy, and the score verdict stands as stated.'
    : r === 'LARGE' ? 'LARGE: the score test\'s verdict downgrades from "no relationship" to "not established on this sample".'
    : 'NOT ESTABLISHED: too few trades can be placed against a shown signal to say the sample is the strategy; the downgrade is not triggered by this measurement either.');
  console.log(NO_RERUN);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
