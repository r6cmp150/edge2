// tests/edgar.test.js — core/edgar.js, Phase 6 (float, completing Pillar
// 5). No key/auth, so no client-injection story to test the way
// core/universe.js's fetchers have (Alpaca engine-tagging) — this file
// covers what's actually specific to EDGAR: CIK-map caching, the
// per-symbol 14-day cache, the nearest-preceding-filing staleness match,
// the historical-adjusted-close derivation (revised 2026-09-03, corrected
// AGAIN same day: EntityPublicFloat ÷ SPLIT-ADJUSTED close on its own
// reference date — raw was a units error, see core/edgar.js's header),
// the shares-outstanding invariant guard, and the
// unmapped/no-filing/fetch-failed distinction classifyGate depends on.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

function loadEdgar(fetchMock, historicalBarsMock, stateOverrides) {
  global.state = { warriorEdgarCikMapCache: null, warriorFloatCache: null, ...stateOverrides };
  global.persist = () => {};
  global.getPT = () => new Date('2026-09-04T13:00:00Z');
  global.ptDateStr = () => '2026-09-04';
  global.fetch = fetchMock;
  global._fetchHistoricalDailyBars = historicalBarsMock || (async () => ({ barsBySymbol: {}, requests: 0 }));
  global._coreClient = {};
  const src = readSource('core/edgar.js');
  const exposeCode = 'global.__getFloatDataForSymbols = getFloatDataForSymbols;';
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeCode);
  return { getFloatDataForSymbols: global.__getFloatDataForSymbols };
}

function cikMapResponse(entries) {
  const obj = {};
  entries.forEach((e, i) => { obj[i] = { ticker: e.ticker, cik_str: e.cik }; });
  return { ok: true, status: 200, json: async () => obj };
}

function conceptResponse(unitKey, points) {
  return { ok: true, status: 200, json: async () => ({ units: { [unitKey]: points } }) };
}

function notFoundResponse() {
  return { ok: true, status: 404, json: async () => { throw new Error('should not be read on 404'); } };
}

// A historical-bars mock keyed by symbol -> [{t, c}] bars, ignoring the
// requested range (tests control what's "available" directly). Records
// the adjustment argument it was called with so tests can assert on it.
function barsMock(barsBySymbol, callLog) {
  return async (symbols, start, end, client, adjustment) => {
    if (callLog) callLog.push(adjustment);
    const out = {};
    for (const sym of symbols) if (barsBySymbol[sym]) out[sym] = barsBySymbol[sym];
    return { barsBySymbol: out, requests: 1 };
  };
}

// Same shape, but returns DIFFERENT bars depending on the adjustment
// argument -- needed to simulate a real split factor (adjusted close !=
// raw close) for the dilution-correction tests below.
function barsByAdjustmentMock({ all: allBars, raw: rawBars }) {
  return async (symbols, start, end, client, adjustment) => {
    const source = adjustment === 'raw' ? rawBars : allBars;
    const out = {};
    for (const sym of symbols) if (source[sym]) out[sym] = source[sym];
    return { barsBySymbol: out, requests: 1 };
  };
}

// Structured EDGAR mock: cikEntries [{ticker,cik}], floatPointsBySymbol and
// sharesPointsBySymbol keyed by ticker. Extracts the CIK from the request
// URL and reverse-maps it to a ticker via cikEntries (the same way the
// real endpoints are CIK-addressed, not ticker-addressed).
function edgarMock({ cikEntries = [], floatPointsBySymbol = {}, sharesPointsBySymbol = {}, floatResponseOverride, sharesResponseOverride } = {}) {
  const symByCik = {};
  for (const e of cikEntries) symByCik[String(e.cik).padStart(10, '0')] = e.ticker;
  return async (url) => {
    if (url.includes('company_tickers.json')) return cikMapResponse(cikEntries);
    const m = url.match(/CIK(\d{10})/);
    const sym = m ? symByCik[m[1]] : null;
    if (url.includes('EntityPublicFloat')) {
      if (floatResponseOverride) return floatResponseOverride(sym);
      const points = floatPointsBySymbol[sym];
      return points ? conceptResponse('USD', points) : notFoundResponse();
    }
    if (url.includes('EntityCommonStockSharesOutstanding')) {
      if (sharesResponseOverride) return sharesResponseOverride(sym);
      const points = sharesPointsBySymbol[sym];
      return points ? conceptResponse('shares', points) : notFoundResponse();
    }
    throw new Error(`edgarMock: unexpected URL ${url}`);
  };
}

