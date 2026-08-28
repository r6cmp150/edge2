// engines/warrior/replay.js — Phase 4, the replay harness.
// docs/warrior-engine-spec-v2.md Phase 4.
//
// ES module, statically imported by engines/warrior/index.js — same
// Warrior-file-importing-its-own-sibling shape as gate.js (see that
// file's header for why that doesn't cross CLAUDE.md's shell/core/EDGE
// boundary). References core/universe.js's _fetchRawMinuteBars and
// core/clock.js's ptWallClockToInstant as ordinary globals, same pattern
// gate.js already established for _fetchCumulativeMinuteVolume etc.
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

// ── Forward-return / MFE / MAE scoring ──────────────────────────────────
// Runs AFTER a trigger is detected, on the FULL bars array — deliberately
// not subject to the no-lookahead constraint, which applies only to the
// classifier's own decision at replay time (see runReplay below). Looking
// forward from a trigger to score it is the whole point.
const FORWARD_HORIZONS_MIN = [5, 15, 30]; // 'close' handled separately, no fixed minute offset

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
// Edge-triggered, not level-triggered: a classifier that stays truthy for
// many consecutive bars (e.g. price holds >10% for 50 minutes) records
// ONE trigger at the first bar it went true, not 50 near-duplicate
// triggers a minute apart. Resets the moment the classifier returns
// falsy, so the same setupId can trigger again later in the session as a
// genuinely new episode.
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
// wants to keep) — never price or time.
function runReplay(bars, classifier) {
  const triggers = [];
  let activeSetupId = null;

  for (let i = 0; i < bars.length; i++) {
    const barsSoFar = bars.slice(0, i + 1);
    const verdict = classifier(barsSoFar);

    if (!verdict) {
      activeSetupId = null;
      continue;
    }
    if (verdict.setupId === activeSetupId) continue; // same episode, already recorded

    activeSetupId = verdict.setupId;
    const current = barsSoFar[barsSoFar.length - 1];
    triggers.push({
      setupId: verdict.setupId,
      triggerIndex: i,
      triggerTime: current.t,
      triggerPrice: current.c,
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
  computeForwardReturns,
  runReplay,
  examplePriceMoveClassifier,
  runReplayForSymbols,
};
