// engines/warrior/setups.js — Phase 5, setup detection.
// docs/warrior-engine-spec-v2.md Phase 5.
//
// ES module, statically imported by engines/warrior/index.js — same
// Warrior-file-importing-its-own-sibling shape as gate.js/replay.js (see
// gate.js's header for why that doesn't cross CLAUDE.md's shell/core/EDGE
// boundary). References core/clock.js's getPT/ptDateStr/ptWallClockToInstant
// and core/universe.js's _fetchRawMinuteBars as ordinary globals, same
// pattern gate.js/replay.js already established.
//
// Every classifier here is written to replay.js's exact classifier
// interface — (barsSoFar) -> {setupId, referenceLevel, referenceDirection,
// margins} | null — so the SAME function detects a setup live (below) and
// gets replayed historically (Phase 4's runReplay). That's not incidental
// reuse; it's how "every setup validated through the replay harness before
// shipping" (Phase 5 acceptance) is satisfied literally rather than by
// separate, divergent implementations.
import { runReplay, runReplayNaiveAndRearmed, REPLAY_CHUNK_SIZE, fetchReplayBars, fetchPrevCloseAsOf } from './replay.js';

// ── Sweepable config ─────────────────────────────────────────────────────
// Every threshold lives here, not as an inline constant — spec's own rule
// ("every threshold goes in a config object so the replay harness can
// sweep them") extended explicitly to maxStopPct/targetR/rearmDistancePct
// too: a constant in this file can't be swept without a code edit, and
// calibrating rearmDistancePct against real history (not picking it by
// feel) is the entire point the spec's "Re-arm rule" section makes.
// riskPerTradePct is NOT here — it's the one Settings-facing value the
// spec calls out explicitly ("a new Settings field"), read from
// state.settings by the live-scan caller, not this module.
const SETUP_CONFIG = {
  rearmDistancePct: 1.0, // global default; per-setup override below
  entryTargetStop: { maxStopPct: 0.05, targetR: 2.0, swingLowBars: 5 },
  // gap-and-go's denominator is deliberately UNCHANGED (still "mean of all
  // regular bars so far," matching the spec's literal "average of the
  // session's bars so far" wording) — its own trigger condition ("first
  // bar after the open" clearing premarketHigh) structurally fires within
  // the first few minutes, so the unbounded-growth exposure this fix
  // addresses elsewhere is mostly theoretical here. Still gets
  // baselineSpanMinutes reported (see the classifier below) for the same
  // transparency, just not the time-window redesign.
  'gap-and-go': { gapPct: 0.10, volumeMultiple: 2.0 },
  // priorMinutesForMeanVolume (not priorBarsForMeanVolume, as it was
  // originally) — see _volumeBaselineOverMinutes above.
  'hod-momentum': { volumeMultiple: 3.0, excludeFirstMinutes: 5, priorMinutesForMeanVolume: 15 },
  // abcd's B->C window is structurally defined by the price pattern
  // itself (the bars between the peak and the trough), not an
  // independent bar-count choice — left as-is, same treatment as
  // gap-and-go: baselineSpanMinutes reported, window shape unchanged.
  'abcd': { gainPct: 0.10, retracementMin: 0.30, retracementMax: 0.60, volumeMultiple: 1.5, firstMinutesForA: 60 },
  // Redesigned (was a single-prior-bar volumeRatio with threshold 1.0 --
  // "any uptick at all," confirmed too weak by live replay: 9 naive fires
  // in one day on one symbol, the one shown a loser). Now the same
  // time-windowed multi-bar baseline as hod-momentum/red-to-green, with a
  // real multiple in the same family range as its siblings.
  'vwap-momentum': { pullbackDistancePct: 0.5, volumeMultiple: 1.5, priorMinutesForMeanVolume: 15 },
  'red-to-green': { volumeMultiple: 2.0, priorMinutesForMeanVolume: 15, useSessionOpen: false },
};

function _rearmDistancePctFor(setupId) {
  const override = SETUP_CONFIG[setupId]?.rearmDistancePct;
  return typeof override === 'number' ? override : SETUP_CONFIG.rearmDistancePct;
}

// ── Session-boundary helpers ─────────────────────────────────────────────
// Regular session: 6:30am-1:00pm PT (tMin 390-780), matching
// core/clock.js's getMarketStatus() boundaries exactly. Pre-market: the
// replay/live fetch window's own start (1:00am PT / 4:00am ET) through
// 6:30am PT (tMin 60-390) — same boundary core/clock.js's
// isPreMarketHours() uses.
//
// __minuteOfDay/__isPremarketBar/__isRegularSessionBar (2026-08-31): cache
// fields, populated once per bars array by _precomputeBarSessionFields
// below. getPT() is date.toLocaleString(..., {timeZone}) — an Intl-backed
// conversion, not arithmetic, and every classifier's own filter call was
// invoking it fresh for every bar in barsSoFar, on every one of up to n
// outer replay iterations, across up to 10 replay passes per symbol/day
// (5 classifiers x naive + re-armed). For a dense day (AMIX 2026-08-25,
// 721 raw bars) that's on the order of 2.6 million Intl conversions where
// n alone would do. These three functions fall back to computing fresh
// when the cache field is absent (undefined, not just falsy — 0 is a
// valid minute-of-day) — every existing caller that hands them a plain,
// non-precomputed bar (every hand-built test fixture in
// tests/setups.test.js) keeps working exactly as before, just without
// the speed benefit, which doesn't matter at fixture scale.
// Correct-but-slow degradation is still silent degradation: the fallback
// below means a future call path that forgets _precomputeBarSessionFields
// doesn't error, doesn't produce a wrong answer — it just quietly
// reintroduces the exact 180-second stall, with nothing to say so. One
// console.warn, the first time ANY of the three fallbacks fires in a
// session (not per-call — a genuinely missed precompute would otherwise
// flood the console once per bar), naming which function hit it and the
// real call stack, so "mysteriously slow again" becomes "precompute
// didn't run on this path" instead of a re-investigation from zero.
let _sessionFieldsFallbackWarned = false;
function _warnSessionFieldsFallback(fnName) {
  if (_sessionFieldsFallbackWarned) return;
  _sessionFieldsFallbackWarned = true;
  const stack = (new Error().stack || '').split('\n').slice(1, 5).join('\n');
  console.warn(`[Warrior] ${fnName} computed a bar's session fields fresh instead of using the precomputed cache — _precomputeBarSessionFields was skipped on this path. Correct, but this is the exact O(n^2) Intl.DateTimeFormat cost that stalled the 2026-08-25 scan for 180+ seconds; it will reintroduce that stall at real bar counts. Call stack:\n${stack}`);
}

function _minuteOfDay(bar) {
  if (bar.__minuteOfDay !== undefined) return bar.__minuteOfDay;
  _warnSessionFieldsFallback('_minuteOfDay');
  const pt = getPT(new Date(bar.t));
  return pt.getHours() * 60 + pt.getMinutes();
}
function _isPremarketBar(bar) {
  if (bar.__isPremarketBar !== undefined) return bar.__isPremarketBar;
  _warnSessionFieldsFallback('_isPremarketBar');
  const m = _minuteOfDay(bar);
  return m >= 60 && m < 390;
}
function _isRegularSessionBar(bar) {
  if (bar.__isRegularSessionBar !== undefined) return bar.__isRegularSessionBar;
  _warnSessionFieldsFallback('_isRegularSessionBar');
  const m = _minuteOfDay(bar);
  return m >= 390 && m < 780;
}
function _minutesSinceRegularOpen(bar) { return _minuteOfDay(bar) - 390; }