async function testFetchesCikMapOnceThenCachesFor24h() {
  let cikMapCalls = 0;
  const base = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2026-03-10', filed: '2026-03-11', val: 7_171_964 }] },
  });
  const mock = async (url, opts) => {
    if (url.includes('company_tickers.json')) { cikMapCalls++; assert.ok(opts.headers['User-Agent'] && opts.headers['User-Agent'].length > 0, 'SEC fair-use requires a descriptive User-Agent'); }
    return base(url, opts);
  };
  const bars = barsMock({ A: [{ t: '2026-03-10T00:00:00Z', c: 2.50 }] });
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  await getFloatDataForSymbols(['A']);
  await getFloatDataForSymbols(['A']); // same symbol, same call -- should be a per-symbol cache hit, not re-fetch the CIK map either
  console.log('CIK map fetch count across two calls:', cikMapCalls);
  assert.strictEqual(cikMapCalls, 1, 'the CIK map must be fetched once and reused, not once per getFloatDataForSymbols call');
}

async function testImpliedFloatSharesDerivedFromAdjustedReferenceDateClose() {
  const mock = edgarMock({
    cikEntries: [{ ticker: 'DAIC', cik: 320193 }],
    floatPointsBySymbol: { DAIC: [{ end: '2026-03-10', filed: '2026-03-11', val: 7_171_964 }] },
    sharesPointsBySymbol: { DAIC: [{ filed: '2026-05-12', val: 30_259_579 }] },
  });
  // Adjusted close on the reference date is $6.135 (matches this session's
  // live DAIC measurement, where raw was $0.2454 -- a 25.0x gap from the
  // ~25:1 reverse split). 7,171,964 / 6.135 = 1,169,024 implied float
  // shares -- well under shares outstanding, so the guard doesn't fire.
  const bars = barsMock({ DAIC: [{ t: '2026-03-10T00:00:00Z', c: 6.135 }] });
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  const { floatBySymbol } = await getFloatDataForSymbols(['DAIC']);
  console.log('implied float shares:', floatBySymbol.DAIC);
  assert.ok(Math.abs(floatBySymbol.DAIC.impliedFloatShares - 1_169_023.6) < 1, 'must divide the dollar float by the ADJUSTED close on its OWN reference date');
  assert.strictEqual(floatBySymbol.DAIC.referenceDate, '2026-03-10');
  assert.strictEqual(floatBySymbol.DAIC.stalenessDays, 178, '2026-09-04 minus 2026-03-10');
}

async function testHistoricalBarsFetchedWithBothAdjustedAndRaw() {
  // Locks in the 2026-09-03 correction (adjusted, not raw, for the
  // PRIMARY derivation -- see core/edgar.js's header for the live DAIC
  // trace) AND the 2026-09-04 addition (raw is ALSO now fetched, to
  // compute the cumulative split factor R the dilution correction needs
  // -- see the BIAF/GRI tests below). Both must be requested; a
  // regression to only one or the other fails this test instead of
  // requiring the reasoning to be redone.
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2026-03-10', filed: '2026-03-11', val: 1_000_000 }] },
    sharesPointsBySymbol: { A: [{ filed: '2026-05-12', val: 10_000_000 }] },
  });
  const callLog = [];
  const bars = barsMock({ A: [{ t: '2026-03-10T00:00:00Z', c: 4.00 }] }, callLog);
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  await getFloatDataForSymbols(['A']);
  console.log('adjustment argument(s) passed to _fetchHistoricalDailyBars:', callLog);
  assert.deepStrictEqual(callLog.sort(), ['all', 'raw'], 'must request BOTH the adjusted close (primary derivation) and the raw close (split-factor R for the dilution correction)');
}

