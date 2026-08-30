// tests/setups.test.js — engines/warrior/setups.js, Phase 5's setup
// detectors. docs/warrior-engine-spec-v2.md Phase 5. Loads core/clock.js's
// REAL getPT/ptDateStr/ptWallClockToInstant (not mocked) into globals
// before importing setups.js as a real ES module — the classifiers'
// session-boundary logic (pre-market vs regular session) genuinely
// depends on correct PT handling, so mocking the clock would test nothing
// about the actual boundary behavior. Bars are built with real PT wall-
// clock times via ptWallClockToInstant so fixtures are unambiguous about
// which side of 6:30am PT they fall on.
'use strict';
const assert = require('assert');
const { readSource, evalModule, run } = require('./_lib');

const TRADING_DATE = '2026-08-24'; // confirmed trading day, same date as the Phase 4 HVII live check

function loadClockGlobals() {
  global.state = { settings: {} };
  const src = readSource('core/clock.js');
  evalModule(src, { expose: ['getPT', 'ptDateStr', 'ptWallClockToInstant', 'isTradingDay'] });
}

async function loadSetups() {
  loadClockGlobals();
  return import('../engines/warrior/setups.js');
}

function t(hour, minute) {
  return global.ptWallClockToInstant(TRADING_DATE, hour, minute).toISOString();
}

function bar(hour, minute, o, h, l, c, v) {
  return { t: t(hour, minute), o, h, l, c, v };
}

// Builds a flat run of regular-session bars from 6:30am PT for `count`
// minutes at a constant price/volume, useful as filler before/after the
// bar(s) a test actually cares about.
function flatRun(startHour, startMinute, count, price, v = 1000) {
  const bars = [];
  let totalMin = startHour * 60 + startMinute;
  for (let i = 0; i < count; i++) {
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    bars.push(bar(h, m, price, price, price, price, v));
    totalMin++;
  }
  return bars;
}

// ── gap-and-go ────────────────────────────────────────────────────────────

async function testGapAndGoTriggersOnPremarketHighBreakWithVolume() {
  const setups = await loadSetups();
  const prevClose = 4.00;
  const bars = [
    bar(5, 0, 4.40, 4.50, 4.35, 4.45, 500),   // pre-market, premarketHigh so far = 4.50, gap = 4.45/4.00-1 = 11.25% (>=10%)
    bar(5, 30, 4.45, 4.48, 4.40, 4.46, 500),  // pre-market
    ...flatRun(6, 30, 3, 4.46, 1000),         // regular session opens, flat for volume-average baseline
    bar(6, 33, 4.47, 4.60, 4.46, 4.58, 3000), // breaks premarket high (4.50) on high volume
  ];
  const classifier = setups.makeGapAndGoClassifier({ prevClose });
  const barsSoFar = bars; // full array = "as of the last bar"
  const verdict = classifier(barsSoFar);
  console.log('gap-and-go verdict:', verdict);
  assert.ok(verdict, 'must trigger: premarket high broken, gap >=10%, volume multiple >=2x');
  assert.strictEqual(verdict.setupId, 'gap-and-go');
  assert.strictEqual(verdict.referenceLevel, 4.50);
  assert.strictEqual(verdict.referenceDirection, 'above');
  assert.ok(verdict.margins.gapPct >= 0.10);
  assert.ok(verdict.margins.volumeMultiple >= 2.0);
}

async function testGapAndGoFailsPreconditionBelow10PctGap() {
  const setups = await loadSetups();
  const prevClose = 4.30; // premarket price 4.45 -> gap = 3.5%, below 10% precondition
  const bars = [
    bar(5, 0, 4.40, 4.50, 4.35, 4.45, 500),
    ...flatRun(6, 30, 3, 4.46, 1000),
    bar(6, 33, 4.47, 4.60, 4.46, 4.58, 3000),
  ];
  const classifier = setups.makeGapAndGoClassifier({ prevClose });
  assert.strictEqual(classifier(bars), null, 'must not trigger when the premarket gap precondition (>=10%) is not met, regardless of the later breakout');
}

async function testGapAndGoFailsWithoutVolumeConfirmation() {
  const setups = await loadSetups();
  const prevClose = 4.00;
  const bars = [
    bar(5, 0, 4.40, 4.50, 4.35, 4.45, 500),
    ...flatRun(6, 30, 3, 4.46, 1000),
    bar(6, 33, 4.47, 4.60, 4.46, 4.58, 1500), // breaks the level but volume is only 1.5x, below the 2x threshold
  ];
  const classifier = setups.makeGapAndGoClassifier({ prevClose });
  assert.strictEqual(classifier(bars), null, 'a price breakout without the required volume confirmation must not trigger');
}

// ── hod-momentum ──────────────────────────────────────────────────────────

async function testHodMomentumTriggersOnNewHighWithVolume() {
  const setups = await loadSetups();
  const bars = [
    ...flatRun(6, 30, 16, 5.00, 1000), // 16 flat bars (past the 5-min exclusion, gives 15 prior bars for the mean)
    bar(6, 46, 5.00, 5.20, 4.98, 5.15, 4000), // new HOD (prior high 5.00) on 4x volume
  ];
  const classifier = setups.hodMomentumClassifier;
  const verdict = classifier(bars);
  console.log('hod-momentum verdict:', verdict);
  assert.ok(verdict);
  assert.strictEqual(verdict.referenceLevel, 5.00);
  assert.ok(verdict.margins.volumeMultiple >= 3.0);
}

async function testHodMomentumExcludesFirst5Minutes() {
  const setups = await loadSetups();
  const bars = [
    bar(6, 30, 5.00, 5.00, 5.00, 5.00, 1000),
    bar(6, 31, 5.00, 5.30, 4.98, 5.25, 5000), // "new HOD" but within the excluded first 5 minutes
  ];
  assert.strictEqual(setups.hodMomentumClassifier(bars), null, 'every bar is trivially a new HOD in the first 5 minutes — must not trigger there');
}

// ── abcd ──────────────────────────────────────────────────────────────────