// Walks bars ONCE, attaching each bar's derived session fields directly to
// the bar object — visible through every subsequent bars.slice() (slice
// copies references, not the objects themselves), so one call here covers
// every one of the up to 10 runReplay passes _evaluateSetupsAgainstBars/
// detectSetupsForCandidate make against the SAME bars array. Idempotent:
// checks the first bar and returns immediately if already done, so it's
// safe to call at more than one entry point without doubling the work.
function _precomputeBarSessionFields(bars) {
  if (!bars.length || bars[0].__minuteOfDay !== undefined) return;
  for (const bar of bars) {
    const pt = getPT(new Date(bar.t));
    const m = pt.getHours() * 60 + pt.getMinutes();
    bar.__minuteOfDay = m;
    bar.__isPremarketBar = m >= 60 && m < 390;
    bar.__isRegularSessionBar = m >= 390 && m < 780;
  }
}

function _mean(nums) { return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : NaN; }
function _minutesBetween(barA, barB) { return (new Date(barB.t).getTime() - new Date(barA.t).getTime()) / 60000; }

// ── Volume baseline, time-windowed not bar-count-windowed ───────────────
// Live-replay finding (2026-08-28): hod-momentum/red-to-green's original
// "last 15 BARS" baseline read 46.13x on a 64-bar (sparse) name against
// 2.21x on a 192-bar (dense) one for a similar-looking spike, because
// Alpaca only returns a bar for a minute that actually traded — "last 15
// bars" for a thin name can reach back 71 real minutes to find them,
// averaging in volume from over an hour ago and comparing it to right
// now. Same failure shape gate.js's RVOL fixed with intradayCurve():
// don't let elapsed real time silently vary while the window looks
// fixed. Fix here is simpler than RVOL's curve (this is a local
// spike-vs-recent-baseline check, not a whole-session cumulative one):
// bound the LOOKBACK by real minutes, not bar count, so a sparse name's
// baseline can only ever be genuinely recent, whatever that means for
// its own trading frequency.
//
// Returns null if there's no prior bar within the window at all (never
// silently falls back to something stale). meanVol is the mean of
// whatever bars actually fall in the window (could be 1 bar for a very
// thin name, matching that name's own real trading frequency rather
// than forcing a fixed count). spanMinutes/barCount are always reported
// alongside the resulting multiple (see _classifiersFor's margins below)
// so a thin baseline is visible even after being bounded, not just fixed
// silently — same "make it visible" principle as #1's session-remaining
// field.
function _volumeBaselineOverMinutes(regularBars, endIndexExclusive, minutes) {
  const cutoffMs = new Date(regularBars[endIndexExclusive].t).getTime() - minutes * 60000;
  const windowBars = [];
  for (let i = endIndexExclusive - 1; i >= 0; i--) {
    if (new Date(regularBars[i].t).getTime() < cutoffMs) break; // chronological order -> nothing earlier can be in-window either
    windowBars.unshift(regularBars[i]);
  }
  if (!windowBars.length) return null;
  return {
    meanVol: _mean(windowBars.map(b => b.v)),
    spanMinutes: windowBars.length > 1 ? _minutesBetween(windowBars[0], windowBars[windowBars.length - 1]) : 0,
    barCount: windowBars.length,
  };
}

// ── Pre-market armed levels — no trigger, no setup object ──────────────
// docs/warrior-engine-spec-v2.md Phase 5: "what Ross actually does at 6am
// is build a watchlist with levels, not wait for triggers." Displayed only
// during PRE (see evaluateSetupsBatch below) for QUALIFIED candidates —
// this is the SAME premarketHigh computation gap-and-go's own classifier
// needs once the regular session opens, just surfaced earlier as a level
// rather than waited on as a trigger. Genuinely nearly-free: the bars this
// reads are the same ones evaluateSetupsBatch already fetched for the gap
// calculation itself, no extra request.
function computePremarketHigh(bars) {
  const premarketBars = bars.filter(_isPremarketBar);
  if (!premarketBars.length) return null;
  return Math.max(...premarketBars.map(b => b.h));
}

function computeArmedLevels(bars) {
  const premarketHigh = computePremarketHigh(bars);
  return premarketHigh == null ? [] : [{ id: 'gap-and-go', level: premarketHigh }];
}

// ── Setup classifiers ─────────────────────────────────────────────────────
// All five return {setupId, referenceLevel, referenceDirection: 'above',
// margins} | null — 'above' is every one of these five's own shape (each
// is a breakout-above-a-level pattern); referenceDirection is included
// explicitly rather than assumed, so a future short-side setup has
// somewhere to say 'below' without changing runReplay's contract.
//
// gap-and-go and red-to-green need prevClose, which isn't derivable from
// bars — factory functions close over that per-candidate context, keeping
// the returned function itself pure and matching replay.js's
// (barsSoFar) -> verdict interface exactly.

function makeGapAndGoClassifier({ prevClose }, config = SETUP_CONFIG['gap-and-go']) {
  // Third param (unused) keeps this closure's call shape identical to
  // hodMomentumClassifier/abcdClassifier/vwapMomentumClassifier's
  // (barsSoFar, config, observe) — config is already bound above via this
  // factory's own default parameter, not re-passed per call, but a
  // uniform 3-arg shape across all five classifiers means callers (see
  // captureEvaluationDistribution) don't need to special-case which
  // family a setup id belongs to.
  return function gapAndGoClassifier(barsSoFar, _unusedConfig, observe) {
    if (typeof prevClose !== 'number' || prevClose <= 0) return null;
    const premarketBars = barsSoFar.filter(_isPremarketBar);
    if (!premarketBars.length) return null;
    const premarketHigh = Math.max(...premarketBars.map(b => b.h));
    const premarketPrice = premarketBars[premarketBars.length - 1].c;
    const gapPct = premarketPrice / prevClose - 1;
    if (gapPct < config.gapPct) return null;

    const regularBars = barsSoFar.filter(_isRegularSessionBar);
    if (!regularBars.length) return null;
    const current = regularBars[regularBars.length - 1];
    if (current.h <= premarketHigh) return null;
    const priorRegularBars = regularBars.slice(0, -1);
    if (!priorRegularBars.length) return null; // "first bar after the open" needs at least one prior regular bar to average against
    const avgVol = _mean(priorRegularBars.map(b => b.v));
    if (!(avgVol > 0)) return null;
    const volumeMultiple = current.v / avgVol;
    const baselineSpanMinutes = priorRegularBars.length > 1 ? _minutesBetween(priorRegularBars[0], priorRegularBars[priorRegularBars.length - 1]) : 0;
    // Distribution capture (2026-08-31): fires for EVERY bar that reaches
    // this point, regardless of whether volumeMultiple clears
    // config.volumeMultiple below — trigger rows alone are censored at
    // the threshold, and thresholds can't be calibrated from a
    // population that never shows what fell just short of them. observe
    // is optional (undefined for every real detection call, live or
    // replay) and reuses this exact computation, not a duplicate of it.
    if (observe) observe({ volumeMultiple, baselineSpanMinutes, baselineBarCount: priorRegularBars.length });
    if (volumeMultiple < config.volumeMultiple) return null;

    return {
      setupId: 'gap-and-go',
      referenceLevel: premarketHigh,
      referenceDirection: 'above',
      // priceAtBreakLevel (2026-08-31, Bug B): this classifier's gate is
      // HIGH-based (current.h <= premarketHigh, above) while the harness
      // was pricing every trigger at the bar's CLOSE regardless — meaning
      // a bar whose high broke out but whose close round-tripped back
      // below the level got priced at that lower close, making every
      // forward return look better than a real fill (near premarketHigh)
      // would have. Tells runReplay to price entry at referenceLevel
      // (verifiable — derived from prior bars, and independently checked
      // there against this bar's own high) instead of current.c. A
      // best-case, zero-slippage fill, not a claim of realism.
      priceAtBreakLevel: true,
      // breakoutHigh is included alongside the derived Pct so the margin
      // is recomputable from numbers actually shown in the row: the
      // trigger condition checks the BAR'S HIGH against premarketHigh
      // (referenceLevel, already shown), not the bar's close (triggerPrice,
      // also shown) — those are two different numbers on the same bar, and
      // without breakoutHigh visible, breakoutHighAbovePremarketHighPct
      // can't be checked against anything on the card. baselineSpanMinutes/
      // baselineBarCount report how much real time and how many actual
      // bars the "average of the session's bars so far" denominator
      // covers — this window is deliberately NOT time-bounded (unlike
      // hod-momentum/red-to-green/vwap-momentum below), so a thin name
      // with few bars still shows a wide span here; visible, not fixed.
      margins: {
        volumeMultiple, threshold: config.volumeMultiple, gapPct,
        breakoutHigh: current.h,
        breakoutHighAbovePremarketHighPct: (current.h - premarketHigh) / premarketHigh,
        baselineSpanMinutes, baselineBarCount: priorRegularBars.length,
      },
    };
  };
}

