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
    bar(6, 34, 4.95, 5.05, 4.94, 5.02, 2000), // trigger: closes above pullback bar's high (4.99) on rising volume vs prior bar (900)
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
  const candidate = { symbol: 'TEST', prevClose: 4.00 };
  // gap-and-go (highest priority) triggers early -> will be LATE.
  // red-to-green (lowest priority) triggers just before "now" -> not late.
  const bars = [
    bar(5, 0, 4.40, 4.50, 4.35, 4.45, 500),   // premarket, premarketHigh=4.50, gap=11.25%
    ...flatRun(6, 30, 20, 4.46, 1000),        // regular session baseline, also traded below prevClose(4.00)? no -- keep prevClose low so red-to-green precondition differs; reuse 4.00 prevClose from gap-and-go's own baseline instead
    bar(6, 50, 4.47, 4.60, 4.46, 4.58, 3000), // gap-and-go trigger (breaks premarketHigh 4.50) -- this will be "old" relative to now
    ...flatRun(6, 51, 5, 4.58, 1000),
    bar(6, 56, 4.55, 4.65, 4.54, 4.62, 3000), // hod-momentum trigger too, recent
  ];
  const now = new Date(t(7, 15)); // 25 min after the gap-and-go trigger (late), 19 min after the hod-momentum one (not late)
  const { setups: result } = setups.detectSetupsForCandidate(candidate, bars, { now, riskPerTradeDollars: 10, availableBudget: 500 });
  console.log('demotion order:', result.map(s => `${s.id}(late=${s.late})`));
  assert.ok(result.length >= 2, 'fixture must produce at least two setups for this test to mean anything');
  const firstLateIndex = result.findIndex(s => s.late);
  if (firstLateIndex !== -1) {
    for (let i = 0; i < firstLateIndex; i++) assert.strictEqual(result[i].late, false, 'every non-late setup must sort before every late one, regardless of priority');
  }
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
  await run('setups: no path references EDGE\'s calcEntryTargetStop/calcScore', testNoSetupPathReferencesCalcEntryTargetStopOrCalcScore);
})();