async function testUsesClosestPrecedingBarWithinThePad() {
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2026-03-10', filed: '2026-03-11', val: 1_000_000 }] },
    sharesPointsBySymbol: { A: [{ filed: '2026-05-12', val: 10_000_000 }] },
  });
  // Reference date itself has no bar (holiday) -- the nearest PRECEDING
  // trading day's close inside the pad must be used, never a later one.
  const bars = barsMock({ A: [
    { t: '2026-03-06T00:00:00Z', c: 5.00 },
    { t: '2026-03-09T00:00:00Z', c: 4.00 }, // closest preceding
    { t: '2026-03-12T00:00:00Z', c: 3.00 }, // AFTER the reference date -- must never be used
  ] });
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  const { floatBySymbol } = await getFloatDataForSymbols(['A']);
  assert.strictEqual(floatBySymbol.A.impliedFloatShares, 250_000, '1,000,000 / 4.00 -- must pick the closest PRECEDING bar, never a later one');
}

async function testEmptyObjectUnitsValueDoesNotThrow() {
  // Found live 2026-09-04 building the full float table: SEC's
  // companyconcept endpoint doesn't always omit an empty unit or use an
  // empty array for "no data" -- some real filers (BIIB confirmed live,
  // ~25 others in the first ~700 symbols of a full-universe run) return
  // `units: { shares: {} }`, an empty OBJECT. `{} || []` stays `{}`
  // (truthy), so a bare `.map` call threw for every one of these -- a
  // real, silent data-loss bug (fell into "missing," indistinguishable
  // from a genuine failure), not a rare malformed-response case.
  const mock = edgarMock({
    cikEntries: [{ ticker: 'BIIB', cik: 875045 }],
    floatPointsBySymbol: { BIIB: [{ end: '2026-03-10', filed: '2026-03-11', val: 1_000_000 }] },
    sharesResponseOverride: () => conceptResponse('shares', {}), // the real observed shape -- an object, not an array
  });
  const bars = barsMock({ BIIB: [{ t: '2026-03-10T00:00:00Z', c: 1.00 }] });
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  const { floatBySymbol, failedSymbols } = await getFloatDataForSymbols(['BIIB']);
  console.log('empty-object-units result:', { floatBySymbol: floatBySymbol.BIIB, failedSymbols });
  assert.ok(!failedSymbols.includes('BIIB'), 'must not throw/fail the symbol just because shares-outstanding data came back as {} instead of []');
  // sharesOutstanding unavailable -> the guard is skipped (see its own
  // "coverage unavailable" branch), so the float value still comes through.
  assert.strictEqual(floatBySymbol.BIIB.impliedFloatShares, 1_000_000);
}

async function testNoEntityPublicFloatFilingIsNotCheckedNotFailed() {
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    sharesPointsBySymbol: { A: [{ filed: '2026-05-12', val: 10_000_000 }] },
    // no floatPointsBySymbol entry for A -- real, mapped company, no EntityPublicFloat filing at all (404)
  });
  const { getFloatDataForSymbols } = loadEdgar(mock);
  const { floatBySymbol, failedSymbols, unmappedSymbols } = await getFloatDataForSymbols(['A']);
  console.log('no-filing result:', { floatBySymbol, failedSymbols, unmappedSymbols });
  assert.strictEqual(floatBySymbol.A, undefined, 'no EntityPublicFloat filing -- structural absence, not a measurement');
  assert.ok(!failedSymbols.includes('A'), 'a genuinely absent filing must never be reported as a failure');
  assert.ok(!unmappedSymbols.includes('A'), 'the symbol WAS mapped to a real CIK -- this is a different case from no CIK at all');
}

