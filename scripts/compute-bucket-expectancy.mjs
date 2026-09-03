#!/usr/bin/env node
// Per-bucket expectancy, run AFTER bucket-and-compute-expectancy.mjs has
// already written and the sizing has already been reported (explicit
// sequencing instruction: sizing before any expectancy number). Reuses
// compute-expectancy-grid.mjs's stop-first-on-ambiguity simulation
// verbatim, extended with slippage (round-trip cost = 2x the per-side
// figure, applied to every trade regardless of which exit fired — every
// real trade has an entry AND an exit).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node scripts/compute-bucket-expectancy.mjs <run-dir>');
  process.exit(1);
}

const SLIPPAGE_PCTS = [0, 0.3, 0.6]; // per side
const STOPS_PCT = [2, 3, 5];
const TARGETS_PCT = [3, 5, 10];
const PRIMARY_CELL = { stop: 3, target: 5 };
const HORIZON = '30m';

const stalenessBound = Number(process.argv[3]) || 180;
const sizing = JSON.parse(readFileSync(path.join(runDir, `bucket_sizing_${stalenessBound}d.json`), 'utf8'));
const triggers = JSON.parse(readFileSync(path.join(runDir, 'triggers_gated.json'), 'utf8'));

// Verbatim from compute-expectancy-grid.mjs's simulateOne, minus slippage —
// slippage applied as a separate, explicit step below so the stop-first
// resolution logic isn't duplicated with a variant.
function rawOutcome(trigger, stopPct, targetPct) {
  const h = trigger.forwardReturns[HORIZON];
  if (!h || h.return == null || h.mfe == null || h.mae == null) return null;
  const stopBreached = h.mae <= -stopPct;
  const targetReached = h.mfe >= targetPct;
  if (stopBreached && targetReached) return -stopPct;
  if (stopBreached) return -stopPct;
  if (targetReached) return targetPct;
  return h.return;
}

function withSlippage(outcome, slippagePerSide) {
  if (outcome == null) return null;
  return outcome - 2 * slippagePerSide; // entry + exit, every trade incurs both
}

function computeCell(rows, stopPct, targetPct, slippagePerSide) {
  const outcomes = rows.map(t => withSlippage(rawOutcome(t, stopPct, targetPct), slippagePerSide)).filter(v => v !== null);
  const n = outcomes.length;
  const wins = outcomes.filter(v => v > 0).length;
  const expectancy = n ? outcomes.reduce((s, v) => s + v, 0) / n : null;
  return {
    n,
    winRate: n ? Number((100 * wins / n).toFixed(1)) : null,
    expectancyPct: expectancy !== null ? Number(expectancy.toFixed(3)) : null,
  };
}

