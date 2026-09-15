#!/usr/bin/env node
// Unit tests for scripts/lib/sell-timing.mjs -- pure, no network. Same
// check()/fail-loud pattern as scripts/test-hardfail-negative-control.mjs.
//
// Case A uses MSTU's REAL bars (pulled directly from Alpaca 2026-09-15,
// adjustment=all/raw/split, buyDate 2026-08-17, sellDate 2026-08-19,
// buyPrice $1.88 -- see phase-9-entry-exit-spec.md §1.1) -- not a
// reconstruction, the actual numbers that produced the +1559% corruption.
// Case B is a synthetic forward 2:1 split -- the case §1.1.1 says the
// plausibility guard alone would miss (~-50%/~0%, both "plausible").
// Case C is a synthetic data glitch with NO split (raw===adjusted
// throughout) but an absurd single-bar spike -- isolates the guard path
// from the split-detector path. Case D is a clean, no-defect resolution.
// Case E is a window that hasn't closed yet.
import { resolveSellTiming, detectSplitInWindow } from './lib/sell-timing.mjs';

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`[PASS] ${label}`);
  else { console.error(`[FAIL] ${label}${detail ? ' -- ' + detail : ''}`); failures++; }
}

function bar(date, h, c) { return { t: `${date}T00:00:00Z`, h, c }; }

// ── Case A: MSTU, real reverse split (~10.6x) ──
{
  const allBars = [
    bar('2026-08-17', 18.91, 18.61), bar('2026-08-18', 18.51, 16.83),
    bar('2026-08-19', 21.78, 20.89), bar('2026-08-20', 24.5,  24.06),
    bar('2026-08-21', 28.12, 26.98), bar('2026-08-24', 30.88, 28.57),
    bar('2026-08-25', 31.175,30.49), bar('2026-08-26', 29.81, 28.69),
  ];
  const rawBars = [
    bar('2026-08-17', 1.91, 1.88), bar('2026-08-18', 1.87, 1.7),
    bar('2026-08-19', 2.2,  2.11), bar('2026-08-20', 2.475,2.43),
    bar('2026-08-21', 2.84, 2.725),bar('2026-08-24', 31.19,28.86),
    bar('2026-08-25', 31.175,30.49),bar('2026-08-26', 29.81,28.69),
  ];
  const result = resolveSellTiming({ buyDate: '2026-08-17', sellDate: '2026-08-19', buyPrice: 1.88, allBars, rawBars });
  check('A: MSTU split is detected', detectSplitInWindow(allBars, rawBars, 7) === true);
  check('A: MSTU resolves to SPLIT_IN_WINDOW', result.resolved === true && result.bestExitTiming === 'SPLIT_IN_WINDOW', JSON.stringify(result));
  check('A: MSTU best_exit_price is null', result.bestExitPrice === null);
  check('A: MSTU best_exit_date is null', result.bestExitDate === null);
  check('A: MSTU price_at_plus5_days is null', result.priceAt5Days === null);
  check('A: MSTU price_at_plus1_day is null', result.priceAt1Day === null);
  check('A: MSTU price_at_plus2_days is null', result.priceAt2Days === null);
}

// ── Case B: synthetic forward 2:1 split ──
// adjusted (all) stays continuous across the split boundary (pre-split
// days rescaled down by /2 to match the post-split share count); raw
// shows the real cliff. buyPrice is RAW (what was actually paid), same
// units mismatch as MSTU but the OPPOSITE direction and roughly HALF the
// apparent size -- exactly the case spec §1.1.1 says a ±100%/-80% guard
// would let through.
{
  const allBars = [
    bar('2026-01-01', 5.05, 5.00), bar('2026-01-02', 5.10, 5.05),
    bar('2026-01-03', 5.15, 5.10), bar('2026-01-04', 5.20, 5.15),
    bar('2026-01-05', 5.25, 5.20), bar('2026-01-06', 5.28, 5.225),
    bar('2026-01-07', 5.30, 5.25), bar('2026-01-08', 5.32, 5.275),
  ];
  const rawBars = [
    bar('2026-01-01', 10.10,10.00), bar('2026-01-02', 10.20,10.10),
    bar('2026-01-03', 10.30,10.20), bar('2026-01-04', 10.40,10.30),
    bar('2026-01-05', 10.50,10.40), bar('2026-01-06', 5.28, 5.225),
    bar('2026-01-07', 5.30, 5.25),  bar('2026-01-08', 5.32, 5.275),
  ];
  const buyPrice = 10.00; // raw, actually paid
  const sellDate = '2026-01-02';
  const result = resolveSellTiming({ buyDate: '2026-01-01', sellDate, buyPrice, allBars, rawBars });

  // Confirm the premise: the guard ALONE (no split detector) would have
  // passed this -- bestExit from the adjusted series vs raw buyPrice.
  let naiveBest = null;
  for (const b of allBars.slice(0, 7)) if (naiveBest == null || b.h > naiveBest) naiveBest = b.h;
  const naiveGain = (naiveBest - buyPrice) / buyPrice;
  check('B: premise -- naive gain from adjusted bars vs raw buyPrice is within the guard band (would silently pass)', naiveGain <= 1.0 && naiveGain >= -0.8, `naiveGain=${naiveGain}`);

  check('B: forward split is detected', detectSplitInWindow(allBars, rawBars, 6) === true);
  check('B: synthetic forward split resolves to SPLIT_IN_WINDOW, not a plausible-looking number', result.resolved === true && result.bestExitTiming === 'SPLIT_IN_WINDOW', JSON.stringify(result));
  check('B: best_exit_price is null despite passing the plausibility guard', result.bestExitPrice === null);
  check('B: price_at_plus1_day/plus2_days also null', result.priceAt1Day === null && result.priceAt2Days === null);
}