async function testUnmappedSymbolIsNotCheckedNotFailed() {
  const mock = edgarMock({ cikEntries: [{ ticker: 'REAL', cik: 320193 }] }); // NOT 'GHOST'
  const { getFloatDataForSymbols } = loadEdgar(mock);
  const { floatBySymbol, failedSymbols, unmappedSymbols } = await getFloatDataForSymbols(['GHOST']);
  console.log('unmapped result:', { floatBySymbol, failedSymbols, unmappedSymbols });
  assert.strictEqual(floatBySymbol.GHOST, undefined, 'no data for a symbol with no CIK mapping');
  assert.ok(!failedSymbols.includes('GHOST'), 'unmapped is a structural absence, not a failed request -- must not be reported as failedSymbols');
  assert.ok(unmappedSymbols.includes('GHOST'));
}

async function testEntityPublicFloatRequestFailureIsFailedSymbol() {
  const mock = async (url) => {
    if (url.includes('company_tickers.json')) return cikMapResponse([{ ticker: 'A', cik: 320193 }]);
    throw new Error('simulated network failure'); // the per-symbol XBRL request itself fails
  };
  const { getFloatDataForSymbols } = loadEdgar(mock);
  const { floatBySymbol, failedSymbols, unmappedSymbols } = await getFloatDataForSymbols(['A']);
  console.log('request-failure result:', { floatBySymbol, failedSymbols, unmappedSymbols });
  assert.strictEqual(floatBySymbol.A, undefined);
  assert.ok(failedSymbols.includes('A'), 'a real request failure (mapped CIK, but the data fetch itself threw) must be reported as failed, not unmapped');
  assert.ok(!unmappedSymbols.includes('A'));
}

async function testHistoricalPriceLookupFailureIsFailedSymbolNotNotChecked() {
  // A real EntityPublicFloat filing WAS found, but the price half of the
  // derivation couldn't complete (batch request threw). This is "found
  // real data, couldn't finish measuring it" -- fetch-failed, not
  // not-checked (which means no filing exists at all).
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2026-03-10', filed: '2026-03-11', val: 1_000_000 }] },
    sharesPointsBySymbol: { A: [{ filed: '2026-05-12', val: 10_000_000 }] },
  });
  const failingBars = async () => { throw new Error('simulated Alpaca outage'); };
  const { getFloatDataForSymbols } = loadEdgar(mock, failingBars);
  const { floatBySymbol, failedSymbols } = await getFloatDataForSymbols(['A']);
  console.log('price-lookup-failure result:', { floatBySymbol, failedSymbols });
  assert.strictEqual(floatBySymbol.A, undefined);
  assert.ok(failedSymbols.includes('A'), 'a real EntityPublicFloat filing existed but the price lookup failed -- must be reported as failed, not silently dropped as not-checked');
}

async function testHistoricalPriceLookupWithNoUsableBarIsNotCheckedNotFailed() {
  // RECLASSIFIED 2026-09-04: found live building the full float table --
  // this was ~99% (232/233) of that run's "failed" bucket, confirmed via a
  // direct Alpaca query that it genuinely has zero bars for a sample of
  // these symbols (not a batch/network fault). A real EntityPublicFloat
  // filing exists, but no historical price is available near its
  // reference date -- most plausibly the company wasn't yet publicly
  // traded that far back. PERMANENT for that filing (a retry never fixes
  // it), structurally the same as "no filing," so it must not count as a
  // build failure -- not-checked with its own distinct reason instead.
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2026-03-10', filed: '2026-03-11', val: 1_000_000 }] },
    sharesPointsBySymbol: { A: [{ filed: '2026-05-12', val: 10_000_000 }] },
  });
  const { getFloatDataForSymbols } = loadEdgar(mock, barsMock({})); // no bars for A at all
  const { floatBySymbol, failedSymbols } = await getFloatDataForSymbols(['A']);
  console.log('no-usable-bar result:', { floatBySymbol: floatBySymbol.A, failedSymbols });
  assert.ok(!failedSymbols.includes('A'), 'a permanent no-price-data case must never count as a build failure');
  assert.strictEqual(floatBySymbol.A.impliedFloatShares, null);
  assert.match(floatBySymbol.A.invalidReason, /no historical price data/i);
}