function hodMomentumClassifier(barsSoFar, config = SETUP_CONFIG['hod-momentum'], observe) {
  const regularBars = barsSoFar.filter(_isRegularSessionBar);
  if (!regularBars.length) return null;
  const current = regularBars[regularBars.length - 1];
  if (_minutesSinceRegularOpen(current) < config.excludeFirstMinutes) return null;

  const priorBars = regularBars.slice(0, -1);
  if (!priorBars.length) return null;
  const hod = Math.max(...priorBars.map(b => b.h));
  if (current.h <= hod) return null;

  const baseline = _volumeBaselineOverMinutes(regularBars, regularBars.length - 1, config.priorMinutesForMeanVolume);
  if (!baseline || !(baseline.meanVol > 0)) return null;
  const volumeMultiple = current.v / baseline.meanVol;
  // Distribution capture (2026-08-31): see gap-and-go's identical comment
  // above — fires for every bar reaching this point regardless of the
  // threshold check below.
  if (observe) observe({ volumeMultiple, baselineSpanMinutes: baseline.spanMinutes, baselineBarCount: baseline.barCount });
  if (volumeMultiple < config.volumeMultiple) return null;

  return {
    setupId: 'hod-momentum',
    referenceLevel: hod,
    referenceDirection: 'above',
    // priceAtBreakLevel (2026-08-31, Bug B) — same reasoning as gap-and-go
    // above: HIGH-based gate, harness was pricing at close regardless.
    priceAtBreakLevel: true,
    // Same reasoning as gap-and-go above: the trigger condition checks
    // the bar's HIGH against hod, not its close (triggerPrice) — breakoutHigh
    // makes breakoutHighAboveHodPct checkable against a number on the row
    // instead of a value that only ever existed inside this function.
    // baselineSpanMinutes/baselineBarCount: this window IS now time-bounded
    // (see _volumeBaselineOverMinutes), so span is at most
    // priorMinutesForMeanVolume by construction — still reported, since a
    // thin name can have a small barCount even within that bound (e.g. 2
    // bars spanning 12 of the 15 available minutes), which is itself
    // useful to see.
    margins: {
      volumeMultiple, threshold: config.volumeMultiple,
      breakoutHigh: current.h,
      breakoutHighAboveHodPct: (current.h - hod) / hod,
      baselineSpanMinutes: baseline.spanMinutes, baselineBarCount: baseline.barCount,
    },
  };
}

// A = session low in the first firstMinutesForA minutes; B = highest high
// after A; C = lowest low after B. Recomputed from scratch on every call
// (pure function of barsSoFar, no persisted state) — A/B/C can shift as
// later bars arrive, which is the correct behavior for a live, evolving
// read of the pattern, not a bug; the re-arm mechanism (runReplay) still
// prevents rapid re-triggering right after a completed breakout.
function abcdClassifier(barsSoFar, config = SETUP_CONFIG['abcd'], observe) {
  const regularBars = barsSoFar.filter(_isRegularSessionBar);
  if (regularBars.length < 5) return null; // A, B, C among prior bars, plus a current/trigger bar

  // A/B/C are searched among bars STRICTLY BEFORE the current one — not
  // the full array including it. Searching the full array lets the
  // current bar's own high become "B" whenever it's a new high (which it
  // often is, right when a real breakout is happening), leaving no room
  // for a "bar after B" or "bar after C" and making the pattern
  // unrecognizable at the exact moment it completes. This was a real bug,
  // caught by the fixture in tests/setups.test.js before this shipped.
  const current = regularBars[regularBars.length - 1];
  const priorBars = regularBars.slice(0, -1);

  let aIndex = -1, A = Infinity;
  priorBars.forEach((b, i) => { if (_minutesSinceRegularOpen(b) < config.firstMinutesForA && b.l < A) { A = b.l; aIndex = i; } });
  if (aIndex === -1 || !(A > 0)) return null;

  let bIndex = -1, B = -Infinity;
  for (let i = aIndex + 1; i < priorBars.length; i++) {
    if (priorBars[i].h > B) { B = priorBars[i].h; bIndex = i; }
  }
  if (bIndex === -1 || B / A - 1 < config.gainPct) return null;

  let cIndex = -1, C = Infinity;
  for (let i = bIndex + 1; i < priorBars.length; i++) {
    if (priorBars[i].l < C) { C = priorBars[i].l; cIndex = i; }
  }
  if (cIndex === -1) return null;

  const retracementPct = (B - C) / (B - A);
  if (retracementPct < config.retracementMin || retracementPct > config.retracementMax) return null;

  const abBars = priorBars.slice(aIndex, bIndex + 1);
  const bcBars = priorBars.slice(bIndex + 1, cIndex + 1);
  if (!abBars.length || !bcBars.length) return null;
  const abMeanVol = _mean(abBars.map(b => b.v));
  const bcMeanVol = _mean(bcBars.map(b => b.v));
  if (!(bcMeanVol < abMeanVol)) return null; // pullback on declining volume

  if (current.h <= B) return null;
  if (!(bcMeanVol > 0)) return null;
  const volumeMultiple = current.v / bcMeanVol;
  const baselineSpanMinutes = bcBars.length > 1 ? _minutesBetween(bcBars[0], bcBars[bcBars.length - 1]) : 0;
  // Distribution capture (2026-08-31): see gap-and-go's identical comment
  // above — fires for every bar reaching this point regardless of the
  // threshold check below.
  if (observe) observe({ volumeMultiple, baselineSpanMinutes, baselineBarCount: bcBars.length });
  if (volumeMultiple < config.volumeMultiple) return null;

  return {
    setupId: 'abcd',
    referenceLevel: B,
    referenceDirection: 'above',
    // priceAtBreakLevel (2026-08-31, Bug B) — same reasoning as
    // gap-and-go/hod-momentum: this gate is also HIGH-based
    // (current.h <= B, above), the same mismatch, just less visible here
    // since abcd fired only once in the sample that found it.
    priceAtBreakLevel: true,
    // retracementPct/gainPct are both computed from A and C, neither of
    // which appears anywhere else on the card (only B, as referenceLevel,
    // and the trigger's own close, as triggerPrice, are shown) — without
    // aLevel/cLevel here, neither derived Pct is checkable against
    // anything visible. baselineSpanMinutes/baselineBarCount describe the
    // B->C window volumeMultiple is measured against — deliberately NOT
    // time-bounded like hod-momentum/red-to-green/vwap-momentum, since
    // this window is the pullback itself (structurally defined by the
    // price pattern, not an independent choice), but still reported so a
    // B->C pullback that happens to span a long, thin stretch is visible.
    margins: {
      volumeMultiple, threshold: config.volumeMultiple,
      aLevel: A, cLevel: C,
      gainPct: B / A - 1, retracementPct,
      baselineSpanMinutes, baselineBarCount: bcBars.length,
    },
  };
}

