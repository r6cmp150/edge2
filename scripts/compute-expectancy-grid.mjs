#!/usr/bin/env node
// Expectancy grid over a triggers.json artifact (scripts/run-symbol-day-scan.mjs's
// output shape) — stops x targets x one time-stop horizon, per setup.
//
// WHY MEDIAN RETURN WAS THE WRONG STATISTIC (2026-09-02): momentum
// strategies characteristically have a sub-50% win rate and a large
// right tail -- lose small repeatedly, win big occasionally. A median
// near zero is exactly what a positive-expectancy momentum system looks
// like when measured with a median and NO EXIT RULE. Ross Cameron's
// method is tight stops plus scaling out; raw fixed-horizon returns with
// no stop is a strategy nobody trades. This simulates one.
//
// TIME-STOP HORIZON: only 30m is available. forwardReturns captured
// 5m/15m/30m/close -- there is no 60m snapshot in the data already on
// disk, and computing one would need the raw bars again (not saved,
// would be a new fetch). Reported as 30m only; 60m would need a new
// capture field added to runReplay's forwardReturns, not a re-analysis
// of what's here.
//
// STOP-FIRST AMBIGUITY RESOLUTION (explicit user instruction): MFE/MAE
// don't record the ORDER excursions happened in. A trade whose MAE
// breached the stop AND whose MFE reached the target within the same
// window is ambiguous -- resolved as STOP-FIRST (pessimistic), which is
// the deliberate direction: every other assumption in this pipeline
// (entry at level, zero slippage) already leans optimistic.
import { readFileSync } from 'node:fs';

const triggersPath = process.argv[2];
if (!triggersPath) {
  console.error('usage: node scripts/compute-expectancy-grid.mjs <path-to-triggers.json>');
  process.exit(1);
}
const triggers = JSON.parse(readFileSync(triggersPath, 'utf8'));

const STOPS_PCT = [2, 3, 5];     // -2%, -3%, -5%
const TARGETS_PCT = [3, 5, 10];  // +3%, +5%, +10%
const HORIZON = '30m';           // only fixed, comparable horizon available with a time-stop exit price

function simulateOne(trigger, stopPct, targetPct) {
  const h = trigger.forwardReturns[HORIZON];
  if (!h || h.return == null || h.mfe == null || h.mae == null) return null; // horizon unreachable for this trigger (session ended first) -- excluded, not fabricated
  const stopBreached = h.mae <= -stopPct;
  const targetReached = h.mfe >= targetPct;
  if (stopBreached && targetReached) return -stopPct;   // ambiguous -> stop-first (pessimistic)
  if (stopBreached) return -stopPct;                     // stopped out, target never reached
  if (targetReached) return targetPct;                   // target hit cleanly, stop never breached
  return h.return;                                       // neither triggered -- time-stop exit at the 30m mark, whatever price that was
}

const setups = [...new Set(triggers.map(t => t.setup))];
const grid = {};
for (const setup of setups) {
  grid[setup] = {};
  const rows = triggers.filter(t => t.setup === setup);
  for (const stopPct of STOPS_PCT) {
    grid[setup][`stop-${stopPct}`] = {};
    for (const targetPct of TARGETS_PCT) {
      const outcomes = rows.map(t => simulateOne(t, stopPct, targetPct)).filter(v => v !== null);
      const n = outcomes.length;
      const wins = outcomes.filter(v => v > 0).length;
      const expectancy = n ? outcomes.reduce((s, v) => s + v, 0) / n : null;
      const winRate = n ? wins / n : null;
      grid[setup][`stop-${stopPct}`][`target-${targetPct}`] = {
        n, winRate: winRate !== null ? Number((winRate * 100).toFixed(1)) : null,
        expectancyPct: expectancy !== null ? Number(expectancy.toFixed(3)) : null,
      };
    }
  }
}

console.log(JSON.stringify({ horizon: HORIZON, stopFirstOnAmbiguity: true, sourceFile: triggersPath, totalTriggers: triggers.length, grid }, null, 2));