async function testAbcdFullPattern() {
  const setups = await loadSetups();
  const bars = [
    bar(6, 30, 5.00, 5.05, 4.90, 4.95, 1000),  // A: session low 4.90 (within first 60 min)
    bar(6, 35, 4.95, 5.60, 4.95, 5.55, 2000),  // B: high 5.60 -> B/A-1 = 5.60/4.90-1 = 14.3% (>=10%)
    bar(6, 40, 5.55, 5.55, 5.20, 5.25, 800),   // C-ward: pulling back on lower volume
    bar(6, 41, 5.25, 5.25, 5.15, 5.20, 700),   // C: low 5.15 -> retrace = (5.60-5.15)/(5.60-4.90) = 64%... too deep, adjust below
  ];
  // Recompute a valid retracement (30-60% band): want C such that (B-C)/(B-A) is inside [0.30,0.60].
  // B=5.60, A=4.90, B-A=0.70. 45% retrace -> C = B - 0.45*0.70 = 5.60-0.315 = 5.285.
  const validBars = [
    bar(6, 30, 5.00, 5.05, 4.90, 4.95, 1000),
    bar(6, 35, 4.95, 5.60, 4.95, 5.55, 2000),
    bar(6, 40, 5.55, 5.55, 5.30, 5.35, 800),
    bar(6, 41, 5.35, 5.35, 5.285, 5.30, 700), // C = 5.285, on declining volume vs A->B mean
    bar(6, 42, 5.30, 5.65, 5.29, 5.62, 2500), // breakout above B (5.60) on volume >= 1.5x the B->C mean
  ];
  const verdict = setups.abcdClassifier(validBars);
  console.log('abcd verdict:', verdict);
  assert.ok(verdict, 'a full, valid A->B->C->breakout pattern must trigger');
  assert.strictEqual(verdict.referenceLevel, 5.60);
  assert.ok(verdict.margins.retracementPct >= 0.30 && verdict.margins.retracementPct <= 0.60);
}

async function testAbcdFailsWhenRetracementOutsideBand() {
  const setups = await loadSetups();
  const bars = [
    bar(6, 30, 5.00, 5.05, 4.90, 4.95, 1000), // A = 4.90
    bar(6, 35, 4.95, 5.60, 4.95, 5.55, 2000), // B = 5.60
    bar(6, 40, 5.55, 5.55, 5.50, 5.52, 800),  // C = 5.50 -> retrace = (5.60-5.50)/0.70 = 14%, below the 30% floor
    bar(6, 41, 5.52, 5.53, 5.50, 5.51, 700),  // filler bar (regularBars needs >=5 total for A/B/C + a current bar)
    bar(6, 42, 5.51, 5.65, 5.50, 5.63, 2500), // would-be breakout
  ];
  assert.strictEqual(setups.abcdClassifier(bars), null, 'a pullback shallower than the 30% floor must not qualify as a valid C');
}

// ── vwap-momentum ────────────────────────────────────────────────────────

async function testVwapMomentumTriggersOnPullbackReclaim() {
  const setups = await loadSetups();
  const bars = [
    bar(6, 30, 4.80, 4.85, 4.78, 4.82, 1000), // below VWAP initially (typical price ~4.82, vwap starts at 4.82 too on bar 1 -- need a genuine below->above cross)
    bar(6, 31, 4.82, 4.83, 4.75, 4.78, 1200), // still near/below
    bar(6, 32, 4.78, 5.00, 4.78, 4.98, 3000), // crosses above VWAP decisively
    bar(6, 33, 4.98, 4.99, 4.90, 4.95, 900),  // pullback bar: low comes close to VWAP without closing below it
    bar(6, 34, 4.95, 5.05, 4.94, 5.02, 3200), // trigger: closes above pullback bar's high (4.99); volume 3200 vs the 4 prior bars' mean (1525) = 2.1x, clears the 1.5x threshold

  ];
  const verdict = setups.vwapMomentumClassifier(bars);
  console.log('vwap-momentum verdict:', verdict);
  assert.ok(verdict, 'a genuine crossing + pullback-near-VWAP + reclaim-on-rising-volume must trigger');
  assert.strictEqual(verdict.referenceDirection, 'above');
}

async function testVwapMomentumFailsWithoutPriorCross() {
  const setups = await loadSetups();
  const bars = [
    bar(6, 30, 4.80, 4.85, 4.78, 4.82, 1000),
    bar(6, 31, 4.82, 4.90, 4.80, 4.88, 1200),
    bar(6, 32, 4.88, 4.95, 4.86, 4.93, 2000), // price stays above/near VWAP the whole time -- never a genuine below->above cross
  ];
  assert.strictEqual(setups.vwapMomentumClassifier(bars), null, 'without a genuine prior below-to-above VWAP cross, must not trigger');
}

// ── red-to-green ─────────────────────────────────────────────────────────

async function testRedToGreenTriggersOnCrossAbovePrevCloseWithVolume() {
  const setups = await loadSetups();
  const prevClose = 5.00;
  const bars = [
    ...flatRun(6, 30, 16, 4.90, 1000), // traded below prevClose all morning
    bar(6, 46, 4.92, 5.10, 4.91, 5.05, 3000), // first close above prevClose, on 3x volume
  ];
  const classifier = setups.makeRedToGreenClassifier({ prevClose });
  const verdict = classifier(bars);
  console.log('red-to-green verdict:', verdict);
  assert.ok(verdict);
  assert.strictEqual(verdict.referenceLevel, prevClose);
  assert.ok(verdict.margins.volumeMultiple >= 2.0);
}

async function testRedToGreenFailsWithoutHavingTradedBelow() {
  const setups = await loadSetups();
  const prevClose = 4.50; // session never actually traded below this
  const bars = [
    ...flatRun(6, 30, 16, 4.90, 1000),
    bar(6, 46, 4.92, 5.10, 4.91, 5.05, 3000),
  ];
  const classifier = setups.makeRedToGreenClassifier({ prevClose });
  assert.strictEqual(classifier(bars), null, 'the precondition requires the session to have actually traded below prevClose first');
}

// ── _volumeBaselineOverMinutes (denominator redesign) ────────────────────
// Direct tests of the fix itself, not just its effect through a
// classifier: the live-replay finding was that a bar-COUNT window ("last
// 15 bars") silently reaches back however far real time it takes to find
// 15 actual bars — 71 minutes for a thin name, per the AMIX report. These
// confirm the replacement window is bounded by real minutes instead,
// regardless of how few bars that captures.