// Epsilon for the entry-bar VWAP gate below — absorbs float rounding in
// the cumulative division only. Real tick size on these symbols is
// $0.01, ~100x larger, so this can never admit a genuine gap. Distinct
// on purpose from config.pullbackDistancePct (0.5%): that number answers
// "is this bar close enough to VWAP to count as a pullback," this one
// answers "is price above VWAP at entry" — different questions, and
// borrowing the 0.5% here would readmit the exact case this gate exists
// to reject (HVII 2026-08-24 idx 141, distanceAboveVwapPct -0.07%, well
// inside a 0.5% tolerance).
const VWAP_ENTRY_EPSILON = 0.0001;

function vwapMomentumClassifier(barsSoFar, config = SETUP_CONFIG['vwap-momentum'], observe) {
  const regularBars = barsSoFar.filter(_isRegularSessionBar);
  if (regularBars.length < 3) return null;

  // Cumulative VWAP AS OF each bar's own position — needed for the
  // crossing/pullback checks below, not just the final value.
  let cumPV = 0, cumVol = 0;
  const vwapSeries = regularBars.map(b => {
    const typicalPrice = (b.h + b.l + b.c) / 3;
    cumPV += typicalPrice * b.v;
    cumVol += b.v;
    return cumVol > 0 ? cumPV / cumVol : null;
  });

  const currentIndex = regularBars.length - 1;
  const current = regularBars[currentIndex];
  const currentVwap = vwapSeries[currentIndex];

  // MOST-RECENT-qualifying pullback, scanning BACKWARD from the bar
  // immediately before the trigger bar — not the session's first
  // qualifying pullback. 2026-08-31 fix: the old forward-from-start
  // search pinned crossedIndex/pullbackIndex to the FIRST cross and
  // FIRST pullback of the day and never let them advance (a `break` on
  // first match against an array that only ever grows means the same
  // earliest match every call) — one morning pullback armed the setup to
  // fire on every later bar clearing that one stale level, all day, with
  // VWAP free to drift anywhere in between. That's the actual mechanism
  // behind HVII 2026-08-25's 28 naive triggers and both below-VWAP
  // triggers found in the prior run.
  let pullbackIndex = -1;
  for (let i = currentIndex - 1; i >= 1; i--) {
    const vwap = vwapSeries[i];
    if (vwap == null) continue;
    const distPct = Math.abs(regularBars[i].l - vwap) / vwap * 100;
    if (distPct <= config.pullbackDistancePct && regularBars[i].c >= vwap) { pullbackIndex = i; break; }
  }
  if (pullbackIndex === -1) return null;

  // The cross that armed THIS pullback — also most-recent, but searched
  // backward from the pullback itself, with NO staleness bound of its
  // own: a cross that happened at the open and held all session before
  // pulling back late is a legitimate sustained-trend pullback, not a
  // stale one. Staleness only ever applies to the pullback, never to the
  // cross that preceded it.
  let crossedIndex = -1;
  for (let i = pullbackIndex; i >= 1; i--) {
    if (vwapSeries[i - 1] == null || vwapSeries[i] == null) continue;
    if (regularBars[i - 1].c < vwapSeries[i - 1] && regularBars[i].c >= vwapSeries[i]) { crossedIndex = i; break; }
  }
  if (crossedIndex === -1) return null;

  const pullbackBar = regularBars[pullbackIndex];
  if (current.c <= pullbackBar.h) return null;

  // VWAP condition on the ENTRY bar itself (Part 3) — a setup named
  // "VWAP momentum" enforced the VWAP relationship only historically (at
  // the cross/pullback), never at entry, which is how two 2026-08-31 gate
  // runs fired below current VWAP: referenceLevel (the pullback bar's
  // high) and currentVwap are independent numbers that can diverge by
  // the time a later bar clears the former.
  if (currentVwap == null || current.c < currentVwap - VWAP_ENTRY_EPSILON) return null;

  // Redesigned 2026-08-29 (live-replay finding): was current.v > prevBar.v
  // (a single-prior-bar volumeRatio, threshold 1.0 -- "any uptick at
  // all"). Confirmed too weak live: 9 naive fires in one day on one
  // symbol, the one shown a loser. A 1-bar baseline is also the worst
  // case of the sparsity problem the OTHER setups had with a 15-bar
  // window -- no averaging at all. Now the same time-windowed multi-bar
  // baseline as hod-momentum/red-to-green, with a real multiple in the
  // same family range as its siblings (1.5x, matching ABCD).
  const baseline = _volumeBaselineOverMinutes(regularBars, currentIndex, config.priorMinutesForMeanVolume);
  if (!baseline || !(baseline.meanVol > 0)) return null;
  const volumeMultiple = current.v / baseline.meanVol;
  // Distribution capture (2026-08-31): see gap-and-go's identical comment
  // above — fires for every bar reaching this point (i.e. every bar that
  // already cleared the pullback/cross/VWAP-entry gates) regardless of
  // the threshold check below.
  if (observe) observe({ volumeMultiple, baselineSpanMinutes: baseline.spanMinutes, baselineBarCount: baseline.barCount });
  if (volumeMultiple < config.volumeMultiple) return null;

  return {
    setupId: 'vwap-momentum',
    referenceLevel: pullbackBar.h,
    referenceDirection: 'above',
    // distanceAboveVwapPct is measured against currentVwap, a THIRD number
    // distinct from both referenceLevel (the pullback bar's high, used for
    // re-arm) and triggerPrice (this bar's close) — vwap must be shown
    // explicitly or the Pct has nothing on the card to check it against.
    margins: {
      volumeMultiple, threshold: config.volumeMultiple,
      vwap: currentVwap,
      distanceAboveVwapPct: currentVwap ? (current.c - currentVwap) / currentVwap : null,
      baselineSpanMinutes: baseline.spanMinutes, baselineBarCount: baseline.barCount,
    },
  };
}