async function testFutureReferenceDateIsItsOwnReasonNotAPriceLookupFailure() {
  // A THIRD thing (2026-09-04, found live: NATH) -- a float fact whose
  // reference date is AFTER today is a data-integrity issue in the SEC
  // filing, not a missing price. Caught and reasoned distinctly BEFORE
  // attempting a price lookup at all -- there's no legitimate price to
  // find for a future date.
  const mock = edgarMock({
    cikEntries: [{ ticker: 'NATH', cik: 320193 }],
    floatPointsBySymbol: { NATH: [{ end: '2026-09-26', filed: '2026-08-01', val: 1_000_000 }] }, // end is AFTER "today" (2026-09-04)
    sharesPointsBySymbol: { NATH: [{ filed: '2026-05-12', val: 10_000_000 }] },
  });
  let barsRequested = false;
  const bars = async () => { barsRequested = true; return { barsBySymbol: {}, requests: 0 }; };
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  const { floatBySymbol, failedSymbols } = await getFloatDataForSymbols(['NATH']);
  console.log('future-reference-date result:', { floatBySymbol: floatBySymbol.NATH, failedSymbols, barsRequested });
  assert.ok(!failedSymbols.includes('NATH'));
  assert.strictEqual(floatBySymbol.NATH.impliedFloatShares, null);
  assert.match(floatBySymbol.NATH.invalidReason, /after today/i);
  assert.ok(!barsRequested, 'must never attempt a price lookup for a future reference date -- nothing legitimate to find');
}

async function testImpliedFloatExceedingSharesOutstandingIsDiscardedNotChecked() {
  // The invariant guard (2026-09-03): float is a subset of shares
  // outstanding by definition. Deliberately construct a derivation that
  // violates it (a stale/mismatched adjusted-close, same shape as the
  // real DAIC-under-raw defect this guard exists to catch generically) and
  // confirm it's discarded as not-checked with a specific reason, not
  // rendered as a fabricated number.
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2026-03-10', filed: '2026-03-11', val: 10_000_000 }] },
    sharesPointsBySymbol: { A: [{ filed: '2026-05-12', val: 5_000_000 }] }, // only 5M shares outstanding
  });
  // $10,000,000 / $1.00 = 10,000,000 implied float shares -- double the
  // 5,000,000 shares outstanding. Physically impossible.
  const bars = barsMock({ A: [{ t: '2026-03-10T00:00:00Z', c: 1.00 }] });
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  const { floatBySymbol } = await getFloatDataForSymbols(['A']);
  console.log('guard-caught result:', floatBySymbol.A);
  assert.strictEqual(floatBySymbol.A.impliedFloatShares, null, 'a derivation exceeding shares outstanding must never surface as a number');
  assert.match(floatBySymbol.A.invalidReason, /exceeds shares outstanding/i, 'the specific reason must reach the caller, not just the console log');
}

async function testImpliedFloatWithinSharesOutstandingIsNotDiscarded() {
  // Sanity check for the guard's other branch -- a normal, valid
  // derivation (implied float well under shares outstanding) must NOT be
  // discarded just because the guard now exists.
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2026-03-10', filed: '2026-03-11', val: 1_000_000 }] },
    sharesPointsBySymbol: { A: [{ filed: '2026-05-12', val: 10_000_000 }] },
  });
  const bars = barsMock({ A: [{ t: '2026-03-10T00:00:00Z', c: 1.00 }] });
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  const { floatBySymbol } = await getFloatDataForSymbols(['A']);
  assert.strictEqual(floatBySymbol.A.impliedFloatShares, 1_000_000);
}

