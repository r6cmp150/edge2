// engines/warrior/gate.js — Phase 3, the 5 Pillars gate.
// docs/warrior-engine-spec-v2.md Phase 3.
//
// ES module, statically imported by engines/warrior/index.js (fine —
// Warrior's own files importing each other doesn't cross the shell/core/
// EDGE boundary CLAUDE.md protects; that boundary is about core/shell/EDGE
// never reaching INTO Warrior, and Warrior never reaching into EDGE). This
// file references core/universe.js's exported fetchers, core/news.js's
// fetchNewsForTickers, and core/clock.js's getPT/getMarketStatus as
// ordinary globals — same as engines/warrior/index.js already does for
// state/registerEngine. See that file's header for why that's expected,
// not a boundary leak: the rule is one-directional.
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

// Pillar 5 (float): Phase 6 (FMP), not built here. Never stubbed as
// passing — a fabricated check on unverified data is the $0.00 P&L failure
// again. Always 'not-checked' in Phase 3; same shape survives Phase 6
// landing without a signalSnapshot migration.
function evaluatePillarFloat() {
  return _pillar('float', 'not-checked', null, '<10,000,000', { reason: 'not checked until Phase 6' });
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

  const anyFetchFailed = [byId.rvol, byId.news].some(p => p.status === 'fetch-failed');
  if (anyFetchFailed) return 'BLOCKED';

  const substantive = [byId.rvol, byId.news].filter(p => p.status !== 'not-checked');
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
function evaluateGate(candidate, { session, elapsedMinutes, rvolInput, preMarketRvolInput, newsItemsForSymbol, newsFetchFailed, now }) {
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

  const pillarFloat = evaluatePillarFloat();

  const gateResult = {
    symbol: candidate.symbol,
    pillars: [pillar1, pillar2, pillar3, pillarPreMarketRvol, pillar4, pillarFloat],
    haltStatus: 'unknown', // deferred — see spec's "Halt check" section
    dataTimestamp: now.toISOString(),
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
    state.warriorPreMarketRvolObservations = obs;
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

  const results = candidates.map(c => evaluateGate(c, {
    session,
    elapsedMinutes,
    rvolInput: rvolInputBySymbol[c.symbol],
    preMarketRvolInput: preMarketRvolInputBySymbol[c.symbol],
    newsItemsForSymbol: newsBySymbol[c.symbol],
    newsFetchFailed: newsFailedSymbolSet.has(c.symbol),
    now,
  }));

  return { results, requests, rvolCheckable };
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
  PRICE_MIN, PRICE_MAX, CHANGE_MIN_PCT, RVOL_MIN, NEWS_MAX_AGE_HOURS, RVOL_NOT_YET_AVAILABLE_MIN,
  INTRADAY_CURVE, intradayCurve,
  evaluatePillar1, evaluatePillar2, evaluatePillar3, evaluatePillarPreMarketRvol, evaluatePillar4, evaluatePillarFloat,
  classifyGate, evaluateGate, evaluateGateBatch,
  _selectStrategy, diagnoseGateCost,
};