function makeRedToGreenClassifier({ prevClose }, config = SETUP_CONFIG['red-to-green']) {
  // Third param (unused) — see gapAndGoClassifier's identical comment above.
  return function redToGreenClassifier(barsSoFar, _unusedConfig, observe) {
    const regularBars = barsSoFar.filter(_isRegularSessionBar);
    if (regularBars.length < 2) return null;
    const referenceClose = config.useSessionOpen ? regularBars[0].o : prevClose;
    if (typeof referenceClose !== 'number' || referenceClose <= 0) return null;

    const tradedBelow = regularBars.some(b => b.l < referenceClose);
    if (!tradedBelow) return null;
    const current = regularBars[regularBars.length - 1];
    if (current.c <= referenceClose) return null;

    const baseline = _volumeBaselineOverMinutes(regularBars, regularBars.length - 1, config.priorMinutesForMeanVolume);
    if (!baseline || !(baseline.meanVol > 0)) return null;
    const volumeMultiple = current.v / baseline.meanVol;
    // Distribution capture (2026-08-31): see gap-and-go's identical
    // comment above — fires for every bar reaching this point regardless
    // of the threshold check below.
    if (observe) observe({ volumeMultiple, baselineSpanMinutes: baseline.spanMinutes, baselineBarCount: baseline.barCount });
    if (volumeMultiple < config.volumeMultiple) return null;

    return {
      setupId: 'red-to-green',
      referenceLevel: referenceClose,
      referenceDirection: 'above',
      // distanceAbovePrevClosePct is already fully recomputable without an
      // extra field: both operands (current.c and referenceClose) are
      // shown on the row already, as triggerPrice and referenceLevel
      // respectively — this setup's own trigger condition is close-based,
      // unlike gap-and-go/hod-momentum's high-based checks, so there's no
      // hidden reference for THAT margin. baselineSpanMinutes/
      // baselineBarCount describe the (now time-windowed, not bar-count)
      // volumeMultiple denominator instead.
      margins: {
        volumeMultiple, threshold: config.volumeMultiple,
        distanceAbovePrevClosePct: (current.c - referenceClose) / referenceClose,
        baselineSpanMinutes: baseline.spanMinutes, baselineBarCount: baseline.barCount,
      },
    };
  };
}

// ── Entry / target / stop, position sizing ──────────────────────────────
// Deliberately NOT calcEntryTargetStop (EDGE's multi-day ATR math is wrong
// for same-day tight-stop trades — spec's explicit instruction, and
// enforced mechanically by scripts/check-boundaries.sh-adjacent grep in
// tests, see tests/setups.test.js).
function computeEntryTargetStop(bars, triggerIndex, triggerPrice, config = SETUP_CONFIG.entryTargetStop) {
  const entry = triggerPrice;
  const precedingBars = bars.slice(Math.max(0, triggerIndex - config.swingLowBars), triggerIndex);
  const recentSwingLow = precedingBars.length ? Math.min(...precedingBars.map(b => b.l)) : null;
  const floorStop = entry * (1 - config.maxStopPct);
  const stop = recentSwingLow != null ? Math.max(recentSwingLow, floorStop) : floorStop;
  const risk = entry - stop;
  if (!(risk > 0)) return null; // defensive — a trigger price at or below its own stop floor is not a computable trade, never fabricated
  const target = entry + config.targetR * risk;
  return { entry, stop, risk, target };
}

// riskPerTradeDollars/availableBudget are caller-supplied (from
// state.settings.riskPerTradePct × budget, and the same budget-deployed
// formula EDGE's own budget bar already uses — see app.js's
// getAvailableBudget()) rather than computed here, keeping this module
// free of any dependency on EDGE's state shape.
// Epsilon before flooring: entry/stop arrive as ordinary floats (e.g.
// 5.00 - 4.80 = 0.20000000000000018 in IEEE 754), and dividing by a
// value that's a hair OVER the mathematically-intended one pushes the
// quotient a hair UNDER the intended whole number — Math.floor alone
// then reports one share less than the real math supports. This is
// exactly the kind of off-by-one that erodes trust in a sizing number,
// caught by a direct test (5.00/4.80/$10 risk must give 50, not 49).
function _floorWithEpsilon(x) { return Math.floor(x + 1e-9); }

function computeSuggestedShares(entry, stop, riskPerTradeDollars, availableBudget) {
  const risk = entry - stop;
  if (!(risk > 0) || !(riskPerTradeDollars > 0)) return { shares: 0, constraint: null };
  const riskBasedShares = _floorWithEpsilon(riskPerTradeDollars / risk);
  const budgetBasedShares = availableBudget > 0 ? _floorWithEpsilon(availableBudget / entry) : 0;
  return riskBasedShares <= budgetBasedShares
    ? { shares: riskBasedShares, constraint: 'risk' }
    : { shares: budgetBasedShares, constraint: 'budget' };
}

// ── Per-candidate orchestration ─────────────────────────────────────────
const SETUP_PRIORITY = ['gap-and-go', 'abcd', 'vwap-momentum', 'hod-momentum', 'red-to-green'];
const LATE_THRESHOLD_MIN = 20;

function _classifiersFor(candidate) {
  return [
    { id: 'gap-and-go', fn: makeGapAndGoClassifier({ prevClose: candidate.prevClose }) },
    { id: 'abcd', fn: abcdClassifier },
    { id: 'vwap-momentum', fn: vwapMomentumClassifier },
    { id: 'hod-momentum', fn: hodMomentumClassifier },
    { id: 'red-to-green', fn: makeRedToGreenClassifier({ prevClose: candidate.prevClose }) },
  ];
}

// Runs every classifier through runReplay (the SAME function Phase 4's
// replay harness uses) across the candidate's full fetched bar history —
// live detection IS a replay ending at "now," not a parallel code path.
// Takes each setup's LAST trigger as its current state (a setup that
// fired 12 minutes ago and hasn't re-armed is still "active," per the
// re-arm rule); minutesSinceTrigger/LATE is computed from that trigger's
// own timestamp, never fabricated from "now" alone.
function detectSetupsForCandidate(candidate, bars, { now = new Date(), riskPerTradeDollars = 0, availableBudget = 0 } = {}) {
  if (!bars || !bars.length) return { setups: [], primary: null };
  _precomputeBarSessionFields(bars);

  const setups = [];
  for (const { id, fn } of _classifiersFor(candidate)) {
    const triggers = runReplay(bars, fn, { rearmDistancePct: _rearmDistancePctFor(id) });
    if (!triggers.length) continue;
    const last = triggers[triggers.length - 1];
    const minutesSinceTrigger = (now.getTime() - new Date(last.triggerTime).getTime()) / 60000;
    const ets = computeEntryTargetStop(bars, last.triggerIndex, last.triggerPrice);
    const sizing = ets ? computeSuggestedShares(ets.entry, ets.stop, riskPerTradeDollars, availableBudget) : { shares: 0, constraint: null };
    setups.push({
      id: last.setupId,
      triggerPrice: last.triggerPrice,
      triggeredAt: last.triggerTime,
      minutesSinceTrigger,
      late: minutesSinceTrigger > LATE_THRESHOLD_MIN,
      referenceLevel: last.referenceLevel,
      margins: last.margins,
      entryTargetStop: ets,
      suggestedShares: sizing.shares,
      sizingConstraint: sizing.constraint,
    });
  }
  _sortSetups(setups);
  return { setups, primary: setups[0] || null };
}

// Spec: ">20min flagged LATE and demoted" — demoted means sorted below
// non-late setups, not just tagged. Non-late setups sort by the
// documented priority first; late ones sort the same way among
// themselves but always after every non-late one, so a fresh signal
// never gets buried under a stale one just because the stale one happens
// to be gap-and-go and the fresh one is red-to-green.
//
// Extracted as its own function (rather than inlined in
// detectSetupsForCandidate) after the first version of that test turned
// out vacuous: a hand-built multi-setup bar fixture had gap-and-go and
// hod-momentum sharing the same underlying price rise, so both ended up
// triggering on the same bar and both came out "late" — the demotion
// assertion never actually exercised a non-late/late pair. Testing this
// comparator directly, against plain {id, late} objects with no bars or
// classifiers involved, has no such coupling to get right by accident.
function _sortSetups(setups) {
  setups.sort((a, b) => {
    if (a.late !== b.late) return a.late ? 1 : -1;
    return SETUP_PRIORITY.indexOf(a.id) - SETUP_PRIORITY.indexOf(b.id);
  });
  return setups;
}

