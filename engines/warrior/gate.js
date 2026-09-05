// engines/warrior/gate.js — Phase 3, the 5 Pillars gate.
// docs/warrior-engine-spec-v2.md Phase 3.
//
// ES module, statically imported by engines/warrior/index.js (fine —
// Warrior's own files importing each other doesn't cross the shell/core/
// EDGE boundary CLAUDE.md protects; that boundary is about core/shell/EDGE
// never reaching INTO Warrior, and Warrior never reaching into EDGE). This
// file references core/universe.js's exported fetchers, core/news.js's
// fetchNewsForTickers, getFloatDataForSymbols (Phase 6 — defined by
// core/float-table.js in the browser as of 2026-09-04, a static-table
// lookup; core/edgar.js's own live-fetch version of the same function
// name is Node-only now, called only from scripts/build-float-table.mjs —
// see either file's header for why), and core/clock.js's
// getPT/getMarketStatus as ordinary globals — same as
// engines/warrior/index.js already does for state/registerEngine. See
// that file's header for why that's expected, not a boundary leak: the
// rule is one-directional.
//
// This file owns the ACTUAL gate logic (thresholds, the intraday curve,
// pillar pass/fail/not-checked rules). core/universe.js's Phase 3 additions
// (_fetchCumulativeMinuteVolume, _getSip30DayAvgVolume) are deliberately
// plain data fetchers with no gate-specific business logic baked in —
// RVOL/pillar thresholds are Warrior-specific, EDGE has its own unrelated
// volume-ratio concept (scoreStock's volRatio), and core/ stays reusable.

const PRICE_MIN = 1.00;
const PRICE_MAX = 20.00;
const CHANGE_MIN_PCT = 10;
const RVOL_MIN = 5.0;
const NEWS_MAX_AGE_HOURS = 24;
const RVOL_NOT_YET_AVAILABLE_MIN = 15; // SIP delay — see core/universe.js PREMARKET_BAR_DELAY_MIN
const FLOAT_THRESHOLD_DEFAULT_SHARES = 10_000_000; // spec's own stated default, Phase 6 — configurable via Settings (state.settings.floatThresholdShares), never hardcoded past this fallback

// Retention bound for state.warriorPreMarketRvolObservations (2026-09-04,
// real risk, not tidiness): unbounded + persisted means every localStorage
// write for the WHOLE app degrades toward a quota failure, and a quota
// failure doesn't just drop this one field -- persist()'s own fix
// (core/store.js) means a LATER write for ANY key (settings, sold
// history, portfolio-adjacent caches) can start failing too, the exact
// "silent save stopped working" shape this project keeps finding. Both
// bounds applied together: age first (a 91-day-old observation is stale
// for a percentile that should track current conditions anyway, not just
// storage pressure), then count (5,000 is comfortably enough for a real
// percentile estimate -- at ~30 survivors/morning that's ~5+ months of
// full history even before the age cutoff would have pruned anything).
const PRE_MARKET_RVOL_OBSERVATIONS_MAX_AGE_DAYS = 90;
const PRE_MARKET_RVOL_OBSERVATIONS_MAX_COUNT = 5000;

function _trimPreMarketRvolObservations(obs, now) {
  const cutoffMs = now.getTime() - PRE_MARKET_RVOL_OBSERVATIONS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const notTooOld = obs.filter(o => {
    const t = new Date(o.capturedAt).getTime();
    return !isNaN(t) && t >= cutoffMs;
  });
  if (notTooOld.length <= PRE_MARKET_RVOL_OBSERVATIONS_MAX_COUNT) return notTooOld;
  return notTooOld.slice(notTooOld.length - PRE_MARKET_RVOL_OBSERVATIONS_MAX_COUNT); // keep the most recent N
}

// Pillar 3's static cumulative-share table — a hardcoded approximation of
// intraday volume distribution, deliberately NOT elapsedMinutes/390 (a
// linear proxy reads ~1.7x RVOL for every stock at the open and deflates
// it midday — see the spec's derivation). Domain is the 390-minute regular
// session only (6:30am-1:00pm PT, matching core/clock.js's getMarketStatus
// boundaries exactly); callers must not use this outside session===OPEN.
// Phase 4 follow-up (per spec): the replay harness can derive a measured
// curve from history and replace this table.
const INTRADAY_CURVE = [
  [0, 0],
  [30, 0.13],
  [60, 0.21],
  [120, 0.32],
  [180, 0.41],
  [240, 0.50],
  [300, 0.61],
  [360, 0.78],
  [390, 1.00],
];