async function testVolumeBaselineExcludesBarsOutsideTheRealTimeWindow() {
  const setups = await loadSetups();
  // Sparse series: three old, quiet bars (6:30/6:35/6:50) then a real
  // recent spike one minute before "current" (7:16). A bar-COUNT window
  // asking for "the last few bars" would reach all the way back to 6:30
  // to find them; a 15-real-minute window must not.
  const bars = [
    bar(6, 30, 5, 5, 5, 5, 100),
    bar(6, 35, 5, 5, 5, 5, 100),
    bar(6, 50, 5, 5, 5, 5, 100),
    bar(7, 15, 5, 5, 5, 5, 5000),
    bar(7, 16, 5, 5, 5, 5, 100), // "current" -- endIndexExclusive, never itself included
  ];
  const baseline = setups._volumeBaselineOverMinutes(bars, 4, 15);
  console.log('sparse baseline (bounded):', baseline);
  assert.strictEqual(baseline.barCount, 1, 'only the 7:15 bar is within 15 real minutes of the current bar -- the three older, quiet bars must not be pulled in just to satisfy a fixed count');
  assert.strictEqual(baseline.meanVol, 5000);
  assert.strictEqual(baseline.spanMinutes, 0, 'a one-bar window has no span between two bars');
}

async function testVolumeBaselineIncludesMultipleBarsWithCorrectSpan() {
  const setups = await loadSetups();
  const bars = [
    bar(7, 0, 5, 5, 5, 5, 1000),
    bar(7, 5, 5, 5, 5, 5, 2000),
    bar(7, 10, 5, 5, 5, 5, 3000),
    bar(7, 12, 5, 5, 5, 5, 9999), // "current"
  ];
  const baseline = setups._volumeBaselineOverMinutes(bars, 3, 15);
  console.log('multi-bar baseline:', baseline);
  assert.strictEqual(baseline.barCount, 3);
  assert.ok(Math.abs(baseline.meanVol - 2000) < 1e-9);
  assert.strictEqual(baseline.spanMinutes, 10, 'span is real minutes between the oldest (7:00) and newest (7:10) baseline bar, not the 15-minute window cap');
}

async function testVolumeBaselineReturnsNullWithNoPriorBarsInWindow() {
  const setups = await loadSetups();
  const bars = [
    bar(6, 0, 5, 5, 5, 5, 100), // 76 minutes before "current" -- outside any reasonable window
    bar(7, 16, 5, 5, 5, 5, 100), // "current"
  ];
  const baseline = setups._volumeBaselineOverMinutes(bars, 1, 15);
  assert.strictEqual(baseline, null, 'no prior bar at all within the window must return null, never silently fall back to a stale bar from outside it');
}

// ── margin recomputability ────────────────────────────────────────────────
// General principle from the live-replay findings (2026-08-28/29): every
// margin must be checkable from numbers actually shown on the card, not
// just asserted. These tests recompute each derived *Pct field from the
// OTHER fields in the same verdict (mirroring what a reader with only the
// rendered row in front of them could do) and confirm they match — not
// just that the fields exist.

async function testGapAndGoBreakoutHighMarginIsRecomputable() {
  const setups = await loadSetups();
  const prevClose = 4.00;
  const bars = [
    bar(5, 0, 4.40, 4.50, 4.35, 4.45, 500),
    ...flatRun(6, 30, 3, 4.46, 1000),
    bar(6, 33, 4.47, 4.60, 4.46, 4.58, 3000),
  ];
  const verdict = setups.makeGapAndGoClassifier({ prevClose })(bars);
  const recomputed = (verdict.margins.breakoutHigh - verdict.referenceLevel) / verdict.referenceLevel;
  console.log('gap-and-go recompute check:', { reported: verdict.margins.breakoutHighAbovePremarketHighPct, recomputed });
  assert.ok(Math.abs(verdict.margins.breakoutHighAbovePremarketHighPct - recomputed) < 1e-9,
    'breakoutHighAbovePremarketHighPct must be recomputable from breakoutHigh and referenceLevel alone, both shown on the row');
  assert.notStrictEqual(verdict.margins.breakoutHigh, verdict.triggerPrice,
    'breakoutHigh (the bar\'s high, what the trigger condition checks) is deliberately a different number from triggerPrice (the bar\'s close) — that gap is exactly what made the old field unrecomputable');
}

async function testHodMomentumBreakoutHighMarginIsRecomputable() {
  const setups = await loadSetups();
  const bars = [...flatRun(6, 30, 16, 5.00, 1000), bar(6, 46, 5.00, 5.20, 4.98, 5.15, 4000)];
  const verdict = setups.hodMomentumClassifier(bars);
  const recomputed = (verdict.margins.breakoutHigh - verdict.referenceLevel) / verdict.referenceLevel;
  console.log('hod-momentum recompute check:', { reported: verdict.margins.breakoutHighAboveHodPct, recomputed });
  assert.ok(Math.abs(verdict.margins.breakoutHighAboveHodPct - recomputed) < 1e-9);
}

async function testAbcdRetracementAndGainMarginsAreRecomputable() {
  const setups = await loadSetups();
  const validBars = [
    bar(6, 30, 5.00, 5.05, 4.90, 4.95, 1000),
    bar(6, 35, 4.95, 5.60, 4.95, 5.55, 2000),
    bar(6, 40, 5.55, 5.55, 5.30, 5.35, 800),
    bar(6, 41, 5.35, 5.35, 5.285, 5.30, 700),
    bar(6, 42, 5.30, 5.65, 5.29, 5.62, 2500),
  ];
  const verdict = setups.abcdClassifier(validBars);
  const { aLevel, cLevel, gainPct, retracementPct } = verdict.margins;
  const B = verdict.referenceLevel;
  const recomputedGain = B / aLevel - 1;
  const recomputedRetrace = (B - cLevel) / (B - aLevel);
  console.log('abcd recompute check:', { gainPct, recomputedGain, retracementPct, recomputedRetrace });
  assert.ok(Math.abs(gainPct - recomputedGain) < 1e-9, 'gainPct must be recomputable from aLevel and referenceLevel (B) alone');
  assert.ok(Math.abs(retracementPct - recomputedRetrace) < 1e-9, 'retracementPct must be recomputable from aLevel, cLevel, and referenceLevel (B) alone');
}