// ── Live-scan batch entry point ─────────────────────────────────────────
// Fetch window matches replay.js's own default (1:00am PT / 4:00am ET
// through "now") — same 720-minute worst case, so REPLAY_CHUNK_SIZE's
// proof applies unchanged; importing it rather than restating an
// identical proof under a new name keeps the one assumption (this window
// shape) in one place.
//
// Session-scoped: PRE gets armed levels only (no setup can trigger before
// the open — every trigger definition above requires a post-open bar,
// even gap-and-go: "first bar AFTER the open"); OPEN gets full detection;
// AH/CLOSED get neither (nothing new could have formed, and re-running
// detection against a frozen session would just repeat OPEN's last
// result at a request cost for no new information).
async function evaluateSetupsBatch(qualifiedCandidates, session, opts = {}) {
  if (session !== 'OPEN' && session !== 'PRE') return { resultsBySymbol: {}, requests: 0 };
  if (!qualifiedCandidates.length) return { resultsBySymbol: {}, requests: 0 };

  const now = opts.now || new Date();
  const symbols = qualifiedCandidates.map(c => c.symbol);
  const dateStr = ptDateStr(getPT(now));
  const start = ptWallClockToInstant(dateStr, 1, 0);
  const { barsBySymbolAll, requests } = await _fetchRawMinuteBars(symbols, start, now, REPLAY_CHUNK_SIZE, `setup detection (${session})`);

  const resultsBySymbol = {};
  for (const candidate of qualifiedCandidates) {
    const barsDesc = barsBySymbolAll[candidate.symbol] || [];
    const bars = [...barsDesc].reverse(); // desc -> asc, same as replay.js's fetchReplayBars
    if (session === 'PRE') {
      resultsBySymbol[candidate.symbol] = { armedLevels: computeArmedLevels(bars), setups: [], primary: null };
    } else {
      const { setups, primary } = detectSetupsForCandidate(candidate, bars, opts);
      resultsBySymbol[candidate.symbol] = { armedLevels: [], setups, primary };
    }
  }
  return { resultsBySymbol, requests };
}

// ── Replay panel: run a REAL setup against real history ─────────────────
// Phase 5 acceptance's first bullet ("every setup validated through the
// replay harness before shipping") is not satisfied by unit-test fixtures
// alone — a fixture written from the same reasoning that produced the
// classifier will tend to agree with it regardless of whether the
// classifier is actually right, the exact failure shape this session has
// found repeatedly elsewhere. This is what lets the Developer Tools
// replay panel run a REAL classifier (not just Phase 4's disposable
// example) against REAL historical bars, so a genuine live check —
// distinct from and stronger than the fixtures in tests/setups.test.js —
// is possible before trusting these five in production.
//
// gap-and-go/red-to-green need prevClose; the other three are pure
// functions of the fetched bars alone. Centralized here (rather than in
// index.js's UI code) because "which setups need what context" is
// setup-specific domain knowledge this file already owns.
const SETUP_REPLAY_CATALOG = [
  { id: 'gap-and-go', label: 'Gap and Go', needsPrevClose: true, build: (ctx) => makeGapAndGoClassifier({ prevClose: ctx.prevClose }) },
  { id: 'hod-momentum', label: 'HOD Momentum', needsPrevClose: false, build: () => hodMomentumClassifier },
  { id: 'abcd', label: 'ABCD', needsPrevClose: false, build: () => abcdClassifier },
  { id: 'vwap-momentum', label: 'VWAP Momentum', needsPrevClose: false, build: () => vwapMomentumClassifier },
  { id: 'red-to-green', label: 'Red-to-Green', needsPrevClose: true, build: (ctx) => makeRedToGreenClassifier({ prevClose: ctx.prevClose }) },
];

// Sentinel for "run every setup," not one of the five real ids — added
// 2026-08-29 after live-replay validation of all five, one at a time,
// turned out to be 10 separate runs (and 10 separate fetches) for what
// should have been 2: comparing setups against the same day's bars is
// the common case, not five independent investigations.
const ALL_SETUPS_ID = 'all-setups';

function _setupIdsFor(requestedId) {
  return requestedId === ALL_SETUPS_ID ? SETUP_REPLAY_CATALOG.map(e => e.id) : [requestedId];
}

function _anyNeedsPrevClose(setupIds) {
  return setupIds.some(id => SETUP_REPLAY_CATALOG.find(e => e.id === id)?.needsPrevClose);
}

// Runs BOTH naive (no re-arm) and re-armed replay for the same fetched
// bars, for every requested setup — no extra fetch cost per setup, just
// more runReplay calls against bars already in memory — so a live run
// against real data directly shows the re-arm rule's actual effect
// (naive count vs. real-event count) for as many setups as requested at
// once.
//
// prevCloseUsable is a single already-verified number, or null/undefined —
// resolved by the caller (scanDateRangeForSetups), not this function. This
// function doesn't know or care WHY a close is or isn't usable (missing,
// stale, fetch failed); it only knows "usable" vs "not." A setup that
// needsPrevClose gets a per-setup notEvaluated entry instead of running
// with a fabricated or stale prevClose — Ross's actual gap-and-go/red-to-
// green math is meaningless without a genuine previous close, and running
// them anyway with null/0 would silently produce a wrong gapPct/reference
// instead of an honest "couldn't check."
function _evaluateSetupsAgainstBars(setupIds, bars, prevCloseUsable) {
  _precomputeBarSessionFields(bars);
  const bySetup = {};
  for (const setupId of setupIds) {
    const entry = SETUP_REPLAY_CATALOG.find(e => e.id === setupId);
    if (!entry) continue;
    if (entry.needsPrevClose && prevCloseUsable == null) {
      bySetup[setupId] = { notEvaluated: true, reason: 'no verified previous-trading-day close available' };
      continue;
    }
    const classifier = entry.build({ prevClose: prevCloseUsable });
    const rearmDistancePct = _rearmDistancePctFor(setupId);
    // runReplayNaiveAndRearmed (2026-09-01, "the free 2x"): one classifier
    // pass instead of two separate runReplay calls -- see its header
    // comment in replay.js. Same naiveTriggers/rearmedTriggers shape as
    // before, byte-identical output, half the classifier calls.
    const { naiveTriggers, rearmedTriggers } = runReplayNaiveAndRearmed(bars, classifier, rearmDistancePct);
    bySetup[setupId] = { naiveTriggers, rearmedTriggers, rearmDistancePct };
  }
  return bySetup;
}

// ── Distribution capture (2026-08-31) ────────────────────────────────────
// Required before thresholds can be calibrated rather than guessed:
// trigger rows are censored at the current volumeMultiple threshold by
// construction (a bar that fell short never becomes a trigger row), so
// they can never show what the near-misses looked like or how close the
// threshold is to the bulk of the distribution. Walks bars once per
// setup with the SAME incremental barsSoFar-grows-one-bar-at-a-time
// pattern runReplay uses (no lookahead — a bar's observation only ever
// reflects bars up to and including itself), and records every
// observation each classifier's own `observe` callback reports. This
// reuses the exact volumeMultiple/baseline computation each classifier
// already does for real detection — not a parallel reimplementation that
// could drift out of sync with it.
function captureEvaluationDistribution(setupIds, bars, prevCloseUsable) {
  _precomputeBarSessionFields(bars);
  const observationsBySetup = {};
  for (const setupId of setupIds) {
    const entry = SETUP_REPLAY_CATALOG.find(e => e.id === setupId);
    if (!entry) continue;
    if (entry.needsPrevClose && prevCloseUsable == null) {
      observationsBySetup[setupId] = []; // same precondition _evaluateSetupsAgainstBars enforces — no prevClose, no observations, not a fabricated zero-cost run
      continue;
    }
    const classifier = entry.build({ prevClose: prevCloseUsable });
    const observations = [];
    for (let i = 0; i < bars.length; i++) {
      const barsSoFar = bars.slice(0, i + 1);
      classifier(barsSoFar, undefined, (obs) => observations.push({ index: i, ...obs }));
    }
    observationsBySetup[setupId] = observations;
  }
  return observationsBySetup;
}

