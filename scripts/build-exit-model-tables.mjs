#!/usr/bin/env node
// Phase 9 §3.2/§3.3 — builds Model A and Model B lookup tables from the
// §3.1 dataset (artifacts/exit-model-dataset/rows.ndjson), per §3.1.3's
// and §3.1.4's settled decisions:
//
// - Day-of-hold "0" is ALWAYS NOT_EVALUATED (§3.1.3): daily bars cannot
//   express an intraday-relative-to-entry drawdown, so there is no data
//   at any fallback level for day 0, structurally, not by thinness. This
//   is 13/37 of Roman's real trades (same-day), so it is the common case,
//   not an edge case. NEVER substitute the day-1 cell as a proxy for it.
// - Entry-day momentum is a FIFTH DIMENSION (a population split), not a
//   filter (§3.1.4): 21/45 of Roman's real trades (BTDR, PGEN among them
//   -- 2 of his 3 loss-defining trades) fail the momentum precondition,
//   so neither the full band nor the momentum-restricted population
//   alone describes him. Two complete, separate tables are built: one
//   from momentum-qualified entries only, one from the rest.
// - Three-part minimum (n_rows>=100, n_symbols>=30, n_dates>=20) stays as
//   a guard.
// - Fallback hierarchy (§3.2's own text): a thin cell drops the volume
//   dimension first, then RSI too. Day-of-hold and the loss/gain band are
//   NEVER dropped.
//
// CORRECTED 2026-09-15 (caught before any UI wiring, replaying real trades
// exposed it): the first build keyed BOTH models on `drawdown` -- the
// CUMULATIVE WORST excursion from entry through day D -- not `return`, the
// point-in-time value at day D. Model A's own spec example ("TENX, down
// 6.2%, day 2") and the live app's pnlPct are both point-in-time returns,
// and Model B is about a CURRENTLY WINNING position ("I am up X% on day
// D") -- keying it on a cumulative DRAWDOWN (always <=0) meant a position
// that's up overall but dipped once, ever, during the hold was the only
// way into Model B's table at all, and a straight ascent never entered it.
// Fixed: `return` at day D is the single signed axis. ret<0 -> a loss band
// (-2/-4/-6/-8/-10/worse) feeds Model A. ret>0 -> a gain band
// (+2/+4/+6/+8/+10/better) feeds Model B. ret===0 exactly feeds neither
// (breakeven is not "down" or "up" and is vanishingly rare with real
// float prices). One partition, no overlap, no double-counting.
import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROWS_PATH = path.join(REPO_ROOT, 'artifacts', 'exit-model-dataset', 'rows.ndjson');

const MIN_ROWS = 100, MIN_SYMBOLS = 30, MIN_DATES = 20;
const FIRST_HALF_END = '2025-09-30';
const MOMENTUM_VOL_RATIO_MIN = 1.0;
const MOMENTUM_DAYOVERDAY_MIN = 2.0;

const LOSS_BANDS = ['-2', '-4', '-6', '-8', '-10', 'worse'];
const GAIN_BANDS = ['+2', '+4', '+6', '+8', '+10', 'better'];
const DAY_BUCKETS = ['0', '1', '2', '3+']; // '0' never populated -- see §3.1.3
const RSI_BANDS = ['<30', '30-45', '45-60', '>60'];
const VOL_BANDS = ['<0.75', '0.75-1.5', '>1.5'];
const BRANCHES = ['momentum', 'non_momentum'];
const PERIODS = ['full', 'first_half', 'second_half'];

function lossBand(retPct) { // retPct < 0 only
  if (retPct > -2) return '-2';
  if (retPct > -4) return '-4';
  if (retPct > -6) return '-6';
  if (retPct > -8) return '-8';
  if (retPct > -10) return '-10';
  return 'worse';
}
function gainBand(retPct) { // retPct > 0 only
  if (retPct < 2) return '+2';
  if (retPct < 4) return '+4';
  if (retPct < 6) return '+6';
  if (retPct < 8) return '+8';
  if (retPct < 10) return '+10';
  return 'better';
}
function rsiBand(rsi) {
  if (rsi == null) return null;
  if (rsi < 30) return '<30';
  if (rsi < 45) return '30-45';
  if (rsi < 60) return '45-60';
  return '>60';
}
function volBand(v) {
  if (v == null) return null;
  if (v < 0.75) return '<0.75';
  if (v < 1.5) return '0.75-1.5';
  return '>1.5';
}
function dayBucket(d) { return d === 1 ? '1' : d === 2 ? '2' : '3+'; }

