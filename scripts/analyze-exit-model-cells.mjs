#!/usr/bin/env node
// Phase 9 §3.1.1/§3.1.2 — cell-population and validity report for §3.2's
// Model A grid, run BEFORE any model table is built (Roman: "Report 2, 3
// and 4 as numbers before writing a single model table.").
//
// Reads artifacts/exit-model-dataset/rows.ndjson by line (930MB+ -- never
// materialized as one array; each cell only keeps a row count, a Set of
// symbols, a Set/count-map of dates, and a recovery tally).
//
// GRID (§3.2): drawdown band (6) x day-of-hold (4: 0,1,2,3+) x RSI band (4)
// x volume-ratio band (3) = 288 cells. Day-of-hold "0" is NOT populated by
// this dataset's structure: it would require an intraday-relative-to-entry
// drawdown daily bars can't express (entry day's own return is 0 by
// construction, never negative) -- disclosed, not silently zero-filled.
// Only d1..d7 (this dataset's forward window) populate day-of-hold
// buckets 1, 2, and "3+" (3-7 combined, per the grid's own coarse buckets).
//
// STATE = a row's forward[dD] snapshot for one D in 1..7: drawdown AT that
// day (cumulative worst excursion from entry through day D -- matches the
// field's own name, distinct from point-in-time return), RSI14/volRatio
// AT that day (not at entry -- see build-exit-model-dataset.mjs's
// 2026-09-15 fix). One row contributes up to 7 states, one per D.
//
// OUTCOME (p_recover, tasks 3/4 only): "recovers to break-even within 2
// sessions of day D" = ret[D+1] >= 0 OR ret[D+2] >= 0. Only computable
// when D+2 <= 7 (D <= 5) -- D=6/7 states still count toward population
// (task 2) but are excluded from p_recover (tasks 3/4) since this
// dataset's 7-day window has no d8/d9 to check. Disclosed simplification,
// not silently guessed.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROWS_PATH = path.join(REPO_ROOT, 'artifacts', 'exit-model-dataset', 'rows.ndjson');

const MIN_ROWS = 100, MIN_SYMBOLS = 30, MIN_DATES = 20;
const DATE_CONCENTRATION_FLAG = 0.20;

// First half: 2024-10 -> 2025-09. Second half: 2025-10 -> 2026-09. Split by
// ENTRY date (the row's own date), matching §3.1.2's "fit on X, validate
// on Y" framing -- a single hold's regime is set by when it started.
const FIRST_HALF_END = '2025-09-30';

// Momentum precondition (task 4), entry-day fields only: resembles the
// live scan's own reward zones in core/edge-scoring.js's scoreStock, not
// an arbitrary cutoff -- volRatio >= 1 is where volume scoring turns
// positive (15-20pts, "reliable liquidity signal"), entryDayOverDayPct >= 2
// is where price-momentum scoring turns positive (+10pts, elevated move).
// Disclosed approximation of "EDGE-qualified," not the full score/threshold
// gate -- deliberately simpler so it's auditable in one line.
const MOMENTUM_VOL_RATIO_MIN = 1.0;
const MOMENTUM_DAYOVERDAY_MIN = 2.0;