// ── Case C: no split (raw === adjusted throughout), but a data glitch ──
// isolates the plausibility-guard path from the split-detector path.
{
  const mk = (dates) => dates.map(([d, h, c]) => bar(d, h, c));
  const series = [
    ['2026-02-01', 10.20, 10.00], ['2026-02-02', 10.30, 10.10],
    ['2026-02-03', 10.40, 10.20], ['2026-02-04', 10.50, 10.30],
    ['2026-02-05', 25.00, 24.50], // erroneous spike, no corresponding raw/adjusted divergence
    ['2026-02-06', 10.60, 10.40], ['2026-02-07', 10.70, 10.50],
  ];
  const allBars = mk(series), rawBars = mk(series);
  const result = resolveSellTiming({ buyDate: '2026-02-01', sellDate: '2026-02-02', buyPrice: 10.00, allBars, rawBars });
  check('C: no split detected (raw===adjusted)', detectSplitInWindow(allBars, rawBars, 6) === false);
  check('C: resolves to DATA_ERROR via the plausibility guard', result.resolved === true && result.bestExitTiming === 'DATA_ERROR', JSON.stringify(result));
  check('C: best_exit_price is null', result.bestExitPrice === null);
  check('C: price_at_plus1_day/plus2_days also null', result.priceAt1Day === null && result.priceAt2Days === null);
}

// ── Case D: clean resolution, no defects ──
{
  const mk = (dates) => dates.map(([d, h, c]) => bar(d, h, c));
  const series = [
    ['2026-03-01', 10.20, 10.00], ['2026-03-02', 10.10, 9.95],
    ['2026-03-03', 10.50, 10.30], ['2026-03-04', 10.60, 10.40],
    ['2026-03-05', 10.40, 10.20], ['2026-03-06', 10.30, 10.10],
    ['2026-03-07', 10.20, 10.05],
  ];
  const allBars = mk(series), rawBars = mk(series);
  const result = resolveSellTiming({ buyDate: '2026-03-01', sellDate: '2026-03-02', buyPrice: 10.00, allBars, rawBars });
  check('D: resolves normally', result.resolved === true && (result.bestExitTiming === 'BEFORE' || result.bestExitTiming === 'ON' || result.bestExitTiming === 'AFTER'), JSON.stringify(result));
  check('D: best_exit_price is the real max high in window (10.60 on 03-04)', result.bestExitPrice === 10.60 && result.bestExitDate === '2026-03-04', JSON.stringify(result));
  check('D: bestExitTiming is AFTER (peak came after the 03-02 sale)', result.bestExitTiming === 'AFTER');
  check('D: priceAt5Days is the close 5 trading days after sellDate (index anchor+5 = 6 -> 03-07)', result.priceAt5Days === 10.05, JSON.stringify(result));
  check('D: priceAt1Day is the close 1 trading day after sellDate (index anchor+1 = 2 -> 03-03)', result.priceAt1Day === 10.30, JSON.stringify(result));
  check('D: priceAt2Days is the close 2 trading days after sellDate (index anchor+2 = 3 -> 03-04)', result.priceAt2Days === 10.40, JSON.stringify(result));
}

// ── Case E: window not yet closed ──
{
  const mk = (dates) => dates.map(([d, h, c]) => bar(d, h, c));
  const series = [
    ['2026-04-01', 10.20, 10.00], ['2026-04-02', 10.10, 9.95],
    ['2026-04-03', 10.50, 10.30], // only 3 bars -- anchorIdx(1)+5=6 doesn't exist yet
  ];
  const allBars = mk(series), rawBars = mk(series);
  const result = resolveSellTiming({ buyDate: '2026-04-01', sellDate: '2026-04-02', buyPrice: 10.00, allBars, rawBars });
  check('E: not resolved when the +5-trading-day bar does not exist yet', result.resolved === false && !result.notFound, JSON.stringify(result));
}

// ── Case F: sellDate bar missing entirely ──
{
  const mk = (dates) => dates.map(([d, h, c]) => bar(d, h, c));
  const series = [['2026-05-01', 10.20, 10.00], ['2026-05-05', 10.10, 9.95]];
  const allBars = mk(series), rawBars = mk(series);
  const result = resolveSellTiming({ buyDate: '2026-05-01', sellDate: '2026-05-02', buyPrice: 10.00, allBars, rawBars });
  check('F: notFound when sellDate has no matching bar', result.resolved === false && result.notFound === true, JSON.stringify(result));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