// Histogram-bucketed median (0.1pp resolution) -- avoids holding raw
// arrays of up to ~1.28M x 7 values in memory across 2 models x 2
// branches x 3 periods x 3 fallback levels.
function histAdd(hist, value) {
  const bucket = Math.round(value * 1000);
  hist.set(bucket, (hist.get(bucket) || 0) + 1);
}
function histMedian(hist) {
  let total = 0;
  for (const c of hist.values()) total += c;
  if (total === 0) return null;
  const keys = [...hist.keys()].sort((a, b) => a - b);
  let cum = 0;
  const half = total / 2;
  for (const k of keys) { cum += hist.get(k); if (cum >= half) return k / 1000; }
  return null;
}

function newAggA() { return { rowCount: 0, symbols: new Set(), dates: new Set(), recoverable: 0, recovered: 0, worse: 0, returnHist: new Map() }; }
function newAggB() { return { rowCount: 0, symbols: new Set(), dates: new Set(), peakTotal: 0, peakIn: 0, higherTotal: 0, higher: 0, gainHist: new Map(), givebackHist: new Map() }; }

function recordA(agg, symbol, date, row, d, forwardD) {
  agg.rowCount++; agg.symbols.add(symbol); agg.dates.add(date);
  if (d > 5) return; // needs D+2 to exist within the 7-session window
  const f1 = row.forward[`d${d + 1}`], f2 = row.forward[`d${d + 2}`];
  const recovered = (f1 && f1.ret >= 0) || (f2 && f2.ret >= 0);
  agg.recoverable++;
  if (recovered) agg.recovered++;
  if (f2) {
    if (f2.ret < forwardD.ret) agg.worse++;
    histAdd(agg.returnHist, f2.ret);
  }
}
function recordB(agg, symbol, date, row, d, forwardD) {
  agg.rowCount++; agg.symbols.add(symbol); agg.dates.add(date);
  const closeAtD = 1 + forwardD.ret;
  let remainingMax = closeAtD;
  for (let k = d + 1; k <= 7; k++) {
    const fk = row.forward[`d${k}`];
    if (fk) remainingMax = Math.max(remainingMax, 1 + fk.ret);
  }
  agg.peakTotal++;
  if (closeAtD >= remainingMax) agg.peakIn++;
  if (d > 6) return; // needs D+1 to exist
  const fNext = row.forward[`d${d + 1}`];
  const f7 = row.forward.d7;
  if (fNext) {
    agg.higherTotal++;
    const closeNext = 1 + fNext.ret;
    if (closeNext > closeAtD) agg.higher++;
    histAdd(agg.gainHist, (closeNext - closeAtD) / closeAtD);
  }
  if (f7) {
    const close7 = 1 + f7.ret;
    histAdd(agg.givebackHist, (close7 - closeAtD) / closeAtD);
  }
}

function cellKey(band, day, rsi, vol) { return `${band}|${day}|${rsi}|${vol}`; }
function level1Key(band, day, rsi) { return `${band}|${day}|${rsi}`; }
function level2Key(band, day) { return `${band}|${day}`; }