async function testVwapMomentumDistanceMarginIsRecomputable() {
  const setups = await loadSetups();
  const bars = [
    bar(6, 30, 4.80, 4.85, 4.78, 4.82, 1000),
    bar(6, 31, 4.82, 4.83, 4.75, 4.78, 1200),
    bar(6, 32, 4.78, 5.00, 4.78, 4.98, 3000),
    bar(6, 33, 4.98, 4.99, 4.90, 4.95, 900),
    bar(6, 34, 4.95, 5.05, 4.94, 5.02, 3200), // volume 3200 vs 4 prior bars' mean (1525) = 2.1x, clears the 1.5x threshold
  ];
  const verdict = setups.vwapMomentumClassifier(bars);
  // A raw classifier verdict has no triggerPrice field — that's added by
  // the harness (runReplay), always as the current bar's close (see
  // replay.js's anchoring rule). What's displayed on a real card IS that
  // harness-derived triggerPrice, so recomputing against the same bar's
  // close here matches what a reader with the rendered row would do.
  const actualClose = bars[bars.length - 1].c;
  const recomputedPct = (actualClose - verdict.margins.vwap) / verdict.margins.vwap;
  console.log('vwap-momentum recompute check:', { reported: verdict.margins.distanceAboveVwapPct, recomputedPct });
  assert.ok(Math.abs(verdict.margins.distanceAboveVwapPct - recomputedPct) < 1e-9,
    'distanceAboveVwapPct must be recomputable from the trigger bar\'s close and margins.vwap alone');
}

async function testFmtMarginRendersPriceFieldsWithDollarSign() {
  // Direct check on the render layer's own formatting rule (index.js),
  // read as source rather than imported (index.js is not designed to be
  // loaded standalone in this test environment) -- confirms the new
  // PRICE_MARGIN_KEYS set actually includes every raw-price field the
  // classifiers now emit, so a future field added to one without the
  // other silently falls back to a bare, unlabeled number instead of $X.XX.
  const src = readSource('engines/warrior/index.js');
  const setKeys = ['breakoutHigh', 'aLevel', 'cLevel', 'vwap'];
  for (const key of setKeys) {
    assert.ok(new RegExp(`'${key}'`).test(src), `PRICE_MARGIN_KEYS in index.js must list '${key}' so it renders with a $ prefix`);
  }
}

// ── entry/target/stop, position sizing ──────────────────────────────────

async function testEntryTargetStopUsesSwingLowUnlessTighterThanMaxStopPct() {
  const setups = await loadSetups();
  const bars = [
    bar(6, 25, 5, 5, 4.80, 5, 1),
    bar(6, 26, 5, 5, 4.85, 5, 1),
    bar(6, 27, 5, 5, 4.90, 5, 1),
    bar(6, 28, 5, 5, 4.88, 5, 1),
    bar(6, 29, 5, 5, 4.86, 5, 1), // swing low across these 5 = 4.80
    bar(6, 30, 5, 5.20, 5, 5.20, 1), // trigger bar, entry = triggerPrice supplied separately below
  ];
  const ets = setups.computeEntryTargetStop(bars, 5, 5.00, setups.SETUP_CONFIG.entryTargetStop);
  console.log('entry/target/stop (swing low case):', ets);
  // swingLow=4.80 vs floor=5.00*(1-0.05)=4.75 -> max(4.80,4.75)=4.80 (swing low is tighter/higher, wins)
  assert.strictEqual(ets.entry, 5.00);
  assert.ok(Math.abs(ets.stop - 4.80) < 0.001);
  assert.ok(Math.abs(ets.risk - 0.20) < 0.001);
  assert.ok(Math.abs(ets.target - (5.00 + 2.0 * 0.20)) < 0.001);
}

async function testEntryTargetStopFallsBackToMaxStopPctWhenSwingLowIsFurther() {
  const setups = await loadSetups();
  const bars = [
    bar(6, 25, 5, 5, 4.00, 5, 1), // swing low far away (4.00) -- should NOT be used directly
    bar(6, 26, 5, 5, 4.00, 5, 1),
    bar(6, 27, 5, 5, 4.00, 5, 1),
    bar(6, 28, 5, 5, 4.00, 5, 1),
    bar(6, 29, 5, 5, 4.00, 5, 1),
    bar(6, 30, 5, 5.20, 5, 5.20, 1),
  ];
  const ets = setups.computeEntryTargetStop(bars, 5, 5.00, setups.SETUP_CONFIG.entryTargetStop);
  // floor = 5.00*(1-0.05) = 4.75, which is HIGHER (tighter) than the 4.00 swing low -> max() picks 4.75
  assert.ok(Math.abs(ets.stop - 4.75) < 0.001, `expected the maxStopPct floor (4.75) to win over a distant swing low, got ${ets.stop}`);
}

async function testSuggestedSharesRiskConstraint() {
  const setups = await loadSetups();
  // entry=5, stop=4.80 -> risk=0.20/share. riskPerTrade=$10 -> 50 shares by risk.
  // availableBudget=$500 -> 100 shares by budget. Risk constraint binds (50 < 100).
  const result = setups.computeSuggestedShares(5.00, 4.80, 10, 500);
  console.log('sizing (risk-bound):', result);
  assert.strictEqual(result.shares, 50);
  assert.strictEqual(result.constraint, 'risk');
}

async function testSuggestedSharesBudgetConstraint() {
  const setups = await loadSetups();
  // entry=5, stop=4.80 -> risk=0.20/share. riskPerTrade=$50 -> 250 shares by risk.
  // availableBudget=$100 -> 20 shares by budget. Budget constraint binds.
  const result = setups.computeSuggestedShares(5.00, 4.80, 50, 100);
  console.log('sizing (budget-bound):', result);
  assert.strictEqual(result.shares, 20);
  assert.strictEqual(result.constraint, 'budget');
}

// ── armed levels (PRE session) ───────────────────────────────────────────

async function testComputeArmedLevelsFromPremarketBars() {
  const setups = await loadSetups();
  const bars = [
    bar(4, 5, 4.00, 4.10, 3.95, 4.05, 200),
    bar(5, 0, 4.10, 4.30, 4.05, 4.25, 400), // highest high so far: 4.30
    bar(5, 45, 4.25, 4.20, 4.15, 4.18, 300),
  ];
  const levels = setups.computeArmedLevels(bars);
  console.log('armed levels:', levels);
  assert.deepStrictEqual(levels, [{ id: 'gap-and-go', level: 4.30 }]);
}

async function testComputeArmedLevelsEmptyWithoutPremarketBars() {
  const setups = await loadSetups();
  assert.deepStrictEqual(setups.computeArmedLevels([]), []);
}

// ── orchestration: priority, LATE flag ──────────────────────────────────

