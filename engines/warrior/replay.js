// engines/warrior/replay.js — Phase 4, the replay harness.
// docs/warrior-engine-spec-v2.md Phase 4.
//
// ES module, statically imported by engines/warrior/index.js — same
// Warrior-file-importing-its-own-sibling shape as gate.js (see that
// file's header for why that doesn't cross CLAUDE.md's shell/core/EDGE
// boundary). References core/universe.js's _fetchRawMinuteBars and
// core/clock.js's ptWallClockToInstant/getPT as ordinary globals, same
// pattern gate.js already established for _fetchCumulativeMinuteVolume etc.
//
// Phase 5 doesn't exist yet, so there is no real setup classifier to
// replay against. examplePriceMoveClassifier below is a deliberately
// simple, self-contained stand-in (reuses gate.js's real CHANGE_MIN_PCT
// rather than inventing a new threshold) — NOT an attempt at a real
// Warrior setup. The classifier is a plain injectable function
// ((barsSoFar) -> {setupId} | null); real Phase 5 setups replace this
// without any change to runReplay/computeForwardReturns below.
import { CHANGE_MIN_PCT } from './gate.js';

// ── Fetch ────────────────────────────────────────────────────────────────
// Default window: 4:00am ET (1:00am PT — the same boundary
// core/clock.js's isPreMarketHours already uses) through regular-session
// close (1:00pm PT) = 720 minutes. Gap and Go triggers on the first
// post-open bar clearing the PRE-MARKET high; a regular-session-only
// window makes that unreplayable. The window is a parameter (not a
// compile-time constant) so a caller can widen or narrow it.
//
// Chunk-size proof covers the DEFAULT window only: 10,000-bar single-page
// ceiling / 720 minutes = 13.89 -> floor 13. 13*720=9,360 (single-page);
// 14*720=10,080 (would paginate). A caller-supplied wider window can't
// carry this same static proof, so correctness there falls back to
// _fetchRawMinuteBars's own next_page_token-following (already tested,
// tests/pagination-merge.test.js) — more round trips, still correct.
const REPLAY_CHUNK_SIZE = 13;

async function fetchReplayBars(symbols, dateStr, { startHour = 1, startMinute = 0, endHour = 13, endMinute = 0 } = {}) {
  const start = ptWallClockToInstant(dateStr, startHour, startMinute);
  const end = ptWallClockToInstant(dateStr, endHour, endMinute);
  const { barsBySymbolAll, requests } = await _fetchRawMinuteBars(symbols, start, end, REPLAY_CHUNK_SIZE, `replay ${dateStr}`);
  // _fetchRawMinuteBars returns each symbol's bars sort:'desc' (newest
  // first) — replay needs chronological order.
  const barsBySymbol = {};
  for (const sym of Object.keys(barsBySymbolAll)) {
    barsBySymbol[sym] = [...barsBySymbolAll[sym]].reverse();
  }
  return { barsBySymbol, requests, start, end };
}

// gap-and-go and red-to-green need prevClose — NOT derivable from the
// replay window's own bars. core/universe.js's _getPriorCloses does the
// live equivalent, but it's hardcoded to "today" (getPT()/new Date()) —
// exactly the "as of a past date" gap Phase 4's own planning flagged and
// deliberately deferred for an RVOL baseline, now genuinely needed here
// so the replay panel can run gap-and-go/red-to-green at all. A small,
// date-parameterized daily-bar fetch, not a reimplementation of
// _getPriorCloses's caching (replay runs are manual/occasional, a fresh
// fetch every run is fine).
// Returns { prevCloseBySymbol: { sym: {close, date} }, requests } — date
// (not just close) so a caller can VERIFY which trading day this close is
// actually from, rather than assuming it's the expected previous trading
// day. It usually is, but a thin symbol that didn't trade on the expected
// prior day either would return the next most recent one before that —
// still a real close, just not an adjacent one, and setups.js's caller
// needs the date to catch that (2026-08-30 fix — see setups.js's
// scanDateRangeForSetups header comment for the carry-forward bug this
// closes).
async function fetchPrevCloseAsOf(symbols, dateStr) {
  const end = ptWallClockToInstant(dateStr, 1, 0); // replay window's own start — prevClose must be strictly before this
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 calendar days back, generous over any weekend/holiday gap
  let requests = 0;
  const prevCloseBySymbol = {};
  const params0 = { symbols: symbols.join(','), timeframe: '1Day', start: start.toISOString(), end: end.toISOString(), limit: 10000, sort: 'desc', feed: 'sip' };
  let pageToken;
  const barsBySymbol = {};
  do {
    const params = pageToken ? { ...params0, page_token: pageToken } : params0;
    const data = await alpacaGet('/stocks/bars', params);
    requests++;
    if (data.bars) {
      for (const sym of Object.keys(data.bars)) {
        (barsBySymbol[sym] = barsBySymbol[sym] || []).push(...data.bars[sym]);
      }
    }
    pageToken = data.next_page_token || null;
  } while (pageToken);
  // sort:'desc' -> each symbol's first bar is its most recent close before the replay window.
  for (const sym of Object.keys(barsBySymbol)) {
    const bars = barsBySymbol[sym];
    if (bars && bars.length) prevCloseBySymbol[sym] = { close: bars[0].c, date: ptDateStr(getPT(new Date(bars[0].t))) };
  }
  return { prevCloseBySymbol, requests };
}