function intradayCurve(elapsedMinutes) {
  const m = Math.max(0, Math.min(390, elapsedMinutes));
  for (let i = 1; i < INTRADAY_CURVE.length; i++) {
    const [x0, y0] = INTRADAY_CURVE[i - 1];
    const [x1, y1] = INTRADAY_CURVE[i];
    if (m <= x1) {
      const t = (m - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return 1.0;
}

function _pillar(id, status, value, threshold, extra) {
  return { id, status, value, threshold, ...(extra || {}) };
}

function evaluatePillar1(candidate) {
  const price = candidate.price;
  const pass = typeof price === 'number' && price >= PRICE_MIN && price <= PRICE_MAX;
  return _pillar('price', pass ? 'pass' : 'fail', price, `$${PRICE_MIN.toFixed(2)}–$${PRICE_MAX.toFixed(2)}`);
}

function evaluatePillar2(candidate) {
  const changePct = candidate.changePct;
  const pass = typeof changePct === 'number' && changePct >= CHANGE_MIN_PCT;
  return _pillar('change', pass ? 'pass' : 'fail', changePct, `≥${CHANGE_MIN_PCT}%`);
}

// elapsedMinutes: minutes since regular-session open (6:30am PT), only
// meaningful when session==='OPEN' — callers must check session first.
// rvolInput: { todayVolume, avgDailyVolume, fetchFailed } for this
// candidate's symbol, or undefined if the batch fetch found nothing for it.
//
// fetchFailed (2026-09-04, gate-honesty pass): a REQUEST-level failure
// (rate-limited, network error — see core/universe.js's
// _fetchCumulativeMinuteVolume/_getSip30DayAvgVolume failedSymbols), never
// fabricated as a symbol that simply "has no volume data." Checked FIRST,
// ahead of the generic no-data fallback below, and never returns
// 'not-checked' — see classifyGate's comment for why the two states can't
// share a bucket: not-checked is structural (float, pre-market RVOL) and
// never blocks qualification; fetch-failed means "we tried to measure this
// and couldn't," and a stock we couldn't measure is not a stock that
// passed.
function evaluatePillar3(candidate, session, elapsedMinutes, rvolInput) {
  const threshold = `≥${RVOL_MIN}×`;
  if (session !== 'OPEN') {
    // Spec: no valid denominator pre-market or after-hours — the curve is
    // defined over the regular session only, and cumulative volume since
    // open is zero before the open. Never a 0x that reads as real.
    return _pillar('rvol', 'not-checked', null, threshold, { reason: 'not available outside regular session' });
  }
  if (elapsedMinutes < RVOL_NOT_YET_AVAILABLE_MIN) {
    return _pillar('rvol', 'not-checked', null, threshold, { reason: 'not yet available (first 15 min)' });
  }
  if (rvolInput && rvolInput.fetchFailed) {
    return _pillar('rvol', 'fetch-failed', null, threshold, { reason: 'volume fetch failed (rate-limited or network error) — not confirmed absent, could not be measured this scan' });
  }
  if (!rvolInput || rvolInput.avgDailyVolume == null || rvolInput.todayVolume == null) {
    return _pillar('rvol', 'not-checked', null, threshold, { reason: 'no volume data' });
  }
  const expectedByNow = rvolInput.avgDailyVolume * intradayCurve(elapsedMinutes);
  if (!(expectedByNow > 0)) {
    return _pillar('rvol', 'not-checked', null, threshold, { reason: 'no expected-volume baseline' });
  }
  const rvol = rvolInput.todayVolume / expectedByNow;
  const pass = rvol >= RVOL_MIN;
  // "Display the basis on the card" (spec) — expectedByNow/todayVolume
  // carried alongside the pillar so an implausible RVOL is diagnosable.
  return _pillar('rvol', pass ? 'pass' : 'fail', rvol, threshold, {
    expectedByNow,
    todayVolume: rvolInput.todayVolume,
  });
}

// Pillar 3, pre-market variant (2026-09-04, found live): a DISTINCT
// metric from Pillar 3's regular-session RVOL, never sharing its id or
// its threshold. Pre-market cumulative volume against a pre-market-
// specific 30-day baseline (core/universe.js's _getPreMarketVolumeHistory
// -- dividing pre-market volume by the regular-session RVOL's full-day
// average would be a ratio of two different things, the same error class
// this session has already caught three times).
//
// DELIBERATELY ALWAYS 'not-checked' as a STATUS, even when a real ratio
// is computed: this session has zero evidence for where a pre-market
// RVOL cutoff belongs (RVOL_MIN=5.0 is validated only for the regular-
// session INTRADAY_CURVE denominator; nothing supports reusing it here,
// and picking any other number would be the identical mistake with a
// different value). Gating on a fabricated threshold would display an
// invented number with the authority of a measured one -- exactly what
// this whole gate-honesty pass exists to stop doing. The real ratio is
// still surfaced via `value` (not-checked doesn't mean hidden, same as
// float's own not-checked-but-displayed shape) and captured into
// state.warriorPreMarketRvolObservations by the caller for a REAL,
// data-derived threshold later -- see index.js's rendering and
// evaluateGateBatch below for where that capture happens.
function evaluatePillarPreMarketRvol(candidate, session, preMarketRvolInput) {
  const threshold = 'unvalidated — no session-appropriate cutoff measured yet';
  if (session !== 'PRE') {
    return _pillar('rvol-premarket', 'not-checked', null, threshold, { reason: 'only computed pre-market' });
  }
  if (preMarketRvolInput && preMarketRvolInput.fetchFailed) {
    return _pillar('rvol-premarket', 'not-checked', null, threshold, { reason: 'volume fetch failed (rate-limited or network error) — not confirmed absent' });
  }
  if (!preMarketRvolInput || preMarketRvolInput.avgPreMarketVolume == null || preMarketRvolInput.todayPreMarketVolume == null) {
    return _pillar('rvol-premarket', 'not-checked', null, threshold, { reason: 'no pre-market volume data' });
  }
  if (!(preMarketRvolInput.avgPreMarketVolume > 0)) {
    return _pillar('rvol-premarket', 'not-checked', null, threshold, { reason: 'no pre-market baseline (thin/quiet history)' });
  }
  const ratio = preMarketRvolInput.todayPreMarketVolume / preMarketRvolInput.avgPreMarketVolume;
  return _pillar('rvol-premarket', 'not-checked', ratio, threshold, {
    todayPreMarketVolume: preMarketRvolInput.todayPreMarketVolume,
    avgPreMarketVolume: preMarketRvolInput.avgPreMarketVolume,
    daysInAverage: preMarketRvolInput.daysInAverage,
    reason: `measured, unvalidated threshold (${preMarketRvolInput.daysInAverage}-day pre-market average)`,
  });
}

// Gate window (24h) is deliberately narrower than the fetch window (72h,
// Bug 4's weekend-catalyst widening) — filtering by article age explicitly
// here, never inheriting the fetch window as the pass criterion. A
// Friday-evening headline must not read as a fresh Monday-afternoon
// catalyst just because it's present in the wider-windowed fetch.
//
// newsFetchFailed (2026-09-04, gate-honesty pass): this candidate's news
// batch request failed outright (core/news.js's state.newsFailedSymbols) —
// checked FIRST, ahead of the real "genuinely zero recent articles" fail
// path below. Before this fix, a total news-fetch failure silently
// returned newsItemsForSymbol=[] for every candidate, which this function
// scored as a real, confirmed 'fail' — the worst version of this whole
// defect class, since 'fail' actively counts against qualification instead
// of just being invisible the way a missing not-checked would be.
function evaluatePillar4(candidate, newsItemsForSymbol, now, newsFetchFailed) {
  if (newsFetchFailed) {
    return _pillar('news', 'fetch-failed', null, `<${NEWS_MAX_AGE_HOURS}h`, { reason: 'news fetch failed (rate-limited or network error) — not confirmed absent, could not be measured this scan' });
  }
  const items = newsItemsForSymbol || [];
  const cutoffMs = now.getTime() - NEWS_MAX_AGE_HOURS * 3600 * 1000;
  const recent = items
    .filter(n => { const t = new Date(n.created_at).getTime(); return !isNaN(t) && t >= cutoffMs; })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const pass = recent.length > 0;
  const value = pass
    ? recent[0].headline
    : (items.length ? `${items.length} article(s) present, none under ${NEWS_MAX_AGE_HOURS}h` : null);
  return _pillar('news', pass ? 'pass' : 'fail', value, `<${NEWS_MAX_AGE_HOURS}h`);
}

// Pillar 5 (float), Phase 6 (2026-09-04): real now, via core/edgar.js
// (spec originally wrote this against FMP; FMP 402s on exactly this
// gate's microcap population -- confirmed live during the backtest --
// SEC EDGAR is the substitute, see core/edgar.js's header).
//
// REVISED 2026-09-03: gates on EntityPublicFloat-implied float shares, not
// shares outstanding -- shares outstanding was the WRONG QUANTITY (total
// shares, not free-tradable float; confirmed live via DAIC, where the two
// differed by an order of magnitude). core/edgar.js derives the implied
// share count by dividing EntityPublicFloat's dollar value by the
// historical close on ITS OWN reference date (never today's price -- see
// that file's header). A measured dispersion check (n=204 backtest
// symbols, scripts/measure-float-ratio-dispersion.mjs) ruled out a
// calibrated shares-outstanding fallback for symbols with no
// EntityPublicFloat filing -- those read not-checked, same as before
// Phase 6 existed, no fallback attempted (Option E, not Option C/D: a slot
// that sometimes means dollars-derived shares and sometimes raw shares
// outstanding is exactly the ambiguity pre-market RVOL was built to avoid).
//
// FLOAT_THRESHOLD_DEFAULT_SHARES=10,000,000 is the spec's own stated
// default (docs/warrior-engine-spec-v2.md Phase 6: "Float threshold —
// numeric, default 10,000,000"), not invented here -- and per that same
// section ("Ross's <10M is his ideal, not a wall"), configurable via
// Settings rather than hardcoded; evaluateGateBatch reads the real
// configured value and passes it in.
//
// fetchFailed -> BLOCKS qualification, same fetch-failed/not-checked
// split as RVOL/news (see classifyGate's own comment on that decision).
// Covers both "EDGAR request failed" and "we found a real EntityPublicFloat
// filing but couldn't complete the historical-price half of the
// derivation" -- both are "we found real data but couldn't finish
// measuring it this scan," not a structural absence.
// NOTE, disclosed rather than silently resolved: this diverges from the
// spec's older FMP-era language ("qualified candidates fall back to 4/5
// near-miss rather than disappearing" on daily-quota exhaustion) -- that
// text predates this session's gate-honesty pass and was written for a
// DIFFERENT failure mode (a daily call-count ceiling, which EDGAR has no
// direct analog to; its own constraint is request pacing, not a quota).
// A near-miss reads as "we checked, it's close" -- a fetch failure isn't
// that, and treating it as one would reintroduce exactly the missing-
// data-wearing-a-real-answer's-costume problem this whole pass exists to
// close. Flagged here rather than silently picked either way.
// Volume-consistency backstop (2026-09-04) — found live in a boot check:
// BIAF (implied float 174,868 shares) and GRI (41,528) both PASSED the
// <10M gate despite same-session volume 80x-263x their implied float, a
// physically implausible turnover no real trading day produces (Ross's
// own method targets extreme float-rotation days, but even those rarely
// exceed low-single-digit multiples in a single session). The invariant
// guard (impliedFloatShares <= sharesOutstanding) is ONE-SIDED — it can
// only catch an OVER-estimate; an implausibly SMALL float (exactly what
// makes a candidate qualify) sails through it cleanly, since a tiny
// number is trivially less than shares outstanding too. Both BIAF and GRI
// were also beyond the 180-day staleness bound added the same day (see
// core/float-table.js), which independently would have caught them — this
// is a backstop for values INSIDE that bound that are stale beyond
// usefulness for some other reason (undisclosed dilution, a split the
// filing doesn't yet reflect) staleness-by-filing-date alone can't detect.
//
// The 10x cutoff is DATA-DERIVED, not assumed: measured (recent daily
// volume ÷ implied float) across all 3,032 usable entries in the live
// float table (2026-09-04) — p50=0.013, p75=0.027, p90=0.076, p95=0.30,
// p97≈1.0 (a full float rotation in a day — rare but real for genuine
// extreme momentum), p99=11.3, p99.5=28.1, only 1.1% of the whole
// population exceeds 10x. GRI's own live ratio (~10.5x) sits almost
// exactly at that p99 mark; BIAF's (80x-263x depending on the day) sits
// far past it. 10x lands right at the natural break between "extreme but
// plausible" and "almost certainly a stale denominator."
const VOLUME_TO_FLOAT_MULTIPLE_MAX = 10;

function evaluatePillarFloat(floatInput, thresholdShares, todayVolume) {
  const threshold = `<${thresholdShares.toLocaleString()}`;
  if (floatInput && floatInput.fetchFailed) {
    return _pillar('float', 'fetch-failed', null, threshold, { reason: 'float fetch failed (SEC EDGAR rate-limited, network error, or the historical-price half of the derivation could not be completed) — not confirmed absent, could not be measured this scan' });
  }
  if (!floatInput || floatInput.impliedFloatShares == null) {
    // invalidReason (2026-09-03): set when core/edgar.js's own invariant
    // guard caught a derivation whose implied float exceeded shares
    // outstanding -- a specific, real reason, shown in place of the
    // generic "no filing" one below which would otherwise misrepresent a
    // found-but-invalid filing as a structural absence.
    return _pillar('float', 'not-checked', null, threshold, { reason: (floatInput && floatInput.invalidReason) || 'no EntityPublicFloat filing available for this symbol' });
  }
  if (todayVolume != null && floatInput.impliedFloatShares > 0) {
    const volumeMultiple = todayVolume / floatInput.impliedFloatShares;
    if (volumeMultiple > VOLUME_TO_FLOAT_MULTIPLE_MAX) {
      return _pillar('float', 'not-checked', null, threshold, {
        reason: `today's volume (${Math.round(todayVolume).toLocaleString()}) is ${volumeMultiple.toFixed(1)}x the implied float (${Math.round(floatInput.impliedFloatShares).toLocaleString()}) — beyond what real trading can plausibly explain (${VOLUME_TO_FLOAT_MULTIPLE_MAX}x, data-derived), the estimate is likely stale regardless of its filing date`,
      });
    }
  }
  const pass = floatInput.impliedFloatShares < thresholdShares;
  return _pillar('float', pass ? 'pass' : 'fail', floatInput.impliedFloatShares, threshold, {
    asOfDate: floatInput.referenceDate,
    stalenessDays: floatInput.stalenessDays,
    dilutionCorrected: floatInput.dilutionCorrected,
  });
}

function _groupNewsBySymbol(newsItems) {
  const bySymbol = {};
  for (const item of newsItems) {
    for (const sym of item.symbols || []) {
      (bySymbol[sym] = bySymbol[sym] || []).push(item);
    }
  }
  return bySymbol;
}

// elapsedMinutes since regular-session open (6:30am PT / tMin 390 in
// core/clock.js's own minute-of-day convention) — only meaningful during
// session==='OPEN'; pillar 3 checks session itself before using this.
function _elapsedSessionMinutes() {
  const pt = getPT();
  const tMin = pt.getHours() * 60 + pt.getMinutes();
  return tMin - 390;
}

// QUALIFIED / NEAR MISS are defined directly in terms of the gate's own
// two-stage structure, not a generic "count fails across all 5 pillars"
// rule — a plain fail-count turned out to have a second vacuous case
// beyond the one the short-circuit-location fix addresses.
//
// Stage 1 (price, change): both are free and both are always evaluated for
// real, independently of each other — pillar2 is never skipped just
// because pillar1 failed. That means a candidate failing price alone,
// with change happening to pass, still has "exactly one checkable pillar
// fails" trivially true under a plain fail-count, the same vacuous shape
// as the original bug — just shifted from "RVOL fails, news skipped" to
// "price fails, change happens to pass." Per the spec: failing EITHER
// free pillar is a plain disqualification, full stop — never NEAR_MISS,
// regardless of the other one's outcome. So stage 1 is a gate, not a vote:
// both must pass before stage 2 is even considered.
//
// Stage 2 (rvol, news): evaluated together, never one short-circuiting the
// other (see evaluateGate) — this is the fix for the original bug.
// Structurally not-checked entries (pre-market RVOL, first-15-min RVOL)
// are excluded from the count, same "not-checked is never treated as a
// pass or counted against a candidate" rule as float. QUALIFIED requires
// every stage-2 pillar that WAS checkable to pass; NEAR_MISS requires
// exactly one of them to fail.
//
// This deliberately does NOT downgrade a candidate just because RVOL
// (the most selective pillar) wasn't checkable this scan — that's still
// correct per the not-checked rule above. What it doesn't do on its own
// is communicate that a "QUALIFIED" outside regular session only cleared
// price+change+news. That's a display concern, not a classification one
// — engines/warrior/index.js's renderTab reads evaluateGateBatch's
// rvolCheckable flag and puts the caveat on the section header, one level
// up from where the per-pillar not-checked labels already do this.
//
// BLOCKED (2026-09-04, gate-honesty pass, settled decision): a
// fetch-failed pillar is NOT the same as not-checked and must not share
// its "never counts against a candidate" treatment. not-checked means a
// structural reason the check doesn't apply (float unbuilt, pre-market
// RVOL) — the app made a deliberate choice not to look. fetch-failed means
// the app TRIED to measure and the request failed — we simply don't know
// the answer. A stock we couldn't measure is not a stock that passed, so
// any fetch-failed pillar blocks qualification outright, checked BEFORE
// the substantive-pillar counting logic — never QUALIFIED, never
// NEAR_MISS (near-miss implies a real, informative near-threshold result,
// which a fetch failure isn't), always 'BLOCKED'. Distinct from plain
// disqualification (null) so the card can say "couldn't verify," not
// "failed the gate" — those mean different things to someone about to
// trade on it.
function classifyGate(gateResult) {
  const byId = {};
  gateResult.pillars.forEach(p => { byId[p.id] = p; });

  const freePillarsPass = byId.price.status === 'pass' && byId.change.status === 'pass';
  if (!freePillarsPass) return null; // plain disqualification — see header comment; never NEAR_MISS no matter which one failed

  // float joins rvol/news here as of Phase 6 (2026-09-04) -- see
  // evaluatePillarFloat's own comment for why a fetch failure blocks the
  // same way, diverging from the older FMP-era spec text.
  const anyFetchFailed = [byId.rvol, byId.news, byId.float].some(p => p.status === 'fetch-failed');
  if (anyFetchFailed) return 'BLOCKED';

  const substantive = [byId.rvol, byId.news, byId.float].filter(p => p.status !== 'not-checked');
  const substantiveFailed = substantive.filter(p => p.status === 'fail');
  if (substantiveFailed.length === 0 && substantive.length > 0) return 'QUALIFIED';
  if (substantiveFailed.length === 1) return 'NEAR_MISS';
  return null;
}

// Evaluates the gate for one candidate, given already-batch-fetched
// rvol/news inputs (never fetched per-candidate — see evaluateGateBatch).
// Short-circuit is scoped to price/change ONLY — the two free pillars, at
// zero request cost, where failing either is a plain disqualification.
// Anything clearing both gets Pillar 3 AND Pillar 4 evaluated
// unconditionally, regardless of whether Pillar 3 passed — see
// classifyGate's comment for why halting between them broke the near-miss
// tier's whole purpose.
function evaluateGate(candidate, { session, elapsedMinutes, rvolInput, preMarketRvolInput, newsItemsForSymbol, newsFetchFailed, floatInput, floatThresholdShares, now }) {
  const pillar1 = evaluatePillar1(candidate);
  const pillar2 = evaluatePillar2(candidate);
  const skip = (id, threshold) => _pillar(id, 'not-checked', null, threshold, { reason: 'gate short-circuited (price/change failed)' });

  const clearedFreePillars = pillar1.status === 'pass' && pillar2.status === 'pass';
  const pillar3 = clearedFreePillars
    ? evaluatePillar3(candidate, session, elapsedMinutes, rvolInput)
    : skip('rvol', `≥${RVOL_MIN}×`);
  // Pre-market RVOL: same short-circuit as pillar3/pillar4 -- the fetch
  // itself is scoped to pillar12Survivors (evaluateGateBatch below), so a
  // candidate that never cleared price/change never has real
  // preMarketRvolInput to show; skip() here reports that honestly as
  // "gate short-circuited," not as a failed measurement.
  const pillarPreMarketRvol = clearedFreePillars
    ? evaluatePillarPreMarketRvol(candidate, session, preMarketRvolInput)
    : skip('rvol-premarket', 'unvalidated — no session-appropriate cutoff measured yet');
  const pillar4 = clearedFreePillars
    ? evaluatePillar4(candidate, newsItemsForSymbol, now, newsFetchFailed)
    : skip('news', `<${NEWS_MAX_AGE_HOURS}h`);
  // Float ("apply last" per spec): same clearedFreePillars gate as rvol/
  // news, NOT further narrowed to "only if rvol+news both already
  // passed." A stricter reading of "apply last" (skip whenever the
  // candidate is already doomed by 2 other fails) was considered and
  // rejected -- it would reintroduce exactly the short-circuit-between-
  // stage-2-pillars bug classifyGate's own comment documents fixing
  // (NEAR_MISS/disqualified cards showing an incomplete picture). The
  // spec's ORIGINAL cost pressure for "apply last" was FMP's 250/day
  // quota; EDGAR has no daily cap (just pacing) and this call is cached
  // 14 days, so the cost case for a stricter skip is much weaker here
  // than it was written against.
  const pillarFloat = clearedFreePillars
    ? evaluatePillarFloat(floatInput, floatThresholdShares ?? FLOAT_THRESHOLD_DEFAULT_SHARES, rvolInput && rvolInput.todayVolume)
    : skip('float', `<${(floatThresholdShares ?? FLOAT_THRESHOLD_DEFAULT_SHARES).toLocaleString()}`);

  const gateResult = {
    symbol: candidate.symbol,
    pillars: [pillar1, pillar2, pillar3, pillarPreMarketRvol, pillar4, pillarFloat],
    haltStatus: 'unknown', // deferred — see spec's "Halt check" section
    dataTimestamp: now.toISOString(),
    // app.js's VERSION const, as an ordinary cross-script global (same
    // pattern this file already uses for getPT/getFloatDataForSymbols —
    // see this file's header). Stamped onto every gate result so it's
    // already present in whatever eventually becomes Phase 7's signal
    // snapshot, rather than needing to be wired in retroactively — the
    // forward test's value depends on knowing which build produced which
    // morning's candidates (2026-09-03, non-negotiable before forward-
    // testing starts). Defensive fallback for harnesses (tests, offline
    // scripts) that never define VERSION at all.
    buildVersion: typeof VERSION !== 'undefined' ? VERSION : null,
  };
  gateResult.tier = classifyGate(gateResult);
  gateResult.passed = gateResult.tier === 'QUALIFIED';
  return gateResult;
}

// Batch orchestration: filters by the free pillars first (no request
// spent), then fetches BOTH RVOL and news for that same survivor set, in
// batches — never per-candidate loops, and never narrowing the news batch
// by Pillar 3's outcome (that's what made near-miss cards incomplete
// before — see classifyGate's comment). Returns { results, requests } so
// callers (and diagnoseGateCost) can report real cost, same visibility
// principle as every other diagnostic this session.
async function evaluateGateBatch(candidates, session) {
  const now = new Date();
  const elapsedMinutes = _elapsedSessionMinutes();
  let requests = 0;

  const pillar12Survivors = candidates.filter(c => {
    const p1 = evaluatePillar1(c);
    const p2 = evaluatePillar2(c);
    return p1.status === 'pass' && p2.status === 'pass';
  });

  // Single source of truth for "could RVOL even be evaluated this scan" —
  // the same structural gate evaluatePillar3 checks per-candidate (session
  // + elapsed-since-open), computed once here so the render layer can flag
  // when QUALIFIED/NEAR MISS only reflect price+change+news, not because
  // RVOL — the most selective pillar — was actually checked and passed.
  // Deliberately does NOT account for the rarer per-candidate data-gap
  // reasons inside evaluatePillar3 ("no volume data" / "no expected-volume
  // baseline") — those vary by symbol and don't change what's honest to
  // claim about the scan as a whole.
  const rvolCheckable = session === 'OPEN' && elapsedMinutes >= RVOL_NOT_YET_AVAILABLE_MIN;

  let rvolInputBySymbol = {};
  if (pillar12Survivors.length && rvolCheckable) {
    const symbols = pillar12Survivors.map(c => c.symbol);
    // getPT()'s Date object is only safe for reading back hour/minute
    // (core/clock.js's established pattern) — its own .getTime() is NOT a
    // real UTC instant, so constructing "6:30am PT" via .setHours() on any
    // Date would be wrong on a machine not already set to Pacific time.
    // Sidesteps that entirely: elapsedMinutes already correctly measures
    // minutes-since-open via getPT()'s hour/minute accessors, so
    // subtracting that from the real `now` timestamp gives the true UTC
    // instant of today's open — pure relative arithmetic, no absolute PT
    // timestamp construction needed.
    const sessionOpen = new Date(now.getTime() - elapsedMinutes * 60 * 1000);
    const end = new Date(now.getTime() - 16 * 60 * 1000); // PREMARKET_BAR_DELAY_MIN equivalent for the regular session

    const [
      { volumeBySymbol, requests: volReq, failedSymbols: volFailedSymbols },
      { avgVolumes, requests: avgReq, failedSymbols: avgFailedSymbols },
    ] = await Promise.all([
      _fetchCumulativeMinuteVolume(symbols, sessionOpen, end),
      _getSip30DayAvgVolume(symbols),
    ]);
    requests += volReq + avgReq;
    // A symbol failing EITHER fetch (today's cumulative volume or the
    // 30-day average) means RVOL can't be computed for it — either half
    // missing makes the ratio meaningless, not just one side of it.
    const rvolFetchFailedSymbols = new Set([...(volFailedSymbols || []), ...(avgFailedSymbols || [])]);
    for (const sym of symbols) {
      rvolInputBySymbol[sym] = {
        todayVolume: volumeBySymbol[sym],
        avgDailyVolume: avgVolumes[sym],
        fetchFailed: rvolFetchFailedSymbols.has(sym),
      };
    }
  }

  // Pre-market RVOL (2026-09-04, found live): informational only, never
  // gates (see evaluatePillarPreMarketRvol) -- fetched only during PRE,
  // only for pillar12Survivors, same cost-scoping the regular-session
  // RVOL fetch above already uses. 16 hardcoded (not referencing
  // core/universe.js's PREMARKET_BAR_DELAY_MIN) for the same module-
  // boundary reason the regular-session fetch's own `end` line above
  // does: gate.js is a real ES module, universe.js's `const` doesn't
  // cross that boundary as a bare global the way its functions do.
  let preMarketRvolInputBySymbol = {};
  if (pillar12Survivors.length && session === 'PRE') {
    const symbols = pillar12Survivors.map(c => c.symbol);
    const todayStr = ptDateStr(getPT(now));
    const preMarketStart = ptWallClockToInstant(todayStr, 1, 0); // 4:00am ET
    const preMarketEnd = new Date(now.getTime() - 16 * 60 * 1000); // PREMARKET_BAR_DELAY_MIN equivalent

    const [
      { volumeBySymbol: pmVolumeBySymbol, requests: pmVolReq, failedSymbols: pmVolFailedSymbols },
      { avgVolumes: pmAvgVolumes, historyBySymbol: pmHistoryBySymbol, requests: pmAvgReq, failedSymbols: pmAvgFailedSymbols },
    ] = await Promise.all([
      _fetchCumulativeMinuteVolume(symbols, preMarketStart, preMarketEnd),
      _getPreMarketVolumeHistory(symbols),
    ]);
    requests += pmVolReq + pmAvgReq;
    const pmFetchFailedSymbols = new Set([...(pmVolFailedSymbols || []), ...(pmAvgFailedSymbols || [])]);
    for (const sym of symbols) {
      preMarketRvolInputBySymbol[sym] = {
        todayPreMarketVolume: pmVolumeBySymbol[sym],
        avgPreMarketVolume: pmAvgVolumes[sym],
        daysInAverage: (pmHistoryBySymbol[sym] || []).length,
        fetchFailed: pmFetchFailedSymbols.has(sym),
      };
    }

    // Distribution capture (explicit ask, 2026-09-04): same "capture the
    // distribution, set the threshold from data later" discipline the
    // backtest's own onRawDistribution used -- RVOL_MIN=5.0 has zero
    // evidence behind it for THIS metric, so the only honest path to a
    // real cutoff is accumulating real observations first. One entry per
    // candidate per scan (not deduped across a morning's repeated
    // refreshes -- a symbol that stays a candidate longer gets captured
    // more often; left for whoever eventually analyzes this to handle,
    // not solved here), real ratios only (never fetch failures or
    // thin/absent baselines masquerading as a zero).
    const obs = state.warriorPreMarketRvolObservations || [];
    for (const sym of symbols) {
      const input = preMarketRvolInputBySymbol[sym];
      if (input.fetchFailed || input.avgPreMarketVolume == null || input.todayPreMarketVolume == null || !(input.avgPreMarketVolume > 0)) continue;
      obs.push({
        capturedAt: now.toISOString(),
        date: todayStr,
        symbol: sym,
        ratio: input.todayPreMarketVolume / input.avgPreMarketVolume,
        todayPreMarketVolume: input.todayPreMarketVolume,
        avgPreMarketVolume: input.avgPreMarketVolume,
        daysInAverage: input.daysInAverage,
      });
    }
    state.warriorPreMarketRvolObservations = _trimPreMarketRvolObservations(obs, now);
    persist('warriorPreMarketRvolObservations');
  }

  // News is batched for the SAME survivor set as RVOL (pillar12Survivors),
  // not a narrower set filtered by Pillar 3's outcome — Pillar 3 no longer
  // gates Pillar 4 (see evaluateGate/classifyGate's comments). Could run
  // concurrently with the RVOL fetch above rather than after it, but
  // keeping it sequential here costs nothing extra in requests and keeps
  // this function easier to read; revisit if wall-clock on a real scan
  // shows it matters.
  let newsBySymbol = {};
  let newsFailedSymbolSet = new Set();
  if (pillar12Survivors.length) {
    const symbols = pillar12Survivors.map(c => c.symbol);
    const newsItems = await fetchNewsForTickers(symbols);
    requests += Math.ceil(symbols.length / 10); // fetchNewsForTickers's own NEWS_CHUNK_SIZE; exact count also visible via state.newsTruncatedSymbols if pagination capped
    newsBySymbol = _groupNewsBySymbol(newsItems);
    // state.newsFailedSymbols (core/news.js, 2026-09-04): symbols whose
    // news BATCH request failed outright — read right after the call,
    // same pattern as newsTruncatedSymbols already used elsewhere, so a
    // later concurrent scan's own fetch can't overwrite this one's
    // reading of the flag before it's consumed.
    newsFailedSymbolSet = new Set(state.newsFailedSymbols || []);
  }

  // Float (revised 2026-09-04): same pillar12Survivors scoping as rvol/
  // news -- "apply last" per spec, but not narrowed further; see
  // evaluateGate's own comment for why. getFloatDataForSymbols now
  // resolves to core/float-table.js's static-table lookup in the browser
  // (core/edgar.js's live EDGAR fetch is CORS-blocked, confirmed live —
  // see that file's header), fetched once per page load, so a repeat
  // candidate across mornings costs zero additional requests same as
  // before, just for a different reason (page-lifetime cache, not a
  // 14-day one).
  let floatInputBySymbol = {};
  let floatTableBuiltAt = null;
  let floatTableStalenessDays = null;
  if (pillar12Survivors.length) {
    const symbols = pillar12Survivors.map(c => c.symbol);
    const { floatBySymbol, requests: floatReq, failedSymbols: floatFailedSymbols, tableBuiltAt, tableStalenessDays } = await getFloatDataForSymbols(symbols);
    requests += floatReq;
    floatTableBuiltAt = tableBuiltAt ?? null;
    floatTableStalenessDays = tableStalenessDays ?? null;
    const floatFailedSymbolSet = new Set(floatFailedSymbols || []);
    for (const sym of symbols) {
      const entry = floatBySymbol[sym];
      floatInputBySymbol[sym] = {
        impliedFloatShares: entry ? entry.impliedFloatShares : null,
        referenceDate: entry ? entry.referenceDate : null,
        stalenessDays: entry ? entry.stalenessDays : null,
        invalidReason: entry ? entry.invalidReason : null,
        fetchFailed: floatFailedSymbolSet.has(sym),
      };
    }
  }
  // Configurable per spec ("not a boolean... make the threshold
  // configurable"), never hardcoded past the documented default.
  const floatThresholdShares = (typeof state.settings?.floatThresholdShares === 'number' && state.settings.floatThresholdShares > 0)
    ? state.settings.floatThresholdShares
    : FLOAT_THRESHOLD_DEFAULT_SHARES;

  const results = candidates.map(c => evaluateGate(c, {
    session,
    elapsedMinutes,
    rvolInput: rvolInputBySymbol[c.symbol],
    preMarketRvolInput: preMarketRvolInputBySymbol[c.symbol],
    newsItemsForSymbol: newsBySymbol[c.symbol],
    newsFetchFailed: newsFailedSymbolSet.has(c.symbol),
    floatInput: floatInputBySymbol[c.symbol],
    floatThresholdShares,
    now,
  }));

  return { results, requests, rvolCheckable, floatTableBuiltAt, floatTableStalenessDays };
}

// 'premarket-gap' is the only strategy meaningful before the open —
// 'movers' returns stale prior-day data pre-market (core/universe.js's own
// warning on _getMoversUniverse). Everything else (OPEN, AH, CLOSED) uses
// 'movers'; 'full-filtered' isn't implemented (throws) so isn't an option.
function _selectStrategy(session) {
  return session === 'PRE' ? 'premarket-gap' : 'movers';
}

// Mirrors core/universe.js's diagnosePremarketGap: per-stage request counts
// + wall-clock, not a single total — a combined number is exactly what let
// a real cost problem hide in this codebase before (see that function's
// own header comment). Lives here, not in core/universe.js, because it
// needs gate evaluation (Warrior-owned logic), not just data fetching.
async function diagnoseGateCost(session) {
  const t0 = Date.now();
  const universe = await getUniverse({ session, strategy: _selectStrategy(session) });
  const { results, requests: gateRequests, rvolCheckable } = await evaluateGateBatch(universe, session);
  const wallClockMs = Date.now() - t0;

  const qualified = results.filter(r => r.tier === 'QUALIFIED');
  const nearMiss = results.filter(r => r.tier === 'NEAR_MISS');

  return {
    session,
    universeCount: universe.length,
    qualifiedCount: qualified.length,
    nearMissCount: nearMiss.length,
    rvolCheckable,
    gateRequests,
    wallClockMs,
    sampleQualified: qualified.slice(0, 5),
    sampleNearMiss: nearMiss.slice(0, 5),
  };
}

export {
  PRICE_MIN, PRICE_MAX, CHANGE_MIN_PCT, RVOL_MIN, NEWS_MAX_AGE_HOURS, RVOL_NOT_YET_AVAILABLE_MIN, FLOAT_THRESHOLD_DEFAULT_SHARES,
  INTRADAY_CURVE, intradayCurve,
  evaluatePillar1, evaluatePillar2, evaluatePillar3, evaluatePillarPreMarketRvol, evaluatePillar4, evaluatePillarFloat,
  classifyGate, evaluateGate, evaluateGateBatch,
  _selectStrategy, diagnoseGateCost, _trimPreMarketRvolObservations,
};
