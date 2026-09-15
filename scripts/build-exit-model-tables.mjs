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
//   a guard (§3.1.3 found it currently non-binding across all 216
//   populated cells -- zero cells fail on symbols/dates alone -- but it
//   is not removed).
// - Fallback hierarchy (§3.2's own text): a thin cell drops the volume
//   dimension first, then RSI too. Day-of-hold and drawdown band are
//   NEVER dropped -- those are the two dimensions the floor/cut-loss
//   question is actually about.
//
// Reads the same rows.ndjson build-exit-model-dataset.mjs produces
// (streamed, never materialized as one array). Writes
// data/exit-model-a.json and data/exit-model-b.json -- small, committed,
// same pattern as data/float-table.json (NOT the raw dataset, which stays
// in gitignored artifacts/).
import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROWS_PATH = path.join(REPO_ROOT, 'artifacts', 'exit-model-dataset', 'rows.ndjson');

const MIN_ROWS = 100, MIN_SYMBOLS = 30, MIN_DATES = 20;
const FIRST_HALF_END = '2025-09-30'; // matches §3.1.2/§3.1.3's fit/validate split
const MOMENTUM_VOL_RATIO_MIN = 1.0;
const MOMENTUM_DAYOVERDAY_MIN = 2.0;

const DD_BANDS = ['-2', '-4', '-6', '-8', '-10', 'worse'];
const DAY_BUCKETS = ['0', '1', '2', '3+']; // '0' never populated -- see header
const RSI_BANDS = ['<30', '30-45', '45-60', '>60'];
const VOL_BANDS = ['<0.75', '0.75-1.5', '>1.5'];
const BRANCHES = ['momentum', 'non_momentum'];
const PERIODS = ['full', 'first_half', 'second_half'];