// ── Forward-return / MFE / MAE scoring ──────────────────────────────────
// Runs AFTER a trigger is detected, on the FULL bars array — deliberately
// not subject to the no-lookahead constraint, which applies only to the
// classifier's own decision at replay time (see runReplay below). Looking
// forward from a trigger to score it is the whole point.
//
// The 'close' horizon is NOT comparable across triggers at different
// times of day, and was reported as if it were (live-replay finding,
// 2026-08-28): it scores against bars[bars.length-1] — whatever the
// fetched window's last bar happens to be — so a trigger 6 minutes
// before the window ends and one 5 hours before it get scored on the
// same axis despite having wildly different room to move. Kept
// (computing it is free, and "did this survive to end of day" is a real
// question for a specific trade) rather than deleted, but runReplay
// below always pairs every trigger's forwardReturns with
// minutesOfSessionRemainingAtTrigger precisely so this can't be silently
// misread as comparable the way it was before — same "make the
// incompleteness visible instead of hiding it" principle as gate.js's
// not-checked pillars and the QUALIFIED-header RVOL caveat.
const FORWARD_HORIZONS_MIN = [5, 15, 30]; // 'close' handled separately, no fixed minute offset
const REGULAR_SESSION_CLOSE_TMIN = 780; // 1:00pm PT — core/clock.js's own getMarketStatus() boundary

function _minutesUntilRegularSessionClose(bar) {
  const pt = getPT(new Date(bar.t));
  return REGULAR_SESSION_CLOSE_TMIN - (pt.getHours() * 60 + pt.getMinutes());
}

function _barIndexAtOrAfter(bars, fromIndexExclusive, targetTimeMs) {
  for (let i = fromIndexExclusive + 1; i < bars.length; i++) {
    if (new Date(bars[i].t).getTime() >= targetTimeMs) return i;
  }
  return -1;
}

// Every horizon reports {return, mfe, mae} — all null together if the
// session doesn't extend that far (never a partial/misleading window
// mislabeled as e.g. "5m" when only 2 minutes of bars actually existed —
// same "not fabricated" discipline as gate.js's not-checked pillars).
function computeForwardReturns(bars, triggerIndex) {
  const trigger = bars[triggerIndex];
  const result = {};

  const scoreWindow = (horizonIndex) => {
    if (horizonIndex === -1 || horizonIndex <= triggerIndex) return { return: null, mfe: null, mae: null };
    const window = bars.slice(triggerIndex + 1, horizonIndex + 1);
    if (!window.length) return { return: null, mfe: null, mae: null };
    const horizonBar = bars[horizonIndex];
    const pctReturn = ((horizonBar.c - trigger.c) / trigger.c) * 100;
    const maxHigh = Math.max(...window.map(b => b.h));
    const minLow = Math.min(...window.map(b => b.l));
    return {
      return: pctReturn,
      mfe: ((maxHigh - trigger.c) / trigger.c) * 100,
      mae: ((minLow - trigger.c) / trigger.c) * 100,
    };
  };

  for (const horizonMin of FORWARD_HORIZONS_MIN) {
    const targetTimeMs = new Date(trigger.t).getTime() + horizonMin * 60000;
    const horizonIndex = _barIndexAtOrAfter(bars, triggerIndex, targetTimeMs);
    result[`${horizonMin}m`] = scoreWindow(horizonIndex);
  }
  result.close = scoreWindow(bars.length - 1);

  return result;
}