// Six contiguous half-open bands, descending from breakeven. dd is a
// fraction (e.g. -0.05 = -5%). A position at or above breakeven (pct > 0)
// has no band -- Model A only applies to an already-losing position, and
// this dataset's `drawdown` is the cumulative worst excursion through day
// D, so pct === 0 means "never dipped below entry," a real, distinct case
// from "down a little."
function drawdownBandFixed(dd) {
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
function dayBucket(d) {
  if (d === 1) return '1';
  if (d === 2) return '2';
  return '3+'; // d3..d7
}
function cellKey(dd, day, rsi, vol) { return `${dd}|${day}|${rsi}|${vol}`; }

function newAgg() { return { rowCount: 0, symbols: new Set(), dateCounts: new Map(), recoverable: 0, recovered: 0 }; }
function record(map, key, symbol, date, recoverable, recovered) {
  let a = map.get(key);
  if (!a) { a = newAgg(); map.set(key, a); }
  a.rowCount++;
  a.symbols.add(symbol);
  a.dateCounts.set(date, (a.dateCounts.get(date) || 0) + 1);
  if (recoverable) { a.recoverable++; if (recovered) a.recovered++; }
}

async function main() {
  const rl = createInterface({ input: createReadStream(ROWS_PATH), crlfDelay: Infinity });

  const cellsFull = new Map();       // task 2: full population, all dates
  const cellsFirstHalf = new Map();  // task 3
  const cellsSecondHalf = new Map(); // task 3
  const cellsRestricted = new Map(); // task 4: momentum-precondition-passing only

  let linesRead = 0;
  let rowsPassingMomentum = 0, rowsTotal = 0;

  for await (const line of rl) {
    if (!line) continue;
    linesRead++;
    const row = JSON.parse(line);
    rowsTotal++;
    const passesMomentum = row.volRatio != null && row.volRatio >= MOMENTUM_VOL_RATIO_MIN
      && row.entryDayOverDayPct != null && row.entryDayOverDayPct >= MOMENTUM_DAYOVERDAY_MIN;
    if (passesMomentum) rowsPassingMomentum++;
    const isFirstHalf = row.date <= FIRST_HALF_END;

    for (let d = 1; d <= 7; d++) {
      const f = row.forward[`d${d}`];
      if (!f) continue;
      const dd = drawdownBandFixed(f.drawdown);
      if (dd == null) continue; // not down enough to occupy any of Model A's bands
      const rb = rsiBand(f.rsi14);
      const vb = volBand(f.volRatio);
      if (rb == null || vb == null) continue;
      const day = dayBucket(d);
      const key = cellKey(dd, day, rb, vb);

      const recoverable = d <= 5; // D+2 <= 7, checkable from this dataset's window
      let recovered = false;
      if (recoverable) {
        const f1 = row.forward[`d${d + 1}`], f2 = row.forward[`d${d + 2}`];
        recovered = (f1 && f1.ret >= 0) || (f2 && f2.ret >= 0);
      }

      record(cellsFull, key, row.symbol, row.date, recoverable, recovered);
      record(isFirstHalf ? cellsFirstHalf : cellsSecondHalf, key, row.symbol, row.date, recoverable, recovered);
      if (passesMomentum) record(cellsRestricted, key, row.symbol, row.date, recoverable, recovered);
    }
    if (linesRead % 200000 === 0) console.error(`[cells] ...${linesRead} rows processed`);
  }

  console.log(`[cells] processed ${linesRead} rows total, ${rowsPassingMomentum}/${rowsTotal} (${(100*rowsPassingMomentum/rowsTotal).toFixed(2)}%) pass the momentum precondition (entry volRatio>=${MOMENTUM_VOL_RATIO_MIN}, entryDayOverDayPct>=${MOMENTUM_DAYOVERDAY_MIN})`);

  // ── Task 2: cell population under the three-minimum rule ──
  function classify(map) {
    let pass = 0, failOnly = 0, empty = 0, concentrated = 0;
    const details = [];
    // Enumerate the full 288-cell grid explicitly, not just cells that
    // happen to appear in the map -- an EMPTY cell must be counted as
    // empty, not silently absent from the report.
    const dds = ['-2', '-4', '-6', '-8', '-10', 'worse'];
    // '0' is included in the enumerated grid (matching the doc's own 4-value
    // day-of-hold dimension, 6x4x4x3=288) even though no row is ever
    // assigned to it (dayBucket() only returns '1'/'2'/'3+') -- it must show
    // up as EMPTY, not be silently excluded from the total cell count.
    const days = ['0', '1', '2', '3+'];
    const rsis = ['<30', '30-45', '45-60', '>60'];
    const vols = ['<0.75', '0.75-1.5', '>1.5'];
    for (const dd of dds) for (const day of days) for (const rb of rsis) for (const vb of vols) {
      const key = cellKey(dd, day, rb, vb);
      const a = map.get(key);
      if (!a) { empty++; continue; }
      const nRows = a.rowCount, nSymbols = a.symbols.size, nDates = a.dateCounts.size;
      const passes = nRows >= MIN_ROWS && nSymbols >= MIN_SYMBOLS && nDates >= MIN_DATES;
      let topDateShare = 0;
      for (const c of a.dateCounts.values()) topDateShare = Math.max(topDateShare, c / nRows);
      const isConcentrated = topDateShare > DATE_CONCENTRATION_FLAG;
      if (passes) { pass++; if (isConcentrated) concentrated++; }
      else failOnly++;
      details.push({ key, nRows, nSymbols, nDates, passes, topDateSharePct: +(topDateShare * 100).toFixed(1), concentrated: isConcentrated });
    }
    return { pass, failOnly, empty, concentrated, total: dds.length * days.length * rsis.length * vols.length, details };
  }

  const fullReport = classify(cellsFull);
  console.log('\n[cells] === TASK 2: full-band ($1-$20) cell population, all 288 cells ===');
  console.log(`pass all three minimums (>=100 rows, >=30 symbols, >=20 dates): ${fullReport.pass}/${fullReport.total}`);
  console.log(`fail on symbols/dates despite enough rows (of the non-empty, non-passing cells): see failOnly below`);
  console.log(`fail (any minimum, incl. rows): ${fullReport.failOnly}/${fullReport.total}`);
  console.log(`empty (zero rows): ${fullReport.empty}/${fullReport.total}`);
  console.log(`of passing cells, date-concentrated (top date >${(DATE_CONCENTRATION_FLAG*100).toFixed(0)}% of rows): ${fullReport.concentrated}/${fullReport.pass}`);

  // ── Task 3: out-of-sample split, p_recover comparison ──
  const firstReport = classify(cellsFirstHalf);
  const secondReport = classify(cellsSecondHalf);
  const diffs = [];
  for (const d1 of firstReport.details) {
    if (!d1.passes) continue;
    const d2 = secondReport.details.find(x => x.key === d1.key);
    if (!d2 || !d2.passes) continue;
    const a1 = cellsFirstHalf.get(d1.key), a2 = cellsSecondHalf.get(d1.key);
    if (a1.recoverable < MIN_ROWS || a2.recoverable < MIN_ROWS) continue; // need enough RECOVERABLE (d<=5) rows specifically, not just total rows
    const p1 = a1.recovered / a1.recoverable, p2 = a2.recovered / a2.recoverable;
    diffs.push({ key: d1.key, p_recover_first_half: +(p1*100).toFixed(1), p_recover_second_half: +(p2*100).toFixed(1), diff_pct_points: +((p2-p1)*100).toFixed(1) });
  }
  console.log('\n[cells] === TASK 3: out-of-sample split (fit 2024-10->2025-09, validate 2025-10->2026-09) ===');
  console.log(`cells passing all three minimums in BOTH halves separately, with >=${MIN_ROWS} recoverable (d<=5) rows in each: ${diffs.length}`);
  if (diffs.length) {
    const absDiffs = diffs.map(d => Math.abs(d.diff_pct_points)).sort((a,b) => a-b);
    const median = absDiffs[Math.floor(absDiffs.length/2)];
    const mean = absDiffs.reduce((a,b)=>a+b,0) / absDiffs.length;
    const max = absDiffs[absDiffs.length-1];
    console.log(`|p_recover(2nd half) - p_recover(1st half)| in percentage points: median=${median.toFixed(1)}, mean=${mean.toFixed(1)}, max=${max.toFixed(1)}`);
    console.log('full per-cell breakdown:', JSON.stringify(diffs.sort((a,b) => Math.abs(b.diff_pct_points) - Math.abs(a.diff_pct_points)), null, 2));
  }

  // ── Task 4: population-mismatch, full-band vs momentum-precondition ──
  const restrictedReport = classify(cellsRestricted);
  console.log('\n[cells] === TASK 4: population mismatch, full $1-$20 band vs momentum-precondition-passing ===');
  console.log(`restricted population cells passing all three minimums: ${restrictedReport.pass}/${restrictedReport.total} (vs ${fullReport.pass}/${fullReport.total} full-band)`);
  const momentumDiffs = [];
  for (const d1 of fullReport.details) {
    if (!d1.passes) continue;
    const d2 = restrictedReport.details.find(x => x.key === d1.key);
    if (!d2 || !d2.passes) continue;
    const a1 = cellsFull.get(d1.key), a2 = cellsRestricted.get(d1.key);
    if (a1.recoverable < MIN_ROWS || a2.recoverable < MIN_ROWS) continue;
    const p1 = a1.recovered / a1.recoverable, p2 = a2.recovered / a2.recoverable;
    momentumDiffs.push({ key: d1.key, p_recover_full_band: +(p1*100).toFixed(1), p_recover_momentum_restricted: +(p2*100).toFixed(1), diff_pct_points: +((p2-p1)*100).toFixed(1) });
  }
  console.log(`cells comparable (pass in both, >=${MIN_ROWS} recoverable rows each): ${momentumDiffs.length}`);
  if (momentumDiffs.length) {
    const absDiffs = momentumDiffs.map(d => Math.abs(d.diff_pct_points)).sort((a,b) => a-b);
    const median = absDiffs[Math.floor(absDiffs.length/2)];
    const mean = absDiffs.reduce((a,b)=>a+b,0) / absDiffs.length;
    const max = absDiffs[absDiffs.length-1];
    console.log(`|p_recover(momentum-restricted) - p_recover(full band)| in percentage points: median=${median.toFixed(1)}, mean=${mean.toFixed(1)}, max=${max.toFixed(1)}`);
    console.log('full per-cell breakdown:', JSON.stringify(momentumDiffs.sort((a,b) => Math.abs(b.diff_pct_points) - Math.abs(a.diff_pct_points)), null, 2));
  }
}

main().catch((err) => { console.error('[cells] FAILED —', err.message, err.stack); process.exit(1); });