function drawdownBand(dd) {
  const pct = dd * 100;
  if (pct > 0) return null;
  if (pct > -2) return '-2';
  if (pct > -4) return '-4';
  if (pct > -6) return '-6';
  if (pct > -8) return '-8';
  if (pct > -10) return '-10';
  return 'worse';
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

// Histogram-bucketed median (0.1 percentage-point resolution) -- avoids
// holding raw arrays of up to ~1.28M x 7 values in memory across 2
// branches x 3 periods x 3 fallback levels. +/-0.05pp of true median.
function histAdd(hist, value) {
  const bucket = Math.round(value * 1000); // 0.1pp buckets, value is a fraction
  hist.set(bucket, (hist.get(bucket) || 0) + 1);
}
function histMedian(hist) {
  let total = 0;
  for (const c of hist.values()) total += c;
  if (total === 0) return null;
  const keys = [...hist.keys()].sort((a, b) => a - b);
  let cum = 0;
  const half = total / 2;
  for (const k of keys) {
    cum += hist.get(k);
    if (cum >= half) return k / 1000;
  }
  return null;
}

function newAgg() {
  return {
    rowCount: 0, symbols: new Set(), dates: new Set(),
    // Model A (D<=5 only -- needs D+2 to exist within the 7-day window)
    a_recoverable: 0, a_recovered: 0, a_worse: 0, a_returnHist: new Map(),
    // Model B
    b_peakTotal: 0, b_peakIn: 0,           // any D in 1..7
    b_higherTotal: 0, b_higher: 0,          // D<=6 (needs D+1)
    b_gainHist: new Map(),                  // D<=6
    b_givebackHist: new Map(),              // D<=6
  };
}
function recordState(agg, symbol, date, row, d, forwardD) {
  agg.rowCount++; agg.symbols.add(symbol); agg.dates.add(date);
  if (d <= 5) {
    const f1 = row.forward[`d${d + 1}`], f2 = row.forward[`d${d + 2}`];
    const recovered = (f1 && f1.ret >= 0) || (f2 && f2.ret >= 0);
    agg.a_recoverable++;
    if (recovered) agg.a_recovered++;
    if (f2) {
      if (f2.ret < forwardD.ret) agg.a_worse++;
      histAdd(agg.a_returnHist, f2.ret);
    }
  }
  // Model B: remaining-window peak check, any D in 1..7.
  const closeAtD = 1 + forwardD.ret; // relative to entryClose=1
  let remainingMax = closeAtD;
  for (let k = d + 1; k <= 7; k++) {
    const fk = row.forward[`d${k}`];
    if (fk) remainingMax = Math.max(remainingMax, 1 + fk.ret);
  }
  agg.b_peakTotal++;
  if (closeAtD >= remainingMax) agg.b_peakIn++;
  if (d <= 6) {
    const fNext = row.forward[`d${d + 1}`];
    const f7 = row.forward.d7;
    if (fNext) {
      agg.b_higherTotal++;
      const closeNext = 1 + fNext.ret;
      if (closeNext > closeAtD) agg.b_higher++;
      histAdd(agg.b_gainHist, (closeNext - closeAtD) / closeAtD);
    }
    if (f7) {
      const close7 = 1 + f7.ret;
      histAdd(agg.b_givebackHist, (close7 - closeAtD) / closeAtD);
    }
  }
}

function cellKey(dd, day, rsi, vol) { return `${dd}|${day}|${rsi}|${vol}`; }
function level1Key(dd, day, rsi) { return `${dd}|${day}|${rsi}`; }
function level2Key(dd, day) { return `${dd}|${day}`; }

async function main() {
  // maps[period][branch][level] -> Map<key, agg>
  const maps = {};
  for (const period of PERIODS) {
    maps[period] = {};
    for (const branch of BRANCHES) {
      maps[period][branch] = { l0: new Map(), l1: new Map(), l2: new Map() };
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
      const dd = drawdownBand(f.drawdown);
      if (dd == null) continue;
      const rb = rsiBand(f.rsi14), vb = volBand(f.volRatio);
      if (rb == null || vb == null) continue;
      const day = dayBucket(d);
      const k0 = cellKey(dd, day, rb, vb), k1 = level1Key(dd, day, rb), k2 = level2Key(dd, day);

      for (const period of periodsForRow) {
        const m = maps[period][branch];
        let a0 = m.l0.get(k0); if (!a0) { a0 = newAgg(); m.l0.set(k0, a0); }
        let a1 = m.l1.get(k1); if (!a1) { a1 = newAgg(); m.l1.set(k1, a1); }
        let a2 = m.l2.get(k2); if (!a2) { a2 = newAgg(); m.l2.set(k2, a2); }
        recordState(a0, row.symbol, row.date, row, d, f);
        recordState(a1, row.symbol, row.date, row, d, f);
        recordState(a2, row.symbol, row.date, row, d, f);
      }
    }
    if (linesRead % 300000 === 0) console.error(`[tables] ...${linesRead} rows`);
  }
  console.error(`[tables] streamed ${linesRead} rows total`);

  function passes(a) { return !!a && a.rowCount >= MIN_ROWS && a.symbols.size >= MIN_SYMBOLS && a.dates.size >= MIN_DATES; }

  function modelAStats(a) {
    return {
      n: a.rowCount, n_symbols: a.symbols.size, n_dates: a.dates.size,
      p_recover_2d: a.a_recoverable > 0 ? +((a.a_recovered / a.a_recoverable) * 100).toFixed(1) : null,
      median_return_2d: histMedian(a.a_returnHist),
      p_worse_2d: a.a_recoverable > 0 ? +((a.a_worse / a.a_recoverable) * 100).toFixed(1) : null,
    };
  }
  function modelBStats(a) {
    return {
      n: a.rowCount, n_symbols: a.symbols.size, n_dates: a.dates.size,
      p_peak_already_in: a.b_peakTotal > 0 ? +((a.b_peakIn / a.b_peakTotal) * 100).toFixed(1) : null,
      p_higher_close_tomorrow: a.b_higherTotal > 0 ? +((a.b_higher / a.b_higherTotal) * 100).toFixed(1) : null,
      median_additional_gain_1d: histMedian(a.b_gainHist),
      median_giveback_to_day7: histMedian(a.b_givebackHist),
    };
  }

  // Resolve one nominal cell through the 3-level fallback for one
  // (period, branch), returning {resolvedLevel, statsA, statsB} or
  // {resolvedLevel:'NOT_EVALUATED'}. Day '0' short-circuits immediately --
  // no fallback lookup even attempted, per §3.1.3.
  function resolveCell(period, branch, dd, day, rb, vb) {
    if (day === '0') return { resolvedLevel: 'NOT_EVALUATED', reason: 'day_0_structural' };
    const m = maps[period][branch];
    const a0 = m.l0.get(cellKey(dd, day, rb, vb));
    if (passes(a0)) return { resolvedLevel: 'level0', statsA: modelAStats(a0), statsB: modelBStats(a0) };
    const a1 = m.l1.get(level1Key(dd, day, rb));
    if (passes(a1)) return { resolvedLevel: 'level1_drop_volume', statsA: modelAStats(a1), statsB: modelBStats(a1) };
    const a2 = m.l2.get(level2Key(dd, day));
    if (passes(a2)) return { resolvedLevel: 'level2_drop_volume_rsi', statsA: modelAStats(a2), statsB: modelBStats(a2) };
    return { resolvedLevel: 'NOT_EVALUATED', reason: 'thin_at_every_level' };
  }

  function buildBranchTable(period, branch) {
    const cells = {};
    const counts = { level0: 0, level1_drop_volume: 0, level2_drop_volume_rsi: 0, NOT_EVALUATED: 0, NOT_EVALUATED_day0: 0 };
    for (const dd of DD_BANDS) for (const day of DAY_BUCKETS) for (const rb of RSI_BANDS) for (const vb of VOL_BANDS) {
      const key = cellKey(dd, day, rb, vb);
      const r = resolveCell(period, branch, dd, day, rb, vb);
      cells[key] = r;
      if (r.resolvedLevel === 'NOT_EVALUATED') {
        counts.NOT_EVALUATED++;
        if (r.reason === 'day_0_structural') counts.NOT_EVALUATED_day0++;
      } else counts[r.resolvedLevel]++;
    }
    return { cells, counts, total: DD_BANDS.length * DAY_BUCKETS.length * RSI_BANDS.length * VOL_BANDS.length };
  }

  const production = {};
  const shapeReport = {};
  for (const branch of BRANCHES) {
    production[branch] = buildBranchTable('full', branch);
    shapeReport[branch] = production[branch].counts;
    shapeReport[branch].total = production[branch].total;
  }

  // ── Out-of-sample: resolve first_half and second_half tables the SAME
  // way (full fallback hierarchy, not raw level-0 only), then compare
  // p_recover_2d on cells that resolve (pass, not NOT_EVALUATED) in BOTH
  // halves for the SAME branch. This is the production table's own OOS
  // stability, not a re-run of the earlier task-3 level-0-only check.
  const oosDiffs = { momentum: [], non_momentum: [] };
  for (const branch of BRANCHES) {
    const firstTable = buildBranchTable('first_half', branch);
    const secondTable = buildBranchTable('second_half', branch);
    for (const key of Object.keys(firstTable.cells)) {
      const c1 = firstTable.cells[key], c2 = secondTable.cells[key];
      if (c1.resolvedLevel === 'NOT_EVALUATED' || c2.resolvedLevel === 'NOT_EVALUATED') continue;
      if (c1.statsA.p_recover_2d == null || c2.statsA.p_recover_2d == null) continue;
      oosDiffs[branch].push({
        key, p_recover_first_half: c1.statsA.p_recover_2d, p_recover_second_half: c2.statsA.p_recover_2d,
        diff_pct_points: +(c2.statsA.p_recover_2d - c1.statsA.p_recover_2d).toFixed(1),
      });
    }
    oosDiffs[branch].sort((a, b) => Math.abs(b.diff_pct_points) - Math.abs(a.diff_pct_points));
  }

  // ── Write production tables (small, committed) ──
  const dataDir = path.join(REPO_ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });
  const modelA = { builtAt: new Date().toISOString(), minRows: MIN_ROWS, minSymbols: MIN_SYMBOLS, minDates: MIN_DATES, branches: {} };
  const modelB = { builtAt: new Date().toISOString(), minRows: MIN_ROWS, minSymbols: MIN_SYMBOLS, minDates: MIN_DATES, branches: {} };
  for (const branch of BRANCHES) {
    modelA.branches[branch] = {};
    modelB.branches[branch] = {};
    for (const [key, r] of Object.entries(production[branch].cells)) {
      modelA.branches[branch][key] = r.resolvedLevel === 'NOT_EVALUATED'
        ? { status: 'NOT_EVALUATED', reason: r.reason }
        : { status: 'evaluated', resolvedLevel: r.resolvedLevel, ...r.statsA };
      modelB.branches[branch][key] = r.resolvedLevel === 'NOT_EVALUATED'
        ? { status: 'NOT_EVALUATED', reason: r.reason }
        : { status: 'evaluated', resolvedLevel: r.resolvedLevel, ...r.statsB };
    }
  }
  writeFileSync(path.join(dataDir, 'exit-model-a.json'), JSON.stringify(modelA, null, 2));
  writeFileSync(path.join(dataDir, 'exit-model-b.json'), JSON.stringify(modelB, null, 2));

  console.log('\n[tables] === SHAPE REPORT ===');
  console.log(JSON.stringify(shapeReport, null, 2));
  console.log('\n[tables] === OOS: 5 worst swings per branch (production tables, post-fallback) ===');
  for (const branch of BRANCHES) {
    console.log(`\n-- ${branch} (${oosDiffs[branch].length} cells resolvable in both halves) --`);
    console.log(JSON.stringify(oosDiffs[branch].slice(0, 5), null, 2));
  }
}

main().catch((err) => { console.error('[tables] FAILED —', err.message, err.stack); process.exit(1); });