async function testDilutionCorrectionScalesForShareIssuanceSinceReference() {
  // Found live 2026-09-04: BIAF (implied float 174,868) and GRI (41,528)
  // both PASSED the <10M gate on filings 431 days old -- the derivation is
  // correct AT its own reference date, but doesn't account for share
  // issuance since then. EDGAR gives the full dated shares-outstanding
  // history (already fetched for the guard), so:
  //   impliedFloatToday = impliedFloatAtRef × (sharesToday ÷ (sharesNearRef ÷ R))
  // where R = adjustedClose/rawClose at the reference date (the SAME
  // cumulative split factor the primary derivation already applies).
  //
  // Clean hand-computable case: a 10:1 reverse split (R=10) plus 2x
  // dilution since. impliedFloatAtRef = 100,000/10 (adjusted close) =
  // 10,000. sharesNearRef (raw, pre-split) = 500,000 -> in today's
  // (post-split) units: 500,000/10 = 50,000. sharesToday = 100,000 (2x
  // that baseline -- dilution). Corrected = 10,000 × (100,000/50,000) =
  // 20,000.
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2025-06-30', filed: '2025-07-01', val: 100_000 }] },
    sharesPointsBySymbol: { A: [
      { end: '2025-06-15', filed: '2025-06-20', val: 500_000 }, // near the float's reference date, PRE-split (raw) units
      { end: '2026-08-01', filed: '2026-08-05', val: 100_000 }, // today's shares outstanding, post-split, post-dilution
    ] },
  });
  const bars = barsByAdjustmentMock({
    all: { A: [{ t: '2025-06-30T00:00:00Z', c: 10 }] }, // adjusted close -- today's post-split-equivalent price
    raw: { A: [{ t: '2025-06-30T00:00:00Z', c: 1 }] },  // raw close -- the actual pre-split trade price -- R = 10/1 = 10
  });
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  const { floatBySymbol } = await getFloatDataForSymbols(['A']);
  console.log('dilution-corrected result:', floatBySymbol.A);
  assert.ok(Math.abs(floatBySymbol.A.impliedFloatShares - 20_000) < 0.01, `expected 20,000 (corrected for both the 10:1 split and 2x dilution), got ${floatBySymbol.A.impliedFloatShares}`);
  assert.strictEqual(floatBySymbol.A.dilutionCorrected, true);
}

async function testNaiveUnsplitAdjustedScalingWouldDoubleCountTheSplit() {
  // Regression guard for the exact bug this session caught: scaling by the
  // RAW sharesNearRef WITHOUT dividing by R double-applies the split,
  // since impliedFloatAtRef is already split-adjusted. Same fixture as
  // above -- the naive (wrong) formula would give 100,000/10 ×
  // (100,000/500,000) = 10,000 × 0.2 = 2,000, moving in the WRONG
  // direction (smaller, not the correct 20,000 -- see core/edgar.js's
  // header for the live BIAF trace of exactly this failure mode).
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2025-06-30', filed: '2025-07-01', val: 100_000 }] },
    sharesPointsBySymbol: { A: [
      { end: '2025-06-15', filed: '2025-06-20', val: 500_000 },
      { end: '2026-08-01', filed: '2026-08-05', val: 100_000 },
    ] },
  });
  const bars = barsByAdjustmentMock({
    all: { A: [{ t: '2025-06-30T00:00:00Z', c: 10 }] },
    raw: { A: [{ t: '2025-06-30T00:00:00Z', c: 1 }] },
  });
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  const { floatBySymbol } = await getFloatDataForSymbols(['A']);
  assert.ok(Math.abs(floatBySymbol.A.impliedFloatShares - 2_000) > 100, 'must NOT match the naive (double-split-counted) 2,000 result');
  assert.ok(Math.abs(floatBySymbol.A.impliedFloatShares - 20_000) < 0.01, 'must match the R-corrected 20,000 result instead');
}