async function testDetectSetupsPrioritizesAndFlagsLate() {
  const setups = await loadSetups();
  const candidate = { symbol: 'TEST', prevClose: 4.00 };
  // Build bars where BOTH hod-momentum and red-to-green trigger, at
  // different times, to check priority ordering (hod-momentum ranks
  // above red-to-green) and that a trigger >20 minutes before "now" gets
  // flagged late.
  const bars = [
    ...flatRun(6, 30, 16, 3.90, 1000), // below prevClose, building the prior-15-bar baseline
    bar(6, 46, 3.92, 4.10, 3.91, 4.05, 3000), // red-to-green trigger (crosses prevClose 4.00) AND a new HOD simultaneously
  ];
  const now = new Date(t(7, 10)); // 24 minutes after the 6:46 trigger -> LATE
  const { setups: result, primary } = setups.detectSetupsForCandidate(candidate, bars, { now, riskPerTradeDollars: 10, availableBudget: 500 });
  console.log('detected setups:', result.map(s => `${s.id}(late=${s.late})`));
  assert.ok(result.length >= 1);
  assert.ok(result.every(s => s.late === true), 'a trigger 24 minutes before "now" must be flagged LATE');
  if (result.length > 1) {
    const ids = result.map(s => s.id);
    const priorityIndex = id => setups.SETUP_PRIORITY.indexOf(id);
    for (let i = 1; i < ids.length; i++) assert.ok(priorityIndex(ids[i - 1]) <= priorityIndex(ids[i]), 'setups must be sorted by the documented priority order');
    assert.strictEqual(primary.id, ids[0]);
  }
}

async function testDetectSetupsNotLateWithinWindow() {
  const setups = await loadSetups();
  const candidate = { symbol: 'TEST', prevClose: 4.00 };
  const bars = [
    ...flatRun(6, 30, 16, 3.90, 1000),
    bar(6, 46, 3.92, 4.10, 3.91, 4.05, 3000),
  ];
  const now = new Date(t(6, 55)); // 9 minutes later -- within the 20min window
  const { setups: result } = setups.detectSetupsForCandidate(candidate, bars, { now, riskPerTradeDollars: 10, availableBudget: 500 });
  assert.ok(result.length >= 1);
  assert.ok(result.every(s => s.late === false));
}

async function testLateSetupsAreDemotedBelowNonLateRegardlessOfPriority() {
  const setups = await loadSetups();
  // Direct test of the sort comparator against plain objects — no bars,
  // no classifiers, no shared-price-action coupling to accidentally get
  // wrong (see the comment on _sortSetups for why this replaced an
  // earlier, vacuous version built on a real multi-setup bar fixture).
  const input = [
    { id: 'gap-and-go', late: true },   // highest priority, but late
    { id: 'red-to-green', late: false }, // lowest priority, but not late
    { id: 'hod-momentum', late: true },
    { id: 'abcd', late: false },
  ];
  const sorted = setups._sortSetups([...input]);
  console.log('sort order:', sorted.map(s => `${s.id}(late=${s.late})`));
  assert.deepStrictEqual(sorted.map(s => s.id), ['abcd', 'red-to-green', 'gap-and-go', 'hod-momentum'],
    'both non-late setups (sorted by priority: abcd before red-to-green) must come before both late ones (also sorted by priority: gap-and-go before hod-momentum), regardless of gap-and-go being the single highest-priority setup overall');
}

// ── _tradingDaysBetween ──────────────────────────────────────────────────

async function testTradingDaysBetweenExcludesWeekendsAndHolidays() {
  const setups = await loadSetups();
  // 2026-08-31 is a Monday, 2026-09-07 is Labor Day (a real HOLIDAYS
  // entry in core/clock.js).
  const days = setups._tradingDaysBetween('2026-08-28', '2026-09-08');
  console.log('trading days:', days);
  assert.deepStrictEqual(days, ['2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08'],
    'must exclude the weekend (8/29-8/30) and Labor Day (9/7) while including every other weekday');
}

async function testTradingDaysBetweenCrossesDSTWithoutSkippingOrDuplicating() {
  const setups = await loadSetups();
  // 2026-03-08 is a Sunday and the US spring-forward date -- pure
  // date-string arithmetic must not skip or double-count any day across
  // it. Range: Thu 3/5 through Wed 3/11.
  const days = setups._tradingDaysBetween('2026-03-05', '2026-03-11');
  console.log('DST-crossing trading days:', days);
  assert.deepStrictEqual(days, ['2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10', '2026-03-11'],
    'must correctly skip the weekend spanning the DST transition (3/7-3/8) without skipping or duplicating 3/9 the way real-instant "+24h" arithmetic would risk');
}

// ── estimateRangeScanRequests ────────────────────────────────────────────

async function testEstimateRangeScanRequests() {
  const setups = await loadSetups();
  // hod-momentum: no prevClose needed. 10 days, 5 symbols (1 chunk) -> 10 requests.
  assert.strictEqual(setups.estimateRangeScanRequests(['hod-momentum'], 5, 10), 10);
  // gap-and-go: needs prevClose. Same 10 days, 5 symbols -> 10 + 1 (one prevClose batch).
  assert.strictEqual(setups.estimateRangeScanRequests(['gap-and-go'], 5, 10), 11);
  // Symbol count exceeding REPLAY_CHUNK_SIZE (13) needs 2 chunks per day.
  assert.strictEqual(setups.estimateRangeScanRequests(['hod-momentum'], 20, 10), 20);
}

// ── scanDateRangeForSetups ────────────────────────────────────────────────

function makeDayBars(dateStr, closes) {
  // Bars for a single trading day, one per minute from 6:30am PT, using
  // the SAME real ptWallClockToInstant already loaded — dateStr varies
  // (unlike TRADING_DATE-fixed `bar()`), so built directly here.
  return closes.map((c, i) => {
    const totalMin = 390 + i;
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    const t = global.ptWallClockToInstant(dateStr, h, m).toISOString();
    return { t, o: c, h: c, l: c, c, v: 1000 };
  });
}