function computeForBuckets(bucketDefs, assignment, label) {
  console.log('');
  console.log(`[expectancy] === ${label} ===`);
  const byBucket = {};
  for (const b of bucketDefs) byBucket[b.label] = triggers.filter(t => assignment[`${t.date}|${t.symbol}`] === b.label);

  const result = {};
  for (const b of bucketDefs) {
    const rows = byBucket[b.label];
    result[b.label] = {
      triggerCount: rows.length,
      slippageCurve: {},
      fullGrid: {},
    };
    // Primary cell across the slippage curve — the headline dose-response comparison.
    for (const slip of SLIPPAGE_PCTS) {
      result[b.label].slippageCurve[`${slip}pct`] = computeCell(rows, PRIMARY_CELL.stop, PRIMARY_CELL.target, slip);
    }
    // Full stop x target grid at 0.3%/side (the pre-registered criterion's slippage level) for robustness.
    for (const stopPct of STOPS_PCT) {
      result[b.label].fullGrid[`stop-${stopPct}`] = {};
      for (const targetPct of TARGETS_PCT) {
        result[b.label].fullGrid[`stop-${stopPct}`][`target-${targetPct}`] = computeCell(rows, stopPct, targetPct, 0.3);
      }
    }
    const c = result[b.label].slippageCurve;
    console.log(`[expectancy]   ${b.label.padEnd(10)} n=${String(rows.length).padEnd(4)} | @0%: ${fmt(c['0pct'])} | @0.3%: ${fmt(c['0.3pct'])} | @0.6%: ${fmt(c['0.6pct'])}`);
  }

  // Monotonicity check. bucketDefs is ordered SMALLEST -> LARGEST (index 0
  // = fewest shares/lowest float, index last = most). The pre-registered
  // criterion is "expectancy improves as [shares outstanding] decreases" —
  // i.e. moving from index-last (largest) toward index 0 (smallest),
  // expectancy should IMPROVE. Equivalently, in forward array order
  // (smallest -> largest), expectancy must be NON-INCREASING: each larger
  // bucket's expectancy <= the previous, smaller bucket's. "The lowest
  // bucket" in the pre-registration means fewest shares/lowest float —
  // index 0 here, NOT the last array entry.
  const seq = bucketDefs.map(b => result[b.label].slippageCurve['0.3pct'].expectancyPct);
  const allPresent = seq.every(v => v !== null);
  let monotonic = null;
  if (allPresent) {
    monotonic = true;
    for (let i = 1; i < seq.length; i++) if (seq[i] > seq[i - 1]) monotonic = false; // a larger bucket beating a smaller one breaks the hypothesized direction
  }
  const lowest = seq[0]; // smallest-shares/lowest-float bucket
  const lowestPositive = lowest != null && lowest > 0;
  console.log(`[expectancy]   monotonic improvement as size DECREASES (i.e. non-increasing from ${bucketDefs[0].label} to ${bucketDefs[bucketDefs.length - 1].label}, @0.3%/side): ${allPresent ? monotonic : 'INCOMPLETE (a bucket has n=0 at this cell)'}`);
  console.log(`[expectancy]   lowest bucket (${bucketDefs[0].label}, fewest shares/lowest float) expectancy @0.3%/side: ${lowest != null ? lowest.toFixed(3) + '%' : 'n/a'} -- ${lowestPositive ? 'POSITIVE' : 'NOT positive'}`);
  const success = allPresent && monotonic && lowestPositive;
  console.log(`[expectancy]   PRE-REGISTERED SUCCESS CRITERION: ${success ? 'MET' : 'NOT MET (null result)'}`);

  return { result, monotonic: allPresent ? monotonic : null, lowestBucketExpectancyAt0_3: lowest, lowestBucketPositive: lowestPositive, successCriterionMet: success };
}

function fmt(cell) {
  if (!cell || cell.n === 0) return 'n=0';
  return `n=${cell.n} exp=${cell.expectancyPct}% win=${cell.winRate}%`;
}

const sharesOut = computeForBuckets(
  [{ label: '<5M' }, { label: '5-10M' }, { label: '10-20M' }, { label: '20-50M' }, { label: '>50M' }],
  sizing.sharesBucketAssignment, 'SHARES OUTSTANDING (primary cell: stop -3% / target +5%)'
);
const floatOut = computeForBuckets(
  [{ label: '<$10M' }, { label: '$10-25M' }, { label: '$25-50M' }, { label: '$50-100M' }, { label: '>$100M' }],
  sizing.floatBucketAssignment, 'ENTITY PUBLIC FLOAT (primary cell: stop -3% / target +5%)'
);

console.log('');
console.log('[expectancy] === AGREEMENT BETWEEN THE TWO INDEPENDENT MEASUREMENTS ===');
console.log(`[expectancy] shares-outstanding monotonic: ${sharesOut.monotonic} | EntityPublicFloat monotonic: ${floatOut.monotonic}`);
console.log(`[expectancy] shares-outstanding success criterion met: ${sharesOut.successCriterionMet} | float success criterion met: ${floatOut.successCriterionMet}`);

const outFileName = `bucket_expectancy_${stalenessBound}d.json`;
writeFileSync(path.join(runDir, outFileName), JSON.stringify({
  primaryCell: PRIMARY_CELL, horizon: HORIZON, slippagePctsPerSide: SLIPPAGE_PCTS, stalenessBound,
  sharesOutstanding: sharesOut, entityPublicFloat: floatOut,
}, null, 2));
console.log('');
console.log(`[expectancy] wrote ${path.join(runDir, outFileName)}`);