async function testGuardSkippedWhenSharesOutstandingUnavailable() {
  // EntityCommonStockSharesOutstanding coverage is looser than float's
  // (~88% vs ~65%) -- its absence must not itself invalidate an otherwise
  // normal derivation.
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2026-03-10', filed: '2026-03-11', val: 1_000_000 }] },
    // no sharesPointsBySymbol entry for A -- 404
  });
  const bars = barsMock({ A: [{ t: '2026-03-10T00:00:00Z', c: 1.00 }] });
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  const { floatBySymbol } = await getFloatDataForSymbols(['A']);
  console.log('no-shares-outstanding-coverage result:', floatBySymbol.A);
  assert.strictEqual(floatBySymbol.A.impliedFloatShares, 1_000_000, 'missing shares-outstanding coverage must not block an otherwise valid derivation');
}

async function testPerSymbolCacheHitConsumesNoRequests() {
  let requestCount = 0;
  const base = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2026-03-10', filed: '2026-03-11', val: 1_000_000 }] },
    sharesPointsBySymbol: { A: [{ filed: '2026-05-12', val: 10_000_000 }] },
  });
  const mock = async (url) => { requestCount++; return base(url); };
  const bars = barsMock({ A: [{ t: '2026-03-10T00:00:00Z', c: 4.00 }] });
  const { getFloatDataForSymbols } = loadEdgar(mock, bars);
  const r1 = await getFloatDataForSymbols(['A']);
  const afterFirst = requestCount;
  const r2 = await getFloatDataForSymbols(['A']);
  console.log('requests after first call:', afterFirst, '| requests after second (should be cache hit):', requestCount, '| r2.requests:', r2.requests);
  assert.strictEqual(r2.requests, 0, 'a cache hit must report zero requests, per spec\'s own acceptance line ("float cache hit does not consume a call")');
  assert.strictEqual(requestCount, afterFirst, 'no new fetch() calls on the cached call');
  assert.strictEqual(r1.floatBySymbol.A.impliedFloatShares, r2.floatBySymbol.A.impliedFloatShares);
}

async function testCikMapFetchFailureMarksEveryMissingSymbolFailedNotUnmapped() {
  const mock = async (url) => {
    if (url.includes('company_tickers.json')) throw new Error('simulated CIK map outage');
    throw new Error('should never reach the per-symbol call');
  };
  const { getFloatDataForSymbols } = loadEdgar(mock);
  const { failedSymbols, unmappedSymbols } = await getFloatDataForSymbols(['A', 'B']);
  console.log('CIK-map-outage result:', { failedSymbols, unmappedSymbols });
  assert.deepStrictEqual(failedSymbols.sort(), ['A', 'B'], 'without the map at all, every requested symbol is unattributable -- a real failure, not a structural "no CIK exists" claim');
  assert.strictEqual(unmappedSymbols.length, 0);
}

async function testStalenessRecomputedAtReadTimeNotFrozenAtFetchTime() {
  // Two calls on different "today"s against the same cached entry must
  // report different staleness -- proves stalenessDays is derived from
  // the cached referenceDate at read time, not baked in once at fetch time.
  const mock = edgarMock({
    cikEntries: [{ ticker: 'A', cik: 320193 }],
    floatPointsBySymbol: { A: [{ end: '2026-03-10', filed: '2026-03-11', val: 1_000_000 }] },
    sharesPointsBySymbol: { A: [{ filed: '2026-05-12', val: 10_000_000 }] },
  });
  const bars = barsMock({ A: [{ t: '2026-03-10T00:00:00Z', c: 4.00 }] });
  global.state = { warriorEdgarCikMapCache: null, warriorFloatCache: null };
  global.persist = () => {};
  global.fetch = mock;
  global._fetchHistoricalDailyBars = bars;
  global._coreClient = {};
  global.getPT = () => new Date('2026-09-04T13:00:00Z');
  global.ptDateStr = () => '2026-09-04';
  const src = readSource('core/edgar.js');
  eval(src + '\nglobal.__f = getFloatDataForSymbols;');
  const r1 = await global.__f(['A']);
  console.log('staleness at day 1:', r1.floatBySymbol.A.stalenessDays);
  assert.strictEqual(r1.floatBySymbol.A.stalenessDays, 178);

  global.ptDateStr = () => '2026-09-14'; // 10 days later, same cached entry (within the 14-day cache window)
  global.getPT = () => new Date('2026-09-14T13:00:00Z');
  const r2 = await global.__f(['A']);
  console.log('staleness at day 11:', r2.floatBySymbol.A.stalenessDays);
  assert.strictEqual(r2.floatBySymbol.A.stalenessDays, 188, 'staleness must grow across calls even against the same cached fetch, since it is measured against the fixed reference date, not the fetch time');
}