async function testScanDateRangeCarriesForwardPrevCloseAcrossDays() {
  const setups = await loadSetups();
  let prevCloseFetchCount = 0;
  global.alpacaGet = async () => { prevCloseFetchCount++; return { bars: { TEST: [{ t: '2026-08-23T20:00:00Z', c: 4.00 }] } }; };
  global._fetchRawMinuteBars = async (symbols, start, end, chunkSize, label) => {
    // label includes the date string fetchReplayBars was called with (see replay.js)
    const dateStr = label.split(' ').pop();
    const bars = makeDayBars(dateStr, Array(20).fill(4.10));
    const barsBySymbolAll = {};
    symbols.forEach(s => { barsBySymbolAll[s] = [...bars].reverse(); });
    return { barsBySymbolAll, requests: 1 };
  };
  const { resultsByDate, requests } = await setups.scanDateRangeForSetups('gap-and-go', ['TEST'], '2026-08-24', '2026-08-26');
  console.log('carry-forward scan requests:', requests, '| prevClose fetches:', prevCloseFetchCount, '| dates:', Object.keys(resultsByDate));
  assert.strictEqual(prevCloseFetchCount, 1, 'prevClose must be fetched once for the whole 3-day range, not once per day');
  assert.strictEqual(requests, 4, '3 days of bars + 1 prevClose fetch = 4, not 6 (2 per day)');
}

async function testScanDateRangeMarksFetchFailureWithoutAbortingTheScan() {
  const setups = await loadSetups();
  let callCount = 0;
  global._fetchRawMinuteBars = async (symbols, start, end, chunkSize, label) => {
    callCount++;
    if (callCount === 2) throw new Error('simulated network failure');
    const dateStr = label.split(' ').pop();
    const bars = makeDayBars(dateStr, Array(5).fill(4.10));
    const barsBySymbolAll = {};
    symbols.forEach(s => { barsBySymbolAll[s] = [...bars].reverse(); });
    return { barsBySymbolAll, requests: 1 };
  };
  const { resultsByDate } = await setups.scanDateRangeForSetups('hod-momentum', ['TEST'], '2026-08-24', '2026-08-26');
  const dates = Object.keys(resultsByDate);
  console.log('failure-handling result:', dates.map(d => `${d}: ${JSON.stringify(resultsByDate[d].TEST)}`));
  assert.strictEqual(dates.length, 3, 'a failed day must not stop the scan -- all 3 days must have a result');
  assert.ok(resultsByDate[dates[1]].TEST.notEvaluated, 'the failed day must be marked notEvaluated');
  assert.ok(/fetch failed/.test(resultsByDate[dates[1]].TEST.reason));
  assert.ok(!resultsByDate[dates[0]].TEST.notEvaluated, 'the day before the failure must still have real results');
  assert.ok(!resultsByDate[dates[2]].TEST.notEvaluated, 'the day after the failure must still have real results (self-healed)');
}

async function testScanDateRangeMarksNoDataWithoutFabricatingAResult() {
  const setups = await loadSetups();
  global._fetchRawMinuteBars = async () => ({ barsBySymbolAll: {}, requests: 1 }); // no symbol ever appears -- thin/delisted
  const { resultsByDate } = await setups.scanDateRangeForSetups('hod-momentum', ['THIN'], '2026-08-24', '2026-08-24');
  const result = resultsByDate['2026-08-24'].THIN;
  console.log('no-data result:', result);
  assert.strictEqual(result.notEvaluated, true);
  assert.ok(/no bars/.test(result.reason));
}

async function testScanDateRangeRespectsCancellation() {
  const setups = await loadSetups();
  let dayCount = 0;
  global._fetchRawMinuteBars = async (symbols, start, end, chunkSize, label) => {
    dayCount++;
    const dateStr = label.split(' ').pop();
    const bars = makeDayBars(dateStr, Array(5).fill(4.10));
    const barsBySymbolAll = {};
    symbols.forEach(s => { barsBySymbolAll[s] = [...bars].reverse(); });
    return { barsBySymbolAll, requests: 1 };
  };
  const { resultsByDate, tradingDays, cancelled } = await setups.scanDateRangeForSetups(
    'hod-momentum', ['TEST'], '2026-08-24', '2026-08-28',
    { isCancelled: () => dayCount >= 2 }
  );
  console.log('cancellation result:', { totalTradingDays: tradingDays.length, evaluatedDays: Object.keys(resultsByDate).length, cancelled });
  assert.strictEqual(cancelled, true);
  assert.ok(Object.keys(resultsByDate).length < tradingDays.length, 'must stop before evaluating every trading day in the range');
}

async function testScanDateRangeReportsProgressPerDay() {
  const setups = await loadSetups();
  global._fetchRawMinuteBars = async (symbols, start, end, chunkSize, label) => {
    const dateStr = label.split(' ').pop();
    const bars = makeDayBars(dateStr, Array(5).fill(4.10));
    const barsBySymbolAll = {};
    symbols.forEach(s => { barsBySymbolAll[s] = [...bars].reverse(); });
    return { barsBySymbolAll, requests: 1 };
  };
  const progressCalls = [];
  await setups.scanDateRangeForSetups('hod-momentum', ['TEST'], '2026-08-24', '2026-08-26', {
    onProgress: (p) => progressCalls.push(p),
  });
  console.log('progress calls:', progressCalls);
  assert.strictEqual(progressCalls.length, 3, 'onProgress must fire once per trading day');
  assert.deepStrictEqual(progressCalls.map(p => p.index), [0, 1, 2]);
  assert.deepStrictEqual(progressCalls.map(p => p.total), [3, 3, 3]);
}

// ── runSetupReplayForSymbols (Developer Tools replay panel wiring) ──────
// This is the function the classifier-picker dropdown actually calls —
// distinct from detectSetupsForCandidate's live-scan path, since the
// panel needs BOTH naive and re-armed counts (to show the re-arm rule's
// real effect) and needs prevClose fetched fresh for whatever historical
// date was requested, not read off a live candidate object.

async function testRunSetupReplayForSymbolsWithoutPrevClose() {
  const setups = await loadSetups();
  global._fetchRawMinuteBars = async (symbols) => {
    const bars = [...flatRun(6, 30, 16, 5.00, 1000), bar(6, 46, 5.00, 5.20, 4.98, 5.15, 4000)];
    const barsBySymbolAll = {};
    symbols.forEach(s => { barsBySymbolAll[s] = [...bars].reverse(); }); // desc, as the real primitive returns
    return { barsBySymbolAll, requests: 1 };
  };
  const { resultsBySymbol, requests } = await setups.runSetupReplayForSymbols('hod-momentum', ['TEST'], TRADING_DATE);
  const r = resultsBySymbol.TEST.bySetup['hod-momentum'];
  console.log('hod-momentum panel run:', { naive: r.naiveTriggers.length, rearmed: r.rearmedTriggers.length, requests });
  assert.strictEqual(requests, 1, 'hod-momentum needs no prevClose fetch — only the bar fetch');
  assert.strictEqual(r.naiveTriggers.length, 1);
  assert.strictEqual(r.rearmedTriggers.length, 1);
  assert.strictEqual(r.rearmDistancePct, setups.SETUP_CONFIG.rearmDistancePct);
  assert.deepStrictEqual(Object.keys(resultsBySymbol.TEST.bySetup), ['hod-momentum'], 'a single real setup id must produce exactly one bySetup entry');
}