// Nearest-rank percentile — no interpolation, so every reported value is
// an actual observation from the sample, never a synthesized number
// between two real ones (matters for eyeballing "is p99 close to an
// actual outlier bar or an artifact of interpolation").
function _percentile(sortedAscending, p) {
  if (!sortedAscending.length) return null;
  const idx = Math.min(sortedAscending.length - 1, Math.floor((p / 100) * sortedAscending.length));
  return sortedAscending[idx];
}

function _distributionSummary(values) {
  const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!finite.length) return { count: 0, median: null, p75: null, p90: null, p99: null, max: null };
  const sorted = [...finite].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: _percentile(sorted, 50),
    p75: _percentile(sorted, 75),
    p90: _percentile(sorted, 90),
    p99: _percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

// Per symbol-day: caller supplies bars for ONE symbol on ONE day
// (matching scanDateRangeForSetups's own per-day-per-symbol loop, where
// this is called from) — summary stats over volumeMultiple,
// baselineSpanMinutes, and baselineBarCount for every bar each setup's
// classifier actually evaluated that day, not just the ones that fired.
function summarizeEvaluationDistribution(setupIds, bars, prevCloseUsable) {
  const observationsBySetup = captureEvaluationDistribution(setupIds, bars, prevCloseUsable);
  const summary = {};
  for (const setupId of Object.keys(observationsBySetup)) {
    const obs = observationsBySetup[setupId];
    summary[setupId] = {
      volumeMultiple: _distributionSummary(obs.map((o) => o.volumeMultiple)),
      baselineSpanMinutes: _distributionSummary(obs.map((o) => o.baselineSpanMinutes)),
      baselineBarCount: _distributionSummary(obs.map((o) => o.baselineBarCount)),
    };
  }
  return summary;
}

// ── Range scan: validate on real history across many days ───────────────
// docs/warrior-engine-spec-v2.md Phase 5's disagreement point (2026-08-29):
// unit-test fixtures prove internal consistency, not reachability — a
// fixture written from the same reasoning that wrote a classifier
// encodes the same wrong notion, if there is one, and both pass. "ABCD:
// 0 triggers" on one day of two symbols means nothing on its own; the
// same question across 60 real trading days does.

// Pure calendar-date arithmetic (UTC-based day increment on a Y-M-D
// triple), never real-instant arithmetic — a range spanning weeks to a
// year will very plausibly cross a DST transition, and "+24h in real ms"
// does NOT land on the next date's noon PT across one (this session's
// own timezone sweep exists because of exactly this class of mistake).
// Each candidate date's PT trading-day-ness is still checked via the
// proven-correct ptWallClockToInstant, just anchored by date-string
// increment instead of instant increment.
function _nextDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().split('T')[0];
}

// Mirror of _nextDateStr, same UTC-calendar-string arithmetic, walking
// backward — used only by _previousTradingDayStr below.
function _prevDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().split('T')[0];
}

// The trading day immediately before dateStr — a Friday close is the
// correct "previous close" for the following Monday, not "the most recent
// value I happen to be holding." Bounded at 10 calendar days back purely
// as a termination guarantee (a real calendar never has more than a
// handful of consecutive non-trading days); exhausting it returns
// whatever date the loop stopped at rather than looping forever — the
// caller's adjacency check on that date will simply never match a held
// value, which is the same safe "unusable" outcome as any other mismatch.
function _previousTradingDayStr(dateStr) {
  let cur = _prevDateStr(dateStr);
  for (let i = 0; i < 10; i++) {
    if (isTradingDay(getPT(ptWallClockToInstant(cur, 12, 0)))) return cur;
    cur = _prevDateStr(cur);
  }
  return cur;
}

function _tradingDaysBetween(startDateStr, endDateStr) {
  const days = [];
  let cur = startDateStr;
  while (cur <= endDateStr) { // YYYY-MM-DD strings compare correctly lexicographically
    if (isTradingDay(getPT(ptWallClockToInstant(cur, 12, 0)))) days.push(cur);
    cur = _nextDateStr(cur);
  }
  return days;
}

// Guardrail shown BEFORE running anything (index.js's pre-flight
// estimate) — not a guarantee, a typical-case number: assumes the
// carry-forward optimization below succeeds (one prevClose fetch for the
// whole range, not one per day). A symbol with real trading gaps can
// need more; this is a planning number, not a promise.
// prevCloseRequests assumes the PESSIMISTIC case, not the best case: the
// carry-forward chain in scanDateRangeForSetups is per-BATCH, not
// per-symbol — fetchPrevCloseAsOf issues one request per day for
// whichever symbols are still "missing" a same-adjacency prevClose, and
// a single symbol that never returns bars (typo, delisted ticker, wrong
// exchange — not hypothetical, confirmed live via the replay harness's
// permanent ZZZZQQ control symbol) can never write its own
// prevCloseBySymbol entry, so it stays "missing" forever and forces that
// whole batch's request to re-fire every day for the rest of the range.
// Assuming the optimistic one-fetch-for-the-whole-range case understates
// cost for exactly the input (a bad symbol in the list) a guardrail
// exists to catch. Worst case is chunksPerBatch requests EVERY day, so
// that's what's estimated: a guardrail must not under-promise.
function estimateRangeScanRequests(setupIds, symbolCount, tradingDaysCount) {
  const chunksPerBatch = Math.ceil(Math.max(symbolCount, 1) / REPLAY_CHUNK_SIZE);
  const barRequests = tradingDaysCount * chunksPerBatch;
  const prevCloseRequests = _anyNeedsPrevClose(setupIds) ? tradingDaysCount * chunksPerBatch : 0;
  return barRequests + prevCloseRequests;
}