async function main() {
  // mapsA/mapsB[period][branch][level] -> Map<key, agg>
  const mapsA = {}, mapsB = {};
  for (const period of PERIODS) {
    mapsA[period] = {}; mapsB[period] = {};
    for (const branch of BRANCHES) {
      mapsA[period][branch] = { l0: new Map(), l1: new Map(), l2: new Map() };
      mapsB[period][branch] = { l0: new Map(), l1: new Map(), l2: new Map() };
    }
  }

  const rl = createInterface({ input: createReadStream(ROWS_PATH), crlfDelay: Infinity });
  let linesRead = 0;
  for await (const line of rl) {
    if (!line) continue;
    linesRead++;
    const row = JSON.parse(line);
    const branch = (row.volRatio != null && row.volRatio >= MOMENTUM_VOL_RATIO_MIN
      && row.entryDayOverDayPct != null && row.entryDayOverDayPct >= MOMENTUM_DAYOVERDAY_MIN)
      ? 'momentum' : 'non_momentum';
    const periodsForRow = row.date <= FIRST_HALF_END ? ['full', 'first_half'] : ['full', 'second_half'];

    for (let d = 1; d <= 7; d++) {
      const f = row.forward[`d${d}`];
      if (!f) continue;
      const retPct = f.ret * 100;
      if (retPct === 0) continue; // exact breakeven -- neither model's domain
      const isLoss = retPct < 0;
      const band = isLoss ? lossBand(retPct) : gainBand(retPct);
      const rb = rsiBand(f.rsi14), vb = volBand(f.volRatio);
      if (rb == null || vb == null) continue;
      const day = dayBucket(d);
      const k0 = cellKey(band, day, rb, vb), k1 = level1Key(band, day, rb), k2 = level2Key(band, day);
      const maps = isLoss ? mapsA : mapsB;
      const newAgg = isLoss ? newAggA : newAggB;
      const record = isLoss ? recordA : recordB;

      for (const period of periodsForRow) {
        const m = maps[period][branch];
        let a0 = m.l0.get(k0); if (!a0) { a0 = newAgg(); m.l0.set(k0, a0); }
        let a1 = m.l1.get(k1); if (!a1) { a1 = newAgg(); m.l1.set(k1, a1); }
        let a2 = m.l2.get(k2); if (!a2) { a2 = newAgg(); m.l2.set(k2, a2); }
        record(a0, row.symbol, row.date, row, d, f);
        record(a1, row.symbol, row.date, row, d, f);
        record(a2, row.symbol, row.date, row, d, f);
      }
    }
    if (linesRead % 300000 === 0) console.error(`[tables] ...${linesRead} rows`);
  }
  console.error(`[tables] streamed ${linesRead} rows total`);

  function passes(a) { return !!a && a.rowCount >= MIN_ROWS && a.symbols.size >= MIN_SYMBOLS && a.dates.size >= MIN_DATES; }
  function statsA(a) {
    return {
      n: a.rowCount, n_symbols: a.symbols.size, n_dates: a.dates.size,
      p_recover_2d: a.recoverable > 0 ? +((a.recovered / a.recoverable) * 100).toFixed(1) : null,
      median_return_2d: histMedian(a.returnHist),
      p_worse_2d: a.recoverable > 0 ? +((a.worse / a.recoverable) * 100).toFixed(1) : null,
    };
  }
  function statsB(a) {
    return {
      n: a.rowCount, n_symbols: a.symbols.size, n_dates: a.dates.size,
      p_peak_already_in: a.peakTotal > 0 ? +((a.peakIn / a.peakTotal) * 100).toFixed(1) : null,
      p_higher_close_tomorrow: a.higherTotal > 0 ? +((a.higher / a.higherTotal) * 100).toFixed(1) : null,
      median_additional_gain_1d: histMedian(a.gainHist),
      median_giveback_to_day7: histMedian(a.givebackHist),
    };
  }

  function resolveCell(maps, statsFn, period, branch, band, day, rb, vb) {
    if (day === '0') return { resolvedLevel: 'NOT_EVALUATED', reason: 'day_0_structural' };
    const m = maps[period][branch];
    const a0 = m.l0.get(cellKey(band, day, rb, vb));
    if (passes(a0)) return { resolvedLevel: 'level0', stats: statsFn(a0) };
    const a1 = m.l1.get(level1Key(band, day, rb));
    if (passes(a1)) return { resolvedLevel: 'level1_drop_volume', stats: statsFn(a1) };
    const a2 = m.l2.get(level2Key(band, day));
    if (passes(a2)) return { resolvedLevel: 'level2_drop_volume_rsi', stats: statsFn(a2) };
    return { resolvedLevel: 'NOT_EVALUATED', reason: 'thin_at_every_level' };
  }

  function buildBranchTable(maps, statsFn, bands, period, branch) {
    const cells = {};
    const counts = { level0: 0, level1_drop_volume: 0, level2_drop_volume_rsi: 0, NOT_EVALUATED: 0, NOT_EVALUATED_day0: 0 };
    for (const band of bands) for (const day of DAY_BUCKETS) for (const rb of RSI_BANDS) for (const vb of VOL_BANDS) {
      const key = cellKey(band, day, rb, vb);
      const r = resolveCell(maps, statsFn, period, branch, band, day, rb, vb);
      cells[key] = r;
      if (r.resolvedLevel === 'NOT_EVALUATED') {
        counts.NOT_EVALUATED++;
        if (r.reason === 'day_0_structural') counts.NOT_EVALUATED_day0++;
      } else counts[r.resolvedLevel]++;
    }
    return { cells, counts, total: bands.length * DAY_BUCKETS.length * RSI_BANDS.length * VOL_BANDS.length };
  }

  const prodA = {}, prodB = {};
  const shapeReport = { modelA: {}, modelB: {} };
  for (const branch of BRANCHES) {
    prodA[branch] = buildBranchTable(mapsA, statsA, LOSS_BANDS, 'full', branch);
    prodB[branch] = buildBranchTable(mapsB, statsB, GAIN_BANDS, 'full', branch);
    shapeReport.modelA[branch] = { ...prodA[branch].counts, total: prodA[branch].total };
    shapeReport.modelB[branch] = { ...prodB[branch].counts, total: prodB[branch].total };
  }

  // ── Out-of-sample on the production (post-fallback) tables ──
  function oosForModel(maps, statsFn, bands, metricKey) {
    const out = {};
    for (const branch of BRANCHES) {
      const t1 = buildBranchTable(maps, statsFn, bands, 'first_half', branch);
      const t2 = buildBranchTable(maps, statsFn, bands, 'second_half', branch);
      const diffs = [];
      for (const key of Object.keys(t1.cells)) {
        const c1 = t1.cells[key], c2 = t2.cells[key];
        if (c1.resolvedLevel === 'NOT_EVALUATED' || c2.resolvedLevel === 'NOT_EVALUATED') continue;
        const v1 = c1.stats[metricKey], v2 = c2.stats[metricKey];
        if (v1 == null || v2 == null) continue;
        diffs.push({ key, first_half: v1, second_half: v2, diff_pct_points: +(v2 - v1).toFixed(1) });
      }
      diffs.sort((a, b) => Math.abs(b.diff_pct_points) - Math.abs(a.diff_pct_points));
      out[branch] = diffs;
    }
    return out;
  }
  const oosA = oosForModel(mapsA, statsA, LOSS_BANDS, 'p_recover_2d');
  const oosB = oosForModel(mapsB, statsB, GAIN_BANDS, 'p_peak_already_in');

  // ── Write production tables ──
  const dataDir = path.join(REPO_ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });
  const modelA = { builtAt: new Date().toISOString(), minRows: MIN_ROWS, minSymbols: MIN_SYMBOLS, minDates: MIN_DATES, bands: LOSS_BANDS, branches: {} };
  const modelB = { builtAt: new Date().toISOString(), minRows: MIN_ROWS, minSymbols: MIN_SYMBOLS, minDates: MIN_DATES, bands: GAIN_BANDS, branches: {} };
  for (const branch of BRANCHES) {
    modelA.branches[branch] = {};
    modelB.branches[branch] = {};
    for (const [key, r] of Object.entries(prodA[branch].cells)) {
      modelA.branches[branch][key] = r.resolvedLevel === 'NOT_EVALUATED'
        ? { status: 'NOT_EVALUATED', reason: r.reason }
        : { status: 'evaluated', resolvedLevel: r.resolvedLevel, ...r.stats };
    }
    for (const [key, r] of Object.entries(prodB[branch].cells)) {
      modelB.branches[branch][key] = r.resolvedLevel === 'NOT_EVALUATED'
        ? { status: 'NOT_EVALUATED', reason: r.reason }
        : { status: 'evaluated', resolvedLevel: r.resolvedLevel, ...r.stats };
    }
  }
  writeFileSync(path.join(dataDir, 'exit-model-a.json'), JSON.stringify(modelA, null, 2));
  writeFileSync(path.join(dataDir, 'exit-model-b.json'), JSON.stringify(modelB, null, 2));

  console.log('\n[tables] === SHAPE REPORT ===');
  console.log(JSON.stringify(shapeReport, null, 2));
  console.log('\n[tables] === OOS Model A (p_recover_2d), 5 worst per branch ===');
  for (const branch of BRANCHES) console.log(`-- ${branch} (${oosA[branch].length} comparable) --\n`, JSON.stringify(oosA[branch].slice(0, 5), null, 2));
  console.log('\n[tables] === OOS Model B (p_peak_already_in), 5 worst per branch ===');
  for (const branch of BRANCHES) console.log(`-- ${branch} (${oosB[branch].length} comparable) --\n`, JSON.stringify(oosB[branch].slice(0, 5), null, 2));
}

main().catch((err) => { console.error('[tables] FAILED —', err.message, err.stack); process.exit(1); });