async function testRunSetupReplayForSymbolsFetchesAndUsesPrevClose() {
  const setups = await loadSetups();
  global._fetchRawMinuteBars = async (symbols) => {
    const bars = [bar(5, 0, 4.40, 4.50, 4.35, 4.45, 500), ...flatRun(6, 30, 3, 4.46, 1000), bar(6, 33, 4.47, 4.60, 4.46, 4.58, 3000)];
    const barsBySymbolAll = {};
    symbols.forEach(s => { barsBySymbolAll[s] = [...bars].reverse(); });
    return { barsBySymbolAll, requests: 1 };
  };
  let capturedPrevCloseFetchSymbols = null;
  global.alpacaGet = async (path, params) => {
    capturedPrevCloseFetchSymbols = params.symbols;
    return { bars: { TEST: [{ t: '2026-08-23T20:00:00Z', c: 4.00 }] } }; // prevClose=4.00 -> gap-and-go's precondition (>=10%) is met by the fixture's premarket price 4.45
  };
  const { resultsBySymbol, requests } = await setups.runSetupReplayForSymbols('gap-and-go', ['TEST'], TRADING_DATE);
  const r = resultsBySymbol.TEST.bySetup['gap-and-go'];
  console.log('gap-and-go panel run:', { triggers: r.rearmedTriggers.length, requests, capturedPrevCloseFetchSymbols });
  assert.strictEqual(capturedPrevCloseFetchSymbols, 'TEST', 'must fetch prevClose for the requested symbol');
  assert.strictEqual(requests, 2, 'gap-and-go needs both the bar fetch and the prevClose fetch');
  assert.strictEqual(r.rearmedTriggers.length, 1, 'the fetched prevClose (4.00) must actually be used — the trigger only fires because the gap precondition is satisfied against it');
}

async function testRunSetupReplayForSymbolsAllSetupsRunsAllFiveOnOneFetch() {
  const setups = await loadSetups();
  let fetchCallCount = 0;
  global._fetchRawMinuteBars = async (symbols) => {
    fetchCallCount++;
    const bars = [...flatRun(6, 30, 16, 5.00, 1000), bar(6, 46, 5.00, 5.20, 4.98, 5.15, 4000)];
    const barsBySymbolAll = {};
    symbols.forEach(s => { barsBySymbolAll[s] = [...bars].reverse(); });
    return { barsBySymbolAll, requests: 1 };
  };
  let prevCloseCallCount = 0;
  global.alpacaGet = async () => { prevCloseCallCount++; return { bars: { TEST: [{ t: '2026-08-23T20:00:00Z', c: 4.00 }] } }; };

  const { resultsBySymbol, requests } = await setups.runSetupReplayForSymbols(setups.ALL_SETUPS_ID, ['TEST'], TRADING_DATE);
  const bySetup = resultsBySymbol.TEST.bySetup;
  console.log('all-setups panel run keys:', Object.keys(bySetup), '| fetch calls:', fetchCallCount, '| prevClose calls:', prevCloseCallCount);
  assert.deepStrictEqual(Object.keys(bySetup).sort(), setups.SETUP_REPLAY_CATALOG.map(e => e.id).sort(), 'ALL_SETUPS_ID must evaluate all five setups');
  assert.strictEqual(fetchCallCount, 1, 'bars must be fetched exactly once, shared across all five classifiers, not once per setup');
  assert.strictEqual(prevCloseCallCount, 1, 'prevClose (needed by 2 of 5 setups) must be fetched exactly once for the whole batch, not once per setup that needs it');
  assert.ok(bySetup['hod-momentum'].naiveTriggers.length >= 1, 'hod-momentum\'s own fixture-matching trigger must still fire inside the all-setups run');
}

async function testRunSetupReplayForSymbolsUnknownIdThrows() {
  const setups = await loadSetups();
  await assert.rejects(() => setups.runSetupReplayForSymbols('not-a-real-setup', ['TEST'], TRADING_DATE), /Unknown setup id/);
}

// ── Phase 5 acceptance: "every setup validated through the replay harness
// before shipping," literally — runs a real setup classifier through
// runReplay's actual bar-by-bar walk (not a single call against the full
// array), same as detectSetupsForCandidate does internally, same as a
// real historical replay run would.

async function testHodMomentumValidatedThroughReplayHarness() {
  loadClockGlobals();
  const setups = await import('../engines/warrior/setups.js');
  const replay = await import('../engines/warrior/replay.js');
  const bars = [
    ...flatRun(6, 30, 16, 5.00, 1000),
    bar(6, 46, 5.00, 5.20, 4.98, 5.15, 4000), // the same fixture as the direct-call test above
  ];
  const triggers = replay.runReplay(bars, setups.hodMomentumClassifier, { rearmDistancePct: setups.SETUP_CONFIG['hod-momentum'].rearmDistancePct || setups.SETUP_CONFIG.rearmDistancePct });
  console.log('hod-momentum via runReplay:', triggers.map(t => ({ index: t.triggerIndex, price: t.triggerPrice })));
  assert.strictEqual(triggers.length, 1, 'walking bar-by-bar through the real harness must find exactly the one genuine breakout');
  assert.strictEqual(triggers[0].triggerIndex, bars.length - 1, 'must trigger at the actual breakout bar, not earlier — no lookahead, same guarantee Phase 4 established');
}

// ── no real setup path calls EDGE's multi-day math (Phase 5 acceptance) ──

