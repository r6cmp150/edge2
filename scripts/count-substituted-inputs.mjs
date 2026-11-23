#!/usr/bin/env node
// scripts/count-substituted-inputs.mjs -- over the pre-registered 586, how many scores were computed from a value the
// scorer SUBSTITUTED rather than measured? Read only. (2026-11-20, the reviewer: "count first, do not touch
// edge-scoring yet".) First run as a scratch script on 2026-11-20 13:24 PT; committed here because the count is
// load-bearing: it is why a declared re-run did not fire.
//
// THE FIVE PATHS (core/edge-scoring.js, read 2026-11-20; the volRatio line unchanged since 7bbf2e4, 2026-08-09, before
// the sample's first buy on 08-17), each with the exact signature it leaves:
//   (a) prevClose = snap.prevDailyBar?.c || price     -> prevClose === price (todayChange exactly 0, momentum 0)
//   (b) volume    = snap.dailyBar?.v || 0              -> volume 0, so volRatio exactly 0
//   (c) volRatio  = avgVol10 > 0 ? volume / avgVol10 : 1 -> volRatio exactly 1 (the TOP of the volume ladder)
//   (d) calcEntryTargetStop's default multipliers      -> a duration other than DAY / 3-DAY / WEEK (target and stop
//       only; it cannot reach the score)
//   (e) MACRO_ADJUSTMENTS[condition]?.[category] ?? 0  -> a condition or category that is not a key of the table
// HOW (route 1: visible on the row, no replay): volume_ratio_at_buy is the scorer's own s.volRatio (app.js:4935) at
// full precision on all 586, so (b) and (c) show directly. signal_snapshot_at_buy (db/033) holds the scorer's whole
// output on the trades it covers, so (a), (c) via avgVol10 recomputed from the stored bars, and (e) show there. Where
// a path cannot be seen, it is NOT ESTABLISHED, never zero, and (a)'s bound is printed.
// ALSO, OUTSIDE THE FIVE: the stale daily bar (dailyBarAgeTradingDays > 0), three states: stale, fresh, not recorded.
//   node scripts/count-substituted-inputs.mjs [--rev 314f6e0]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REV = '314f6e0';
export const DURATIONS = ['DAY', '3-DAY', 'WEEK'];
export const RERUN_SPENT = 'THE DECLARED RE-RUN (CC-romans-call-audit, section 2) IS SPENT WITHOUT BEING USED: the established count is 0, and no exclusion rule isolates path (a) (the reviewer, 2026-11-20). ef99790 stood.';
export const SUPERSEDED = 'SUPERSEDED: whether the scores\' INPUTS were measured was overtaken by measuring the OUTCOME directly: the entry-price rule (CC-the-entry-price-is-the-outcome-variable, section 3) re-ran the score test on corrected returns (84d161a: rho -0.0506, p 0.6016, no relationship) and the P&L was recomputed at traded prices (8bc7432) and at the quote (ece5bdd).';

// the macro table's keys, read from the scorer's own source (so a table change is seen here)
export function macroKeys(src) {
  const lines = src.split('\n').map(l => l.replace(/\r$/, ''));
  const a = lines.indexOf('const MACRO_ADJUSTMENTS = {');
  if (a < 0) throw new Error('core/edge-scoring.js: no "const MACRO_ADJUSTMENTS = {" line');
  const t = new Function(lines.slice(a, lines.indexOf('};', a) + 1).join('\n') + '\nreturn MACRO_ADJUSTMENTS;')();
  return { conditions: new Set(Object.keys(t)), categories: new Set(Object.keys(Object.values(t)[0])) };
}
export const avgVol10 = bars => { const v = [...bars].sort((x, y) => new Date(x.t) - new Date(y.t)).map(b => b.v).slice(-10); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };

export function count(trades, snapsByPosition, keys) {
  const withSnap = [], noSnap = [];
  for (const r of trades) { const s = r.position_id != null ? snapsByPosition.get(String(r.position_id))?.snapshot : null; (s ? withSnap : noSnap).push({ r, s }); }
  const vr = trades.map(r => (r.volume_ratio_at_buy == null || r.volume_ratio_at_buy === '' ? null : Number(r.volume_ratio_at_buy)));
  const out = {
    n: trades.length, withSnap: withSnap.length, noSnap: noSnap.length,
    ratioMissing: vr.filter(v => v == null).length,
    c_ratioOne: vr.filter(v => v === 1).length,
    b_ratioZero: vr.filter(v => v === 0).length,
    a_snap: withSnap.filter(x => x.s.prevClose === x.s.price).length,
    c_snapAvgZero: withSnap.filter(x => !(avgVol10(x.s.bars || []) > 0)).length,
    snapRatioMismatch: withSnap.filter(x => { const av = avgVol10(x.s.bars || []); return Math.abs((av > 0 ? x.s.volume / av : 1) - x.s.volRatio) > 1e-9 || Math.abs(x.s.volRatio - Number(x.r.volume_ratio_at_buy)) > 1e-12; }).length,
    a_boundNoSnap: noSnap.filter(x => x.r.price_momentum_pts == null || Number(x.r.price_momentum_pts) === 0).length,
    d_other: trades.filter(r => !DURATIONS.includes(r.duration_classification)).length,
    e_snapMiss: withSnap.filter(x => x.s.macroCondition && x.s.category && (!keys.conditions.has(x.s.macroCondition) || !keys.categories.has(x.s.category))).length,
    e_conditionMissNoSnap: noSnap.filter(x => x.r.macro_condition && !keys.conditions.has(x.r.macro_condition)).length,
    stale: withSnap.filter(x => x.s.dailyBarAgeTradingDays > 0).length,
    fresh: withSnap.filter(x => x.s.dailyBarAgeTradingDays === 0).length,
    staleNotRecorded: withSnap.filter(x => x.s.dailyBarAgeTradingDays == null).length,
  };
  out.established = out.c_ratioOne + out.b_ratioZero + out.a_snap + out.e_snapMiss;
  return out;
}

async function main() {
  const rev = (i => (i < 0 ? REV : process.argv[i + 1]))(process.argv.indexOf('--rev'));
  const show = f => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${rev}:data/backups/${f}`, { cwd: ROOT, maxBuffer: 2e9 }).toString()));
  const trades = show('trades_v2.json').filter(r => r.sell_price_unverified === false);
  const snaps = new Map(show('signal_snapshot_at_buy.json').map(x => [String(x.position_id), x]));
  const keys = macroKeys(readFileSync(path.join(ROOT, 'core/edge-scoring.js'), 'utf8'));
  const c = count(trades, snaps, keys);
  console.log(`SOURCE: data/backups @ ${rev}: ${c.n} trades (sell_price_unverified false); ${c.withSnap} with a signal_snapshot_at_buy, ${c.noSnap} without.`);
  console.log(`stored volume_ratio_at_buy missing: ${c.ratioMissing}; on the snapshot trades, volRatio recomputed from the stored bars and volume disagrees with the snapshot or the row on ${c.snapRatioMismatch}.`);
  console.log(`(c) volRatio substituted as 1 (top of the ladder): ${c.c_ratioOne} of ${c.n}; avgVol10 not above 0 on the snapshot trades: ${c.c_snapAvgZero} of ${c.withSnap}.`);
  console.log(`(b) volume substituted as 0 (ratio exactly 0): ${c.b_ratioZero} of ${c.n}.`);
  console.log(`(a) prevClose substituted by the price: ${c.a_snap} of ${c.withSnap} where visible; NOT ESTABLISHED on ${c.noSnap}, at most ${c.a_boundNoSnap} of them (momentum 0 or not recorded).`);
  console.log(`(d) a duration outside DAY / 3-DAY / WEEK: ${c.d_other} of ${c.n}; cannot reach the score.`);
  console.log(`(e) a macro lookup miss: ${c.e_snapMiss} of ${c.withSnap} where visible; on the ${c.noSnap}, a condition outside the table: ${c.e_conditionMissNoSnap}, category not stored (NOT ESTABLISHED).`);
  console.log(`ESTABLISHED SUBSTITUTIONS: ${c.established}.`);
  console.log(`OUTSIDE THE FIVE, the stale daily bar: stale ${c.stale}, fresh ${c.fresh}, not recorded ${c.staleNotRecorded}, of ${c.withSnap}; nothing on the other ${c.noSnap}.`);
  console.log(`\n${RERUN_SPENT}`);
  console.log(SUPERSEDED);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
