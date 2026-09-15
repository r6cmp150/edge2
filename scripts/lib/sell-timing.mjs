// Pure sell-timing resolution -- the "what was the best possible exit, and
// does the number make sense" computation, factored out of
// fill-outcomes.mjs so it can be unit-tested against synthetic bar data
// (scripts/test-sell-timing-resolution.mjs) without a live Alpaca/Supabase
// round trip. Mirrors app.js's computeSellTimingAnalysis in spirit but
// fixes two things that function still has: calendar-date arithmetic
// (addTradingDays) to find "5 trading days later" instead of a real
// array-position lookup (the same holiday-bug class already fixed in this
// file for signal_log's ret_1d/3d/5d -- see fill-outcomes.mjs's own header
// comment), and no split detection at all (app.js:1158 just returns the
// raw max high, unguarded -- the MSTU corruption, phase-9-entry-exit-
// spec.md §1.1).
//
// SPLIT_IN_WINDOW vs DATA_ERROR (spec §1.1.1): two independent checks that
// catch different things, both evaluated every time. The ratio check (raw
// vs adjustment=all, bar for bar) catches an actual corporate action --
// exact, not threshold-tuned -- and catches a forward split's ~-50%/~0%
// "plausible-looking" apparent gain that the plausibility guard alone
// would miss entirely (a reverse split throws the number wildly out of
// range and the guard alone would have been enough; a forward split does
// not, and that is the case that would have bitten silently). The
// plausibility guard (+100%/-80% vs buy_price) catches everything else
// that can make a number absurd -- a bad print, a data glitch -- it is a
// second net, not a substitute. Split detection is checked first since,
// when both would fire (MSTU's real reverse split does trip both), it is
// the more specific, exact diagnosis.
const SPLIT_RATIO_EPSILON = 0.02; // 2% -- far above any ordinary cash-dividend adjustment (a few cents on a $1-20 stock), far below any real split ratio (2:1 minimum = 100% deviation)
const PLAUSIBLE_MAX_GAIN = 1.0;   // +100%
const PLAUSIBLE_MIN_GAIN = -0.8;  // -80%

function barDate(b) {
  return (b.t || '').split('T')[0];
}

// True if any bar in [0..lastIdx] shows raw and adjustment=all diverging
// by more than SPLIT_RATIO_EPSILON -- i.e. a split or dividend adjustment
// landed somewhere inside that range. Both arrays must already be the
// SAME trading days at the SAME array positions (same fetch window, same
// pagination) -- this does not re-align by date, it trusts the caller's
// arrays are position-matched, exactly like this file's existing
// ret_1d/3d/5d array-position lookups trust their own daily-bars fetch.
export function detectSplitInWindow(allBars, rawBars, lastIdx) {
  for (let i = 0; i <= lastIdx; i++) {
    const a = allBars[i]?.c;
    const r = rawBars[i]?.c;
    if (a == null || r == null || a === 0) continue;
    if (Math.abs(r / a - 1) > SPLIT_RATIO_EPSILON) return true;
  }
  return false;
}

// Pure resolution -- no network, no Supabase. allBars/rawBars: daily bars
// from buyDate forward, SAME array positions (position-matched, see
// detectSplitInWindow above), sort asc, fetched with adjustment='all' and
// adjustment='raw' respectively.
//
// Returns { resolved: false } when the window hasn't closed yet in REAL
// trading-day terms (the sellDate bar's +5th successor isn't in the data
// yet -- an honest "not enough real sessions have happened," not a
// calendar guess) or { resolved: false, notFound: true } when sellDate's
// own bar is simply missing from the fetched range (shouldn't happen for
// a real sale; defensive rather than throwing).
//
// Otherwise returns { resolved: true, bestExitPrice, bestExitDate,
// bestExitTiming, priceAt5Days }, with bestExitTiming one of
// 'BEFORE'|'ON'|'AFTER' (normal resolution) or
// 'SPLIT_IN_WINDOW'|'DATA_ERROR' (a guard tripped -- the three price
// fields are null in that case; a wrong number is worse than a missing
// one, project-wide rule, applied here exactly as everywhere else).
export function resolveSellTiming({ buyDate, sellDate, buyPrice, allBars, rawBars }) {
  const anchorIdx = allBars.findIndex(b => barDate(b) === sellDate);
  if (anchorIdx === -1) return { resolved: false, notFound: true };

  const resolvedIdx = anchorIdx + 5;
  if (allBars.length <= resolvedIdx || rawBars.length <= resolvedIdx) {
    return { resolved: false };
  }

  if (detectSplitInWindow(allBars, rawBars, resolvedIdx)) {
    return {
      resolved: true,
      bestExitPrice: null, bestExitDate: null,
      bestExitTiming: 'SPLIT_IN_WINDOW', priceAt5Days: null,
    };
  }

  let bestExitPrice = null, bestExitDate = null;
  for (let i = 0; i <= resolvedIdx; i++) {
    const h = allBars[i].h;
    if (h == null) continue;
    if (bestExitPrice == null || h > bestExitPrice) {
      bestExitPrice = h;
      bestExitDate = barDate(allBars[i]);
    }
  }
  const priceAt5Days = allBars[resolvedIdx].c ?? null;

  const impliedGain = (v) => (v - buyPrice) / buyPrice;
  const implausible = (v) => v != null && (impliedGain(v) > PLAUSIBLE_MAX_GAIN || impliedGain(v) < PLAUSIBLE_MIN_GAIN);
  if (implausible(bestExitPrice) || implausible(priceAt5Days)) {
    return {
      resolved: true,
      bestExitPrice: null, bestExitDate: null,
      bestExitTiming: 'DATA_ERROR', priceAt5Days: null,
    };
  }

  const bestExitTiming = bestExitDate == null ? null
    : bestExitDate < sellDate ? 'BEFORE'
    : bestExitDate === sellDate ? 'ON'
    : 'AFTER';

  return { resolved: true, bestExitPrice, bestExitDate, bestExitTiming, priceAt5Days };
}

export const SELL_TIMING_CONSTANTS = { SPLIT_RATIO_EPSILON, PLAUSIBLE_MAX_GAIN, PLAUSIBLE_MIN_GAIN };