async function testNoSetupPathReferencesCalcEntryTargetStopOrCalcScore() {
  // Checks for actual invocation (name immediately followed by '(' on a
  // non-comment line), not mere mention — setups.js's own header comment
  // names calcEntryTargetStop to explain why it's avoided, which is not
  // a violation of this rule and shouldn't trip it. Scoped to all of
  // engines/warrior/, not just setups.js — the acceptance bullet says
  // "no Warrior code path," and index.js/gate.js/replay.js are all real
  // candidates for someone reaching for EDGE's math out of habit.
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'engines', 'warrior');
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const codeOnly = src.split('\n').map(line => line.replace(/\/\/.*/, '')).join('\n');
    assert.ok(!/\bcalcEntryTargetStop\s*\(/.test(codeOnly), `engines/warrior/${file} must never call EDGE's calcEntryTargetStop`);
    assert.ok(!/\bcalcScore\s*\(/.test(codeOnly), `engines/warrior/${file} must never call EDGE's calcScore`);
  }
}

(async () => {
  await run('setups: _volumeBaselineOverMinutes excludes bars outside the real-time window', testVolumeBaselineExcludesBarsOutsideTheRealTimeWindow);
  await run('setups: _volumeBaselineOverMinutes includes multiple bars with correct span', testVolumeBaselineIncludesMultipleBarsWithCorrectSpan);
  await run('setups: _volumeBaselineOverMinutes returns null with no prior bars in window', testVolumeBaselineReturnsNullWithNoPriorBarsInWindow);
  await run('setups: gap-and-go triggers on premarket-high break with volume confirmation', testGapAndGoTriggersOnPremarketHighBreakWithVolume);
  await run('setups: gap-and-go fails precondition below 10% gap', testGapAndGoFailsPreconditionBelow10PctGap);
  await run('setups: gap-and-go fails without volume confirmation', testGapAndGoFailsWithoutVolumeConfirmation);
  await run('setups: hod-momentum triggers on new high with volume', testHodMomentumTriggersOnNewHighWithVolume);
  await run('setups: hod-momentum excludes first 5 minutes', testHodMomentumExcludesFirst5Minutes);
  await run('setups: abcd full pattern triggers', testAbcdFullPattern);
  await run('setups: abcd fails when retracement outside 30-60% band', testAbcdFailsWhenRetracementOutsideBand);
  await run('setups: vwap-momentum triggers on pullback reclaim', testVwapMomentumTriggersOnPullbackReclaim);
  await run('setups: vwap-momentum fails without a prior genuine cross', testVwapMomentumFailsWithoutPriorCross);
  await run('setups: red-to-green triggers on cross above prevClose with volume', testRedToGreenTriggersOnCrossAbovePrevCloseWithVolume);
  await run('setups: red-to-green fails without having traded below prevClose', testRedToGreenFailsWithoutHavingTradedBelow);
  await run('setups: gap-and-go breakoutHigh margin is recomputable from the row', testGapAndGoBreakoutHighMarginIsRecomputable);
  await run('setups: hod-momentum breakoutHigh margin is recomputable from the row', testHodMomentumBreakoutHighMarginIsRecomputable);
  await run('setups: abcd retracement/gain margins are recomputable from the row', testAbcdRetracementAndGainMarginsAreRecomputable);
  await run('setups: vwap-momentum distance margin is recomputable from the row', testVwapMomentumDistanceMarginIsRecomputable);
  await run('setups: _fmtMargin (index.js) prices every raw-price margin field with $', testFmtMarginRendersPriceFieldsWithDollarSign);
  await run('setups: entry/target/stop uses swing low unless tighter than maxStopPct', testEntryTargetStopUsesSwingLowUnlessTighterThanMaxStopPct);
  await run('setups: entry/target/stop falls back to maxStopPct floor when swing low is further', testEntryTargetStopFallsBackToMaxStopPctWhenSwingLowIsFurther);
  await run('setups: suggested shares — risk constraint binds', testSuggestedSharesRiskConstraint);
  await run('setups: suggested shares — budget constraint binds', testSuggestedSharesBudgetConstraint);
  await run('setups: armed levels computed from premarket bars', testComputeArmedLevelsFromPremarketBars);
  await run('setups: armed levels empty without premarket bars', testComputeArmedLevelsEmptyWithoutPremarketBars);
  await run('setups: detectSetupsForCandidate prioritizes and flags LATE', testDetectSetupsPrioritizesAndFlagsLate);
  await run('setups: detectSetupsForCandidate does not flag LATE within the window', testDetectSetupsNotLateWithinWindow);
  await run('setups: hod-momentum validated through the actual replay harness walk', testHodMomentumValidatedThroughReplayHarness);
  await run('setups: LATE setups are demoted below non-late ones regardless of priority', testLateSetupsAreDemotedBelowNonLateRegardlessOfPriority);
  await run('setups: _tradingDaysBetween excludes weekends and holidays', testTradingDaysBetweenExcludesWeekendsAndHolidays);
  await run('setups: _tradingDaysBetween crosses DST without skipping or duplicating', testTradingDaysBetweenCrossesDSTWithoutSkippingOrDuplicating);
  await run('setups: estimateRangeScanRequests', testEstimateRangeScanRequests);
  await run('setups: scanDateRangeForSetups carries prevClose forward across days', testScanDateRangeCarriesForwardPrevCloseAcrossDays);
  await run('setups: scanDateRangeForSetups marks a fetch failure without aborting', testScanDateRangeMarksFetchFailureWithoutAbortingTheScan);
  await run('setups: scanDateRangeForSetups marks no-data without fabricating a result', testScanDateRangeMarksNoDataWithoutFabricatingAResult);
  await run('setups: scanDateRangeForSetups respects cancellation', testScanDateRangeRespectsCancellation);
  await run('setups: scanDateRangeForSetups reports progress per day', testScanDateRangeReportsProgressPerDay);
  await run('setups: runSetupReplayForSymbols (no prevClose needed) — naive/re-armed both computed', testRunSetupReplayForSymbolsWithoutPrevClose);
  await run('setups: runSetupReplayForSymbols fetches and actually uses prevClose for gap-and-go', testRunSetupReplayForSymbolsFetchesAndUsesPrevClose);
  await run('setups: runSetupReplayForSymbols(ALL_SETUPS_ID) runs all five on one fetch', testRunSetupReplayForSymbolsAllSetupsRunsAllFiveOnOneFetch);
  await run('setups: runSetupReplayForSymbols rejects an unknown setup id', testRunSetupReplayForSymbolsUnknownIdThrows);
  await run('setups: no path references EDGE\'s calcEntryTargetStop/calcScore', testNoSetupPathReferencesCalcEntryTargetStopOrCalcScore);
})();