(async () => {
  await run('edgar: fetches the CIK map once, reuses it across calls (24h cache)', testFetchesCikMapOnceThenCachesFor24h);
  await run('edgar: derives implied float shares from EntityPublicFloat ÷ ADJUSTED close on its own reference date', testImpliedFloatSharesDerivedFromAdjustedReferenceDateClose);
  await run('edgar: fetches historical bars with BOTH adjustment:\'all\' and \'raw\'', testHistoricalBarsFetchedWithBothAdjustedAndRaw);
  await run('edgar: uses the closest PRECEDING bar within the pad, never a later one', testUsesClosestPrecedingBarWithinThePad);
  await run('edgar: an empty-object units value (not an array) does not throw or fail the symbol', testEmptyObjectUnitsValueDoesNotThrow);
  await run('edgar: no EntityPublicFloat filing is not-checked, never reported as a failure', testNoEntityPublicFloatFilingIsNotCheckedNotFailed);
  await run('edgar: an unmapped symbol is not-checked, never reported as a failure', testUnmappedSymbolIsNotCheckedNotFailed);
  await run('edgar: an EntityPublicFloat request failure is reported as failed, distinct from unmapped', testEntityPublicFloatRequestFailureIsFailedSymbol);
  await run('edgar: a historical-price lookup failure is failed, not silently not-checked', testHistoricalPriceLookupFailureIsFailedSymbolNotNotChecked);
  await run('edgar: a historical-price lookup with no usable bar is not-checked (permanent), not a build failure', testHistoricalPriceLookupWithNoUsableBarIsNotCheckedNotFailed);
  await run('edgar: a future reference date is its own reason, never a price-lookup attempt or a failure', testFutureReferenceDateIsItsOwnReasonNotAPriceLookupFailure);
  await run('edgar: implied float exceeding shares outstanding is discarded as not-checked with a specific reason', testImpliedFloatExceedingSharesOutstandingIsDiscardedNotChecked);
  await run('edgar: implied float within shares outstanding is not discarded by the guard', testImpliedFloatWithinSharesOutstandingIsNotDiscarded);
  await run('edgar: the dilution correction scales implied float for share issuance since the reference date', testDilutionCorrectionScalesForShareIssuanceSinceReference);
  await run('edgar: a naive (non-split-corrected) scaling would double-count the split -- must not regress to it', testNaiveUnsplitAdjustedScalingWouldDoubleCountTheSplit);
  await run('edgar: the guard is skipped (not a block) when shares-outstanding coverage is unavailable', testGuardSkippedWhenSharesOutstandingUnavailable);
  await run('edgar: a per-symbol cache hit (14 days) consumes zero requests', testPerSymbolCacheHitConsumesNoRequests);
  await run('edgar: a CIK-map fetch failure marks every missing symbol failed, not unmapped', testCikMapFetchFailureMarksEveryMissingSymbolFailedNotUnmapped);
  await run('edgar: staleness is recomputed at read time against the fixed reference date, not frozen at fetch time', testStalenessRecomputedAtReadTimeNotFrozenAtFetchTime);
})();