// ── Replay loop ──────────────────────────────────────────────────────────
// The no-lookahead guarantee lives entirely in this one line: bars.slice()
// produces a genuine copy ending at index i, never a reference into the
// full array and never i+2 by an off-by-one. See docs/warrior-engine-
// spec-v2.md Phase 4's "No-lookahead" section for the two negative
// controls (tests/replay.test.js) that verify this is real, not just
// asserted.
//
// The harness NEVER reads a price or time field off the classifier's
// return value — trigger.triggerPrice/triggerTime are always derived from
// barsSoFar's own last element (== bars[i], the position the harness
// itself controls). This is a mitigation against a classifier that closes
// over data outside its argument and tries to self-report a fabricated
// price, not a claim that such a classifier can be prevented from
// deciding to trigger early in the first place — see the spec's Phase 4
// "Anchoring control" note. A classifier's return value therefore only
// ever needs to carry `setupId` (plus whatever caller-defined metadata it
// wants to keep, and — only when rearmDistancePct is in use, see below —
// referenceLevel/referenceDirection) — never price or time.
//
// Default mode (rearmDistancePct omitted): edge-triggered, not
// level-triggered — a classifier that stays truthy for many consecutive
// bars records ONE trigger at the first bar it went true, and resets the
// MOMENT it goes falsy, so the same setupId can trigger again immediately
// once the classifier's own condition is next satisfied. This is Phase
// 4's original, unchanged behavior — every existing caller/test that
// doesn't pass the new option gets byte-identical results.
//
// Re-arm mode (rearmDistancePct provided): docs/warrior-engine-spec-v2.md
// Phase 5's "Re-arm rule" — found via replaying HVII 2026-08-24 through
// Phase 4's own harness, where naive edge-triggering recorded six
// triggers for one price oscillating across a single threshold. Instead
// of resetting on the classifier's first falsy call, the harness enters a
// COOLING state remembering the classifier-supplied referenceLevel/
// referenceDirection from the triggering verdict, and only re-arms once
// price has retraced beyond rearmDistancePct from that level in the
// invalidating direction ('above' — the default — re-arms on a retreat
// BELOW level*(1-rearmDistancePct/100); 'below' re-arms on a rally ABOVE
// level*(1+rearmDistancePct/100)). referenceLevel is trusted from the
// classifier — unlike price/time, there's no incentive to misreport it
// (it only feeds this internal state machine, never the trigger record's
// own price/time, and a wrong value only makes THIS setup re-arm at the
// wrong distance, not fabricate a result elsewhere) — but it's still
// classifier-supplied domain knowledge (the HOD level, VWAP, etc.) the
// harness has no independent way to compute itself.
function runReplay(bars, classifier, { rearmDistancePct } = {}) {
  const triggers = [];
  let activeSetupId = null;
  let coolingLevel = null;
  let coolingDirection = null;

  const hasRetraced = (price) => {
    if (coolingLevel == null) return true; // no reference level supplied — nothing to wait for, behaves like default mode
    return coolingDirection === 'below'
      ? price >= coolingLevel * (1 + rearmDistancePct / 100)
      : price <= coolingLevel * (1 - rearmDistancePct / 100);
  };

  for (let i = 0; i < bars.length; i++) {
    const barsSoFar = bars.slice(0, i + 1);
    const current = barsSoFar[barsSoFar.length - 1];

    if (rearmDistancePct != null && activeSetupId != null && hasRetraced(current.c)) {
      activeSetupId = null;
      coolingLevel = null;
      coolingDirection = null;
    }

    const verdict = classifier(barsSoFar);

    if (!verdict) {
      if (rearmDistancePct == null) activeSetupId = null; // default mode: reset on every falsy call
      continue; // re-arm mode: stay cooling regardless of this call's verdict — only the retracement check above clears it
    }
    if (verdict.setupId === activeSetupId) continue; // same episode, already recorded

    activeSetupId = verdict.setupId;
    if (rearmDistancePct != null) {
      coolingLevel = typeof verdict.referenceLevel === 'number' ? verdict.referenceLevel : current.c;
      coolingDirection = verdict.referenceDirection === 'below' ? 'below' : 'above';
    }
    triggers.push({
      setupId: verdict.setupId,
      triggerIndex: i,
      triggerTime: current.t,
      triggerPrice: current.c,
      referenceLevel: verdict.referenceLevel ?? null,
      margins: verdict.margins ?? null,
      minutesOfSessionRemainingAtTrigger: _minutesUntilRegularSessionClose(current),
      forwardReturns: computeForwardReturns(bars, i),
    });
  }

  return triggers;
}

// ── Example classifier (Phase 4 stand-in — see file header) ────────────
// Reference "open" is barsSoFar[0] — the FIRST bar of whatever window was
// requested (1:00am PT by default, not necessarily the regular session's
// 6:30am open). Fine for exercising the harness mechanically; not an
// attempt at Gap and Go's actual pre-market-high/regular-open semantics,
// which belongs to a real Phase 5 setup, not this placeholder.
function examplePriceMoveClassifier(barsSoFar) {
  const openPrice = barsSoFar[0]?.o;
  const current = barsSoFar[barsSoFar.length - 1];
  if (typeof openPrice !== 'number' || typeof current?.c !== 'number' || openPrice === 0) return null;
  const changePct = ((current.c - openPrice) / openPrice) * 100;
  return changePct >= CHANGE_MIN_PCT ? { setupId: 'example-price-move' } : null;
}

// ── Orchestration across a symbol list ──────────────────────────────────
async function runReplayForSymbols(symbols, dateStr, classifier = examplePriceMoveClassifier, opts) {
  const { barsBySymbol, requests } = await fetchReplayBars(symbols, dateStr, opts);
  const resultsBySymbol = {};
  for (const sym of symbols) {
    const bars = barsBySymbol[sym] || [];
    resultsBySymbol[sym] = { barCount: bars.length, triggers: runReplay(bars, classifier) };
  }
  return { resultsBySymbol, requests };
}

export {
  REPLAY_CHUNK_SIZE,
  fetchReplayBars,
  fetchPrevCloseAsOf,
  computeForwardReturns,
  runReplay,
  examplePriceMoveClassifier,
  runReplayForSymbols,
};
