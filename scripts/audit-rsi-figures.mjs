// scripts/audit-rsi-figures.mjs -- where did the RSI-band figures in the specs
// come from? (2026-11-03.) The report's "RSI points" buckets group by rsi_pts
// and filed scoring-v2 trades with RSI <35 under "Got 0 (RSI 65-75)", so any
// figure taken from those buckets is wrong. This recomputes every RSI-band
// figure the phase-10 spec quotes DIRECTLY from the RSI value of each pinned
// row, and prints what the report's buckets would have said beside it.
//   node scripts/audit-rsi-figures.mjs
// Source: data/backups at the pins named in each line. No network.
// Guarded by tests/rsi-figure-provenance.test.js.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (rev, t) => (j => Array.isArray(j) ? j : j.rows)(JSON.parse(execSync(`git show ${rev}:data/backups/${t}.json`, { cwd: ROOT, maxBuffer: 2e9 }).toString()));
const round = (x, d = 2) => Number(x.toFixed(d));

export function tradeStats(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  return {
    n, winPct: round(100 * rows.filter(r => Number(r.pnl_dollars) > 0).length / n, 1),
    avgPct: round(rows.reduce((s, r) => s + Number(r.pnl_pct), 0) / n),
    pnl: Math.round(rows.reduce((s, r) => s + Number(r.pnl_dollars), 0)),
  };
}
const inBand = (rows, lo, hi, rsiOf = r => r.rsi_at_buy) => rows.filter(r => rsiOf(r) != null && Number(rsiOf(r)) >= lo && Number(rsiOf(r)) < hi);

// §1, §2, §3, §3.5: the 270 resolved trades of the 2026-10-21 report.
export function historyFigures(rev = '80f52fb') {
  const all = load(rev, 'trades_v2').filter(r => !r.sell_price_unverified);
  const reg = all.filter(r => r.buy_session === 'REGULAR');
  const hm = r => String(r.buy_time).slice(0, 5);
  const out = { rev, rows: all.length, regular: reg.length, regularBands: {}, all: {}, timeCells: {} };
  for (const [k, lo, hi] of [['<35', -1e9, 35], ['35-45', 35, 45], ['45-50', 45, 50], ['50-55', 50, 55], ['55-65', 55, 65], ['65+', 65, 1e9]]) out.regularBands[k] = tradeStats(inBand(reg, lo, hi));
  out.all['45-55'] = tradeStats(inBand(all, 45, 55));
  out.all['not 45-55'] = tradeStats(all.filter(r => !(Number(r.rsi_at_buy) >= 45 && Number(r.rsi_at_buy) < 55)));
  out.all['<30'] = tradeStats(inBand(all, -1e9, 30));
  out.all['42-58'] = tradeStats(inBand(all, 42, 58));
  for (const [t, a, b] of [['open-7:30', '06:30', '07:30'], ['7:30-10:00', '07:30', '10:00'], ['10:00+', '10:00', '99:99']]) {
    const w = reg.filter(r => hm(r) >= a && hm(r) < b);
    for (const [k, lo, hi] of [['<45', -1e9, 45], ['45-55', 45, 55], ['55+', 55, 1e9]]) out.timeCells[`${t} ${k}`] = tradeStats(inBand(w, lo, hi));
  }
  return out;
}

// §1 "first out-of-sample look", §7.3, §7.6: forward trades against history.
export function forwardFigures(rev = '0775407') {
  const sold = load(rev, 'trades_v2').filter(r => r.sell_date != null);
  const fwd = sold.filter(r => r.code_version != null), base = sold.filter(r => r.code_version == null && !r.sell_price_unverified);
  const bands = {};
  for (const [k, lo, hi] of [['<35', -1e9, 35], ['35-45', 35, 45], ['45-55', 45, 55], ['55-65', 55, 65], ['65-75', 65, 75]]) bands[k] = { forward: tradeStats(inBand(fwd, lo, hi)), history: tradeStats(inBand(base, lo, hi)) };
  // What the report's RSI-points buckets would have printed for the same trades.
  const reportBuckets = {};
  for (const p of [20, 15, 0]) {
    const t = fwd.filter(r => r.rsi_pts === p), rsis = t.map(r => Number(r.rsi_at_buy));
    reportBuckets[p] = { ...tradeStats(t), rsiMin: round(Math.min(...rsis), 1), rsiMax: round(Math.max(...rsis), 1), underRsi35: t.filter(r => Number(r.rsi_at_buy) < 35).length };
  }
  return { rev, forward: fwd.length, history: base.length, bands, reportBuckets };
}