// Walks the range in calendar order (required, not just convenient: the
// prevClose carry-forward below depends on days being processed in
// order) and reports progress/checks for cancellation between each day —
// opts.onProgress({index, total, dateStr}) and opts.isCancelled() are
// both optional, called (or checked) once per trading day.
//
// prevClose carry-forward, DATE-VERIFIED (2026-08-30 fix — this was
// originally specified as "day N's own last bar close is day N+1's
// prevClose" without specifying that N+1 must actually BE the trading day
// immediately after N. It wasn't: prevCloseBySymbol used to hold a bare
// number, checked only for existence (`== null`), so a value carried
// forward from day 2 would silently keep answering for day 4 if day 3's
// fetch came back empty — two-day-stale, reported as an ordinary
// prevClose with nothing to distinguish it from a fresh one. Holding
// {close, date} and checking date === the ACTUAL previous trading day
// (_previousTradingDayStr, isTradingDay-aware — a Friday close is correct
// for the following Monday) catches both the carry-forward case and a
// fresh fetch that itself lands on a non-adjacent day (a thin symbol that
// didn't trade the expected prior day either).
//
// A day's outright fetch failure never aborts the scan: that day's
// symbols are marked notEvaluated with the real error message, the loop
// continues, and any broken carry-forward chain self-heals on the next
// day that needs it (the "missing" filter below just re-fetches). A
// prevClose that exists but isn't usable (missing, stale, or the fetch
// itself failed) does NOT block the day's other setups — hod-momentum/
// abcd/vwap-momentum don't need it and still run against real bars;
// gap-and-go/red-to-green specifically get a per-setup notEvaluated
// instead of running against a fabricated or stale reference (see
// _evaluateSetupsAgainstBars).
// opts.symbolsByDate (2026-09-01): { [dateStr]: string[] } — when
// present, OVERRIDES the flat `symbols` list on a per-day basis (a
// reconstructed-movers scan needs a genuinely different symbol set each
// day; the flat `symbols` param can't express that). `symbols` itself is
// ignored for fetching/evaluation in this mode — pass [] or the union,
// it doesn't matter which. Every other code path (carry-forward,
// notEvaluated handling, distribution capture, progress reporting) is
// completely unchanged; only WHICH symbols a given day fetches/evaluates
// differs. This is the same function the browser-driven replay panel
// uses for its fixed-symbol-list mode — a bulk reconstructed-movers
// scan calls this directly (see scripts/run-symbol-day-scan.mjs) rather
// than a parallel reimplementation, specifically so the two paths cannot
// drift apart the way _renderReplaySymbolResult's bySetup mismatch and
// the single-day path's missing notEvaluated concept once did.
async function scanDateRangeForSetups(setupId, symbols, startDateStr, endDateStr, opts = {}) {
  const setupIds = _setupIdsFor(setupId);
  if (!setupIds.every(id => SETUP_REPLAY_CATALOG.some(e => e.id === id))) {
    throw new Error(`Unknown setup id for replay: ${setupId}`);
  }
  const tradingDays = _tradingDaysBetween(startDateStr, endDateStr);
  const needsPrevClose = _anyNeedsPrevClose(setupIds);
  const daySymbolsFor = (dateStr) => (opts.symbolsByDate ? (opts.symbolsByDate[dateStr] || []) : symbols);
  // totalSymbolDays (2026-09-01): a "day N of M" progress line is
  // meaningless at real scale -- most of the wall-clock cost is the
  // per-symbol CPU work WITHIN a day (classifier evaluation across
  // however many bars that symbol has), not the day count itself. A
  // 60-day/10-symbol-per-day scan and a 60-day/1-symbol-per-day scan
  // report the same "day 30 of 60" at the halfway point despite being
  // 10x apart in actual work done. In symbolsByDate mode, per-day counts
  // genuinely vary (a reconstructed-movers day might surface 14 or 19
  // names), so this sums the REAL per-day counts, not a flat multiply.
  const totalSymbolDays = tradingDays.reduce((sum, d) => sum + daySymbolsFor(d).length, 0);
  let symbolDaysCompleted = 0;

  const resultsByDate = {};
  let requests = 0;
  let cancelled = false;
  const prevCloseBySymbol = {}; // sym -> { close, date } | undefined

  for (let i = 0; i < tradingDays.length; i++) {
    if (opts.isCancelled && opts.isCancelled()) { cancelled = true; break; }
    const dateStr = tradingDays[i];
    const daySymbols = daySymbolsFor(dateStr);
    if (opts.onProgress) opts.onProgress({ index: i, total: tradingDays.length, dateStr, symbolDaysCompleted, totalSymbolDays });

    let barsBySymbol;
    try {
      const fetched = await fetchReplayBars(daySymbols, dateStr, opts.fetchOpts);
      barsBySymbol = fetched.barsBySymbol;
      requests += fetched.requests;
    } catch (err) {
      resultsByDate[dateStr] = {};
      for (const sym of daySymbols) resultsByDate[dateStr][sym] = { notEvaluated: true, reason: `fetch failed: ${err.message}` };
      symbolDaysCompleted += daySymbols.length;
      if (opts.onProgress) opts.onProgress({ index: i, total: tradingDays.length, dateStr, symbolDaysCompleted, totalSymbolDays });
      continue; // don't touch prevCloseBySymbol -- next day re-fetches whatever's missing
    }

    const expectedPrevDate = needsPrevClose ? _previousTradingDayStr(dateStr) : null;
    if (needsPrevClose) {
      const missing = daySymbols.filter(sym => {
        const held = prevCloseBySymbol[sym];
        return !held || held.date !== expectedPrevDate;
      });
      if (missing.length) {
        try {
          const { prevCloseBySymbol: fetched, requests: pcRequests } = await fetchPrevCloseAsOf(missing, dateStr);
          requests += pcRequests;
          Object.assign(prevCloseBySymbol, fetched); // fetched[sym] = {close, date} — date may or may not equal expectedPrevDate; checked below, not assumed
        } catch (err) {
          // prevClose fetch failing shouldn't blank out symbols whose
          // bars DID come back — leave prevCloseBySymbol as-is (still
          // unusable per the adjacency check below) and let bars-only
          // setups still evaluate.
        }
      }
    }

    resultsByDate[dateStr] = {};
    for (const sym of daySymbols) {
      const bars = barsBySymbol[sym] || [];
      if (!bars.length) {
        resultsByDate[dateStr][sym] = { notEvaluated: true, reason: 'no bars (market closed for this symbol, or no data)' };
        symbolDaysCompleted++;
        if (opts.onProgress) opts.onProgress({ index: i, total: tradingDays.length, dateStr, symbolDaysCompleted, totalSymbolDays, symbol: sym });
        continue;
      }
      const held = prevCloseBySymbol[sym];
      const prevCloseUsable = (needsPrevClose && held && held.date === expectedPrevDate) ? held.close : null;
      // barCount visible on every row — the only thing that distinguishes
      // "evaluated, didn't fire" from "never evaluated" when reading a
      // matrix by eye (2026-08-30 live-validation note).
      // distribution: per symbol-day summary stats over EVERY evaluated
      // bar (not just triggers) — see summarizeEvaluationDistribution's
      // header comment. CPU-only (reuses the same fetched bars, zero
      // extra requests — doesn't touch the request estimate/accounting).
      resultsByDate[dateStr][sym] = {
        barCount: bars.length,
        bySetup: _evaluateSetupsAgainstBars(setupIds, bars, prevCloseUsable),
        distribution: summarizeEvaluationDistribution(setupIds, bars, prevCloseUsable),
      };
      symbolDaysCompleted++;
      if (opts.onProgress) opts.onProgress({ index: i, total: tradingDays.length, dateStr, symbolDaysCompleted, totalSymbolDays, symbol: sym });
      prevCloseBySymbol[sym] = { close: bars[bars.length - 1].c, date: dateStr }; // carry forward regardless of whether THIS scan's setups needed it
    }
  }

  return { resultsByDate, tradingDays, requests, cancelled };
}

export {
  SETUP_CONFIG, SETUP_PRIORITY, LATE_THRESHOLD_MIN, SETUP_REPLAY_CATALOG, ALL_SETUPS_ID,
  computePremarketHigh, computeArmedLevels,
  makeGapAndGoClassifier, hodMomentumClassifier, abcdClassifier, vwapMomentumClassifier, makeRedToGreenClassifier,
  computeEntryTargetStop, computeSuggestedShares,
  detectSetupsForCandidate, evaluateSetupsBatch,
  scanDateRangeForSetups, estimateRangeScanRequests,
  captureEvaluationDistribution, summarizeEvaluationDistribution,
  _sortSetups, _volumeBaselineOverMinutes, _tradingDaysBetween, _previousTradingDayStr,
};
