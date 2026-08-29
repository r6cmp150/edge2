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
import { runReplay, REPLAY_CHUNK_SIZE, fetchReplayBars, fetchPrevCloseAsOf } from './replay.js';

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
  'gap-and-go': { gapPct: 0.10, volumeMultiple: 2.0 },
  'hod-momentum': { volumeMultiple: 3.0, excludeFirstMinutes: 5, priorBarsForMeanVolume: 15 },
  'abcd': { gainPct: 0.10, retracementMin: 0.30, retracementMax: 0.60, volumeMultiple: 1.5, firstMinutesForA: 60 },
  'vwap-momentum': { pullbackDistancePct: 0.5 },
  'red-to-green': { volumeMultiple: 2.0, priorBarsForMeanVolume: 15, useSessionOpen: false },
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
function _minuteOfDay(bar) {
  const pt = getPT(new Date(bar.t));
  return pt.getHours() * 60 + pt.getMinutes();
}
function _isPremarketBar(bar) { const m = _minuteOfDay(bar); return m >= 60 && m < 390; }
function _isRegularSessionBar(bar) { const m = _minuteOfDay(bar); return m >= 390 && m < 780; }
function _minutesSinceRegularOpen(bar) { return _minuteOfDay(bar) - 390; }

function _mean(nums) { return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : NaN; }

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
  return function gapAndGoClassifier(barsSoFar) {
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
    if (volumeMultiple < config.volumeMultiple) return null;

    return {
      setupId: 'gap-and-go',
      referenceLevel: premarketHigh,
      referenceDirection: 'above',
      margins: {
        volumeMultiple, threshold: config.volumeMultiple,
        gapPct, distanceAbovePremarketHigh: (current.h - premarketHigh) / premarketHigh,
      },
    };
  };
}

function hodMomentumClassifier(barsSoFar, config = SETUP_CONFIG['hod-momentum']) {
  const regularBars = barsSoFar.filter(_isRegularSessionBar);
  if (!regularBars.length) return null;
  const current = regularBars[regularBars.length - 1];
  if (_minutesSinceRegularOpen(current) < config.excludeFirstMinutes) return null;

  const priorBars = regularBars.slice(0, -1);
  if (!priorBars.length) return null;
  const hod = Math.max(...priorBars.map(b => b.h));
  if (current.h <= hod) return null;

  const priorN = priorBars.slice(-config.priorBarsForMeanVolume);
  const meanVol = _mean(priorN.map(b => b.v));
  if (!(meanVol > 0)) return null;
  const volumeMultiple = current.v / meanVol;
  if (volumeMultiple < config.volumeMultiple) return null;

  return {
    setupId: 'hod-momentum',
    referenceLevel: hod,
    referenceDirection: 'above',
    margins: { volumeMultiple, threshold: config.volumeMultiple, distanceAboveHod: (current.h - hod) / hod },
  };
}

// A = session low in the first firstMinutesForA minutes; B = highest high
// after A; C = lowest low after B. Recomputed from scratch on every call
// (pure function of barsSoFar, no persisted state) — A/B/C can shift as
// later bars arrive, which is the correct behavior for a live, evolving
// read of the pattern, not a bug; the re-arm mechanism (runReplay) still
// prevents rapid re-triggering right after a completed breakout.
function abcdClassifier(barsSoFar, config = SETUP_CONFIG['abcd']) {
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
  if (volumeMultiple < config.volumeMultiple) return null;

  return {
    setupId: 'abcd',
    referenceLevel: B,
    referenceDirection: 'above',
    margins: { volumeMultiple, threshold: config.volumeMultiple, retracementPct, gainPct: B / A - 1 },
  };
}