// §7.2: exit-free, day-adjusted, on signal_log (RSI from the row's snapshot).
// ret_* are stored as fractions; the spec's "pts" are percentage points.
export function signalLogFigures(rev = '80f52fb', asof = '2026-10-21') {
  const rsi = r => { const s = typeof r.signal_snapshot === 'string' ? JSON.parse(r.signal_snapshot) : r.signal_snapshot; return s?.rsi == null ? null : Number(s.rsi); };
  const edge = load(rev, 'signal_log').filter(r => r.engine_source === 'EDGE' && String(r.signal_date).slice(0, 10) <= asof);
  const horizons = {};
  for (const h of ['ret_30m', 'ret_close', 'ret_1d', 'ret_3d']) {
    const v = edge.filter(r => r[h] != null && rsi(r) != null);
    const byDay = {};
    for (const r of v) (byDay[r.signal_date] = byDay[r.signal_date] || []).push(r);
    const mean = a => a.reduce((s, r) => s + Number(r[h]), 0) / a.length;
    const adj = [];
    let won = 0, compared = 0;
    for (const rows of Object.values(byDay)) {
      const dm = mean(rows), inside = rows.filter(r => rsi(r) >= 45 && rsi(r) < 58), outside = rows.filter(r => !(rsi(r) >= 45 && rsi(r) < 58));
      for (const r of rows) adj.push({ band: rsi(r) >= 45 && rsi(r) < 58, e: Number(r[h]) - dm });
      if (inside.length && outside.length) { compared++; if (mean(inside) > mean(outside)) won++; }
    }
    const avg = f => { const a = adj.filter(f); return a.reduce((s, x) => s + x.e, 0) / a.length; };
    horizons[h] = { rows: v.length, excess: round((avg(x => x.band) - avg(x => !x.band)) * 100), datesWon: won, datesCompared: compared };
  }
  // A band against the day mean over all EDGE signals (the floor, and 58-65).
  const vsDayMean = (h, lo, hi) => {
    const v = edge.filter(r => r[h] != null && rsi(r) != null);
    const dayMean = {};
    for (const d of new Set(v.map(r => r.signal_date))) { const a = v.filter(r => r.signal_date === d); dayMean[d] = a.reduce((s, r) => s + Number(r[h]), 0) / a.length; }
    const inside = v.filter(r => rsi(r) >= lo && rsi(r) < hi);
    return round(100 * inside.reduce((s, r) => s + Number(r[h]) - dayMean[r.signal_date], 0) / inside.length);
  };
  const bands = { '<42 ret_1d': vsDayMean('ret_1d', -1e9, 42), '<42 ret_3d': vsDayMean('ret_3d', -1e9, 42), '58-65 ret_1d': vsDayMean('ret_1d', 58, 65) };
  return { rev, asof, rows: edge.length, dates: new Set(edge.map(r => r.signal_date)).size, horizons, bands };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const show = (label, s) => console.log(`  ${label.padEnd(22)} n=${s.n} win ${s.winPct}% avg ${s.avgPct}% $${s.pnl}`);
  const h = historyFigures();
  console.log(`HISTORY, direct from rsi_at_buy, trades_v2 @ ${h.rev}: ${h.rows} verified, ${h.regular} regular-session`);
  for (const [k, s] of Object.entries(h.regularBands)) show(`regular ${k}`, s);
  for (const [k, s] of Object.entries(h.all)) show(`all ${k}`, s);
  for (const [k, s] of Object.entries(h.timeCells)) show(k, s);
  const f = forwardFigures();
  console.log(`\nFORWARD vs HISTORY, direct from rsi_at_buy, trades_v2 @ ${f.rev}: ${f.forward} forward, ${f.history} history`);
  for (const [k, b] of Object.entries(f.bands)) { show(`forward ${k}`, b.forward); show(`history ${k}`, b.history); }
  console.log(`\nTHE REPORT'S BUCKETS for those ${f.forward} forward trades (by rsi_pts), trades_v2 @ ${f.rev}:`);
  for (const [p, b] of Object.entries(f.reportBuckets)) console.log(`  rsi_pts ${String(p).padEnd(3)} n=${b.n} win ${b.winPct}% avg ${b.avgPct}% $${b.pnl} | actual RSI ${b.rsiMin}..${b.rsiMax} | RSI <35: ${b.underRsi35}`);
  for (const [rev, label] of [['80f52fb', 'as first computed'], ['d6e277d', 'as the 11-02 withdrawal counted']]) {
    const s = signalLogFigures(rev);
    console.log(`\nSIGNAL_LOG, direct from each row's snapshot RSI, @ ${rev} (${label}), EDGE, signal_date <= ${s.asof}: ${s.rows} rows, ${s.dates} dates. RSI 45-58 minus the rest, day-adjusted:`);
    for (const [k, x] of Object.entries(s.horizons)) console.log(`  ${k.padEnd(10)} ${x.excess >= 0 ? '+' : ''}${x.excess} pts | band won ${x.datesWon} of ${x.datesCompared} dates | ${x.rows} rows`);
    for (const [k, x] of Object.entries(s.bands)) console.log(`  RSI ${k} vs the day mean: ${x >= 0 ? '+' : ''}${x} pts`);
  }
}
