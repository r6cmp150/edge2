// tests/edgar.test.js — core/edgar.js, Phase 6 (float, completing Pillar
// 5). No key/auth, so no client-injection story to test the way
// core/universe.js's fetchers have (Alpaca engine-tagging) — this file
// covers what's actually specific to EDGAR: CIK-map caching, the
// per-symbol 14-day cache, the nearest-preceding-filing staleness match,
// and the unmapped/fetch-failed distinction classifyGate depends on.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

function loadEdgar(fetchMock, stateOverrides) {
  global.state = { warriorEdgarCikMapCache: null, warriorFloatCache: null, ...stateOverrides };
  global.persist = () => {};
  global.getPT = () => new Date('2026-09-04T13:00:00Z');
  global.ptDateStr = () => '2026-09-04';
  global.fetch = fetchMock;
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

function shareDataResponse(points) {
  return { ok: true, status: 200, json: async () => ({ units: { shares: points } }) };
}

function notFoundResponse() {
  return { ok: true, status: 404, json: async () => { throw new Error('should not be read on 404'); } };
}

async function testFetchesCikMapOnceThenCachesFor24h() {
  let cikMapCalls = 0;
  const mock = async (url, opts) => {
    assert.ok(opts.headers['User-Agent'] && opts.headers['User-Agent'].length > 0, 'SEC fair-use requires a descriptive User-Agent');
    if (url.includes('company_tickers.json')) { cikMapCalls++; return cikMapResponse([{ ticker: 'A', cik: 320193 }]); }
    return shareDataResponse([{ filed: '2026-08-01', val: 24_100_000 }]);
  };
  const { getFloatDataForSymbols } = loadEdgar(mock);
  await getFloatDataForSymbols(['A']);
  await getFloatDataForSymbols(['A']); // same symbol, same call -- should be a per-symbol cache hit, not re-fetch the CIK map either
  console.log('CIK map fetch count across two calls:', cikMapCalls);
  assert.strictEqual(cikMapCalls, 1, 'the CIK map must be fetched once and reused, not once per getFloatDataForSymbols call');
}

async function testNearestPrecedingFilingNeverFuture() {
  const mock = async (url) => {
    if (url.includes('company_tickers.json')) return cikMapResponse([{ ticker: 'A', cik: 320193 }]);
    // Three filings: one in the future (must be ignored -- live lookahead
    // is not real for a same-day gate check), one recent-past, one older.
    return shareDataResponse([
      { filed: '2026-09-10', val: 999_999_999 }, // future relative to the mocked "today" (2026-09-04) -- must never be picked
      { filed: '2026-08-15', val: 24_100_000 },  // most recent REAL preceding filing
      { filed: '2025-01-01', val: 50_000_000 },
    ]);
  };
  const { getFloatDataForSymbols } = loadEdgar(mock);
  const { sharesOutstandingBySymbol } = await getFloatDataForSymbols(['A']);
  console.log('matched filing:', sharesOutstandingBySymbol.A);
  assert.strictEqual(sharesOutstandingBySymbol.A.sharesOutstanding, 24_100_000, 'must pick the most recent filing STRICTLY BEFORE today, never a future one');
  assert.strictEqual(sharesOutstandingBySymbol.A.asOfDate, '2026-08-15');
  assert.strictEqual(sharesOutstandingBySymbol.A.stalenessDays, 20, '2026-09-04 minus 2026-08-15');
}

async function testUnmappedSymbolIsNotCheckedNotFailed() {
  const mock = async (url) => {
    if (url.includes('company_tickers.json')) return cikMapResponse([{ ticker: 'REAL', cik: 320193 }]); // NOT 'GHOST'
    return shareDataResponse([{ filed: '2026-08-01', val: 1_000_000 }]);
  };
  const { getFloatDataForSymbols } = loadEdgar(mock);
  const { sharesOutstandingBySymbol, failedSymbols, unmappedSymbols } = await getFloatDataForSymbols(['GHOST']);
  console.log('unmapped result:', { sharesOutstandingBySymbol, failedSymbols, unmappedSymbols });
  assert.strictEqual(sharesOutstandingBySymbol.GHOST, undefined, 'no data for a symbol with no CIK mapping');
  assert.ok(!failedSymbols.includes('GHOST'), 'unmapped is a structural absence, not a failed request -- must not be reported as failedSymbols');
  assert.ok(unmappedSymbols.includes('GHOST'));
}

async function testRequestFailureIsFailedSymbolNotUnmapped() {
  const mock = async (url) => {
    if (url.includes('company_tickers.json')) return cikMapResponse([{ ticker: 'A', cik: 320193 }]);
    throw new Error('simulated network failure'); // the per-symbol XBRL request itself fails
  };
  const { getFloatDataForSymbols } = loadEdgar(mock);
  const { sharesOutstandingBySymbol, failedSymbols, unmappedSymbols } = await getFloatDataForSymbols(['A']);
  console.log('request-failure result:', { sharesOutstandingBySymbol, failedSymbols, unmappedSymbols });
  assert.strictEqual(sharesOutstandingBySymbol.A, undefined);
  assert.ok(failedSymbols.includes('A'), 'a real request failure (mapped CIK, but the data fetch itself threw) must be reported as failed, not unmapped');
  assert.ok(!unmappedSymbols.includes('A'));
}

async function testNoDataAtAllIs404NotAFailure() {
  // A real, mapped company with genuinely no XBRL data for this concept
  // (404) is neither a failure nor "unmapped" -- just no usable filing.
  const mock = async (url) => {
    if (url.includes('company_tickers.json')) return cikMapResponse([{ ticker: 'A', cik: 320193 }]);
    return notFoundResponse();
  };
  const { getFloatDataForSymbols } = loadEdgar(mock);
  const { sharesOutstandingBySymbol, failedSymbols, unmappedSymbols } = await getFloatDataForSymbols(['A']);
  assert.strictEqual(sharesOutstandingBySymbol.A, undefined);
  assert.ok(!failedSymbols.includes('A'), '404 (no data for this concept) is a real, expected outcome, not a request failure');
  assert.ok(!unmappedSymbols.includes('A'), 'the symbol WAS mapped to a real CIK -- 404 on the concept query is a different thing from no CIK at all');
}

async function testPerSymbolCacheHitConsumesNoRequests() {
  let requestCount = 0;
  const mock = async (url) => {
    requestCount++;
    if (url.includes('company_tickers.json')) return cikMapResponse([{ ticker: 'A', cik: 320193 }]);
    return shareDataResponse([{ filed: '2026-08-01', val: 24_100_000 }]);
  };
  const { getFloatDataForSymbols } = loadEdgar(mock);
  const r1 = await getFloatDataForSymbols(['A']);
  const afterFirst = requestCount;
  const r2 = await getFloatDataForSymbols(['A']);
  console.log('requests after first call:', afterFirst, '| requests after second (should be cache hit):', requestCount, '| r2.requests:', r2.requests);
  assert.strictEqual(r2.requests, 0, 'a cache hit must report zero requests, per spec\'s own acceptance line ("float cache hit does not consume a call")');
  assert.strictEqual(requestCount, afterFirst, 'no new fetch() calls on the cached call');
  assert.strictEqual(r1.sharesOutstandingBySymbol.A.sharesOutstanding, r2.sharesOutstandingBySymbol.A.sharesOutstanding);
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

(async () => {
  await run('edgar: fetches the CIK map once, reuses it across calls (24h cache)', testFetchesCikMapOnceThenCachesFor24h);
  await run('edgar: matches the nearest PRECEDING filing, never a future one', testNearestPrecedingFilingNeverFuture);
  await run('edgar: an unmapped symbol is not-checked, never reported as a failure', testUnmappedSymbolIsNotCheckedNotFailed);
  await run('edgar: a request failure is reported as failed, distinct from unmapped', testRequestFailureIsFailedSymbolNotUnmapped);
  await run('edgar: a 404 (no XBRL data) is neither a failure nor unmapped', testNoDataAtAllIs404NotAFailure);
  await run('edgar: a per-symbol cache hit (14 days) consumes zero requests', testPerSymbolCacheHitConsumesNoRequests);
  await run('edgar: a CIK-map fetch failure marks every missing symbol failed, not unmapped', testCikMapFetchFailureMarksEveryMissingSymbolFailedNotUnmapped);
})();