function vwapMomentumClassifier(barsSoFar, config = SETUP_CONFIG['vwap-momentum']) {
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

  let crossedIndex = -1;
  for (let i = 1; i < regularBars.length; i++) {
    if (vwapSeries[i - 1] == null || vwapSeries[i] == null) continue;
    if (regularBars[i - 1].c < vwapSeries[i - 1] && regularBars[i].c >= vwapSeries[i]) { crossedIndex = i; break; }
  }
  if (crossedIndex === -1) return null;

  let pullbackIndex = -1;
  for (let i = crossedIndex; i < regularBars.length; i++) {
    const vwap = vwapSeries[i];
    if (vwap == null) continue;
    const distPct = Math.abs(regularBars[i].l - vwap) / vwap * 100;
    if (distPct <= config.pullbackDistancePct && regularBars[i].c >= vwap) { pullbackIndex = i; break; }
  }
  if (pullbackIndex === -1) return null;

  const currentIndex = regularBars.length - 1;
  if (currentIndex <= pullbackIndex) return null;
  const pullbackBar = regularBars[pullbackIndex];
  const current = regularBars[currentIndex];
  const prevBar = regularBars[currentIndex - 1];
  if (current.c <= pullbackBar.h) return null;
  if (!(current.v > prevBar.v)) return null; // "rising volume" — no fixed multiple in this setup's own definition, so none is invented here

  const currentVwap = vwapSeries[currentIndex];
  return {
    setupId: 'vwap-momentum',
    referenceLevel: pullbackBar.h,
    referenceDirection: 'above',
    margins: {
      volumeRatio: current.v / prevBar.v, threshold: 1.0,
      distanceAboveVwap: currentVwap ? (current.c - currentVwap) / currentVwap : null,
    },
  };
}

function makeRedToGreenClassifier({ prevClose }, config = SETUP_CONFIG['red-to-green']) {
  return function redToGreenClassifier(barsSoFar) {
    const regularBars = barsSoFar.filter(_isRegularSessionBar);
    if (regularBars.length < 2) return null;
    const referenceClose = config.useSessionOpen ? regularBars[0].o : prevClose;
    if (typeof referenceClose !== 'number' || referenceClose <= 0) return null;

    const tradedBelow = regularBars.some(b => b.l < referenceClose);
    if (!tradedBelow) return null;
    const current = regularBars[regularBars.length - 1];
    if (current.c <= referenceClose) return null;

    const priorBars = regularBars.slice(0, -1).slice(-config.priorBarsForMeanVolume);
    if (!priorBars.length) return null;
    const meanVol = _mean(priorBars.map(b => b.v));
    if (!(meanVol > 0)) return null;
    const volumeMultiple = current.v / meanVol;
    if (volumeMultiple < config.volumeMultiple) return null;

    return {
      setupId: 'red-to-green',
      referenceLevel: referenceClose,
      referenceDirection: 'above',
      margins: {
        volumeMultiple, threshold: config.volumeMultiple,
        distanceAbovePrevClose: (current.c - referenceClose) / referenceClose,
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

// Runs BOTH naive (no re-arm) and re-armed replay for the same fetched
// bars — no extra request cost, just a second runReplay call — so a live
// run against real data directly shows the re-arm rule's actual effect
// (naive count vs. real-event count), the same comparison
// tests/replay.test.js's fixture makes, but on genuine history instead
// of a reproduction of HVII's shape.
async function runSetupReplayForSymbols(setupId, symbols, dateStr, opts = {}) {
  const entry = SETUP_REPLAY_CATALOG.find(e => e.id === setupId);
  if (!entry) throw new Error(`Unknown setup id for replay: ${setupId}`);

  const { barsBySymbol, requests: barRequests } = await fetchReplayBars(symbols, dateStr, opts);

  let prevCloseBySymbol = {};
  let prevCloseRequests = 0;
  if (entry.needsPrevClose) {
    const result = await fetchPrevCloseAsOf(symbols, dateStr);
    prevCloseBySymbol = result.prevCloseBySymbol;
    prevCloseRequests = result.requests;
  }

  const rearmDistancePct = _rearmDistancePctFor(setupId);
  const resultsBySymbol = {};
  for (const sym of symbols) {
    const bars = barsBySymbol[sym] || [];
    const classifier = entry.build({ prevClose: prevCloseBySymbol[sym] });
    resultsBySymbol[sym] = {
      barCount: bars.length,
      naiveTriggers: runReplay(bars, classifier),
      rearmedTriggers: runReplay(bars, classifier, { rearmDistancePct }),
      rearmDistancePct,
    };
  }
  return { resultsBySymbol, requests: barRequests + prevCloseRequests };
}

export {
  SETUP_CONFIG, SETUP_PRIORITY, LATE_THRESHOLD_MIN, SETUP_REPLAY_CATALOG,
  computePremarketHigh, computeArmedLevels,
  makeGapAndGoClassifier, hodMomentumClassifier, abcdClassifier, vwapMomentumClassifier, makeRedToGreenClassifier,
  computeEntryTargetStop, computeSuggestedShares,
  detectSetupsForCandidate, evaluateSetupsBatch, runSetupReplayForSymbols,
  _sortSetups,
};
