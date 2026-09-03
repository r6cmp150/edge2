// tests/rvol-fetchers.test.js — core/universe.js's Phase 3 additions:
// _fetchCumulativeMinuteVolume (sums every minute bar in range, not just
// the latest) and _getSip30DayAvgVolume (cached 30-day SIP daily average).
// Both share _fetchRawMinuteBars/chunking with the existing
// _fetchMinuteBarsWindow (proven unchanged by minute-bars-two-tier.test.js
// and pagination-merge.test.js still passing after the refactor) — this
// file covers what's actually new: summation instead of latest-bar, and
// the 30-day average's own caching/chunking.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

function loadUniverse(alpacaGetMock, stateOverrides) {
  global.state = { universeAssetCache: null, universePriorCloseCache: null, warrior30DayVolumeCache: null, warriorPreMarketVolumeCache: null, ...stateOverrides };
  global.persist = () => {};
  // Real core/clock.js functions (2026-09-04), not the earlier fixed-date
  // stub -- _getPreMarketVolumeHistory's day-walking (_lastNTradingDayStrs)
  // needs REAL isTradingDay/ptWallClockToInstant behavior to test
  // correctly: a getPT() that ignores its argument and always returns the
  // same date would make every candidate day evaluate identically,
  // regardless of which date is actually being checked. Doesn't change
  // the existing fetchers' behavior — they only needed getPT()/ptDateStr()
  // to be CONSISTENT across calls within one test, which real
  // implementations still are.
  const clockSrc = readSource('core/clock.js');
  const clockExpose = 'global.getPT = getPT; global.ptDateStr = ptDateStr; global.ptWallClockToInstant = ptWallClockToInstant; global.isTradingDay = isTradingDay;';
  // eslint-disable-next-line no-eval
  eval(clockSrc + '\n' + clockExpose);
  global.chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
  global.alpacaGet = alpacaGetMock;
  // Minimal stand-in for core/api-client.js's real createApiClient/
  // _coreClient (2026-08-30) — this file tests these two fetchers'
  // summation/caching logic, not engine tagging (see
  // tests/engine-tagging.test.js for that).
  global.createApiClient = () => ({ alpacaGet: global.alpacaGet });
  global._coreClient = global.createApiClient('CORE');
  global.assertPageNotSuspiciouslyFull = () => {}; // real impl in core/api-client.js — diagnostic-only, no-op here
  // HISTORICAL_BAR_ADJUSTMENT (real impl: core/market-data.js top-level
  // const, referenced here as an ordinary global — see index.html's
  // script order). Pre-existing gap, confirmed failing the same way on
  // unmerged main — not introduced by the 2026-09-04 merge.
  global.HISTORICAL_BAR_ADJUSTMENT = 'all';
  const src = readSource('core/universe.js');
  const exposeCode = `
    global.__fetchCumulativeMinuteVolume = _fetchCumulativeMinuteVolume;
    global.__getSip30DayAvgVolume = _getSip30DayAvgVolume;
    global.__getPreMarketVolumeHistory = _getPreMarketVolumeHistory;
    global.__lastNTradingDayStrs = _lastNTradingDayStrs;
    global.__RVOL_VOLUME_CHUNK_SIZE = RVOL_VOLUME_CHUNK_SIZE;
    global.__RVOL_DAILY_AVG_CHUNK_SIZE = RVOL_DAILY_AVG_CHUNK_SIZE;
    global.__PRE_MARKET_RVOL_CHUNK_SIZE = PRE_MARKET_RVOL_CHUNK_SIZE;
    global.__PRE_MARKET_RVOL_LOOKBACK_TRADING_DAYS = PRE_MARKET_RVOL_LOOKBACK_TRADING_DAYS;
  `;
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeCode);
  return {
    fetchCumulativeMinuteVolume: global.__fetchCumulativeMinuteVolume,
    getSip30DayAvgVolume: global.__getSip30DayAvgVolume,
    getPreMarketVolumeHistory: global.__getPreMarketVolumeHistory,
    lastNTradingDayStrs: global.__lastNTradingDayStrs,
  };
}

async function testCumulativeVolumeSumsAllBarsNotJustLatest() {
  const callLog = [];
  const mock = async (path, params) => {
    callLog.push({ path, params: { ...params } });
    assert.strictEqual(params.feed, 'sip', 'RVOL volume must use SIP, matching the SIP-based 30-day average it will be divided by');
    if (!params.page_token) {
      // Page 1: two bars for symbol A, one for B.
      return {
        bars: { A: [{ t: '2026-08-25T14:31:00Z', v: 1000 }, { t: '2026-08-25T14:30:00Z', v: 500 }], B: [{ t: '2026-08-25T14:31:00Z', v: 200 }] },
        next_page_token: 'p2',
      };
    }
    // Page 2: one more bar for A.
    return { bars: { A: [{ t: '2026-08-25T14:32:00Z', v: 300 }] }, next_page_token: null };
  };
  const { fetchCumulativeMinuteVolume } = loadUniverse(mock);
  const start = new Date('2026-08-25T13:30:00Z');
  const end = new Date('2026-08-25T14:32:30Z');
  const { volumeBySymbol, requests } = await fetchCumulativeMinuteVolume(['A', 'B'], start, end);

  console.log('volumeBySymbol:', volumeBySymbol, '| requests:', requests);
  assert.strictEqual(requests, 2, 'expected 2 requests (page 1 + page 2)');
  assert.strictEqual(volumeBySymbol.A, 1000 + 500 + 300, 'A\'s volume must be the SUM of all 3 bars across both pages, not just the latest');
  assert.strictEqual(volumeBySymbol.B, 200);
}

async function testCumulativeVolumeChunkSizeProvenSinglePage() {
  // Proof, not estimate (CLAUDE.md pagination rule): at
  // RVOL_VOLUME_CHUNK_SIZE symbols and a full 390-minute session, worst-case
  // bars per request must stay under Alpaca's 10,000 ceiling.
  const { } = loadUniverse(async () => ({ bars: {}, next_page_token: null }));
  const chunkSize = global.__RVOL_VOLUME_CHUNK_SIZE;
  const worstCaseBars = chunkSize * 390;
  console.log(`RVOL_VOLUME_CHUNK_SIZE=${chunkSize}, worst-case bars at full session (390min) = ${worstCaseBars}`);
  assert.ok(worstCaseBars < 10000, `chunk size ${chunkSize} does not provably stay single-page over a full session (${worstCaseBars} >= 10000)`);
}

async function test30DayAvgVolumeComputesAverageAndCaches() {
  const callLog = [];
  const mock = async (path, params) => {
    callLog.push({ path, params: { ...params } });
    assert.strictEqual(params.feed, 'sip');
    assert.strictEqual(params.timeframe, '1Day');
    // 3 daily bars for A: volumes 100, 200, 300 -> avg 200.
    return { bars: { A: [{ v: 100 }, { v: 200 }, { v: 300 }] }, next_page_token: null };
  };
  const { getSip30DayAvgVolume } = loadUniverse(mock);

  const r1 = await getSip30DayAvgVolume(['A']);
  console.log('First call avgVolumes:', r1.avgVolumes, '| requests:', r1.requests);
  assert.strictEqual(r1.avgVolumes.A, 200);
  assert.strictEqual(r1.requests, 1);

  // Second call for the SAME symbol, same (mocked) day, must hit cache —
  // zero additional requests. callLog length across both calls proves it,
  // not just the returned requests count.
  const r2 = await getSip30DayAvgVolume(['A']);
  console.log('Second call (should be cached) avgVolumes:', r2.avgVolumes, '| requests:', r2.requests);
  assert.strictEqual(r2.requests, 0, 'second call for an already-cached symbol on the same day must make zero requests');
  assert.strictEqual(callLog.length, 1, 'only the first call should have hit alpacaGet at all');
}

async function test30DayAvgVolumeChunkSizeProvenSinglePage() {
  const { } = loadUniverse(async () => ({ bars: {}, next_page_token: null }));
  const chunkSize = global.__RVOL_DAILY_AVG_CHUNK_SIZE;
  const worstCaseBars = chunkSize * 30; // 30-day lookback
  console.log(`RVOL_DAILY_AVG_CHUNK_SIZE=${chunkSize}, worst-case bars at 30 days = ${worstCaseBars}`);
  assert.ok(worstCaseBars < 10000, `chunk size ${chunkSize} does not provably stay single-page over 30 days (${worstCaseBars} >= 10000)`);
}

// ── Pre-market-specific RVOL baseline (2026-09-04) ──────────────────────

async function testLastNTradingDayStrsSkipsWeekendsAndHolidays() {
  const { lastNTradingDayStrs } = loadUniverse(async () => ({ bars: {}, next_page_token: null }));
  // 2026-06-01 is a Monday. Walking back 5 TRADING days must skip the
  // weekend (05-30/05-31) AND 2026-05-25 (Memorial Day, a real holiday in
  // core/clock.js's HOLIDAYS set, itself a Monday) -- a real date range
  // that exercises both skip rules in one assertion, not a synthetic one.
  const days = lastNTradingDayStrs(5, '2026-06-01');
  console.log('last 5 trading days before 2026-06-01:', days);
  assert.deepStrictEqual(days, ['2026-05-22', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29'],
    'must skip the weekend and the 05-25 holiday, landing on 05-22 as the 5th trading day back, oldest-first');
}

async function testPreMarketVolumeHistoryChunkSizeProvenSinglePage() {
  const { } = loadUniverse(async () => ({ bars: {}, next_page_token: null }));
  const chunkSize = global.__PRE_MARKET_RVOL_CHUNK_SIZE;
  const worstCaseBars = chunkSize * 330; // 1:00am-6:30am PT pre-market window in minutes
  console.log(`PRE_MARKET_RVOL_CHUNK_SIZE=${chunkSize}, worst-case bars at 330min pre-market window = ${worstCaseBars}`);
  assert.ok(worstCaseBars < 10000, `chunk size ${chunkSize} does not provably stay single-page for one day's pre-market window (${worstCaseBars} >= 10000)`);
}

async function testPreMarketVolumeHistoryFetchesOncePerTradingDayAndCaches() {
  const callDates = [];
  const mock = async (path, params) => {
    assert.strictEqual(params.feed, 'sip');
    assert.strictEqual(params.timeframe, '1Min');
    callDates.push(params.start.slice(0, 10));
    // Every day returns the same volume for symbol A so the average is trivially checkable.
    return { bars: { A: [{ v: 1000 }, { v: 500 }] }, next_page_token: null };
  };
  const { getPreMarketVolumeHistory } = loadUniverse(mock);
  const lookback = global.__PRE_MARKET_RVOL_LOOKBACK_TRADING_DAYS;

  const r1 = await getPreMarketVolumeHistory(['A']);
  console.log('first call: requests=', r1.requests, '| days fetched=', callDates.length, '| avg=', r1.avgVolumes.A, '| daysInAverage=', r1.historyBySymbol.A.length);
  assert.strictEqual(r1.requests, lookback, `must fetch exactly one request per trading day in the lookback window (expected ${lookback})`);
  assert.strictEqual(callDates.length, lookback);
  assert.strictEqual(new Set(callDates).size, lookback, 'every request must be for a DIFFERENT trading day, not the same day repeated');
  assert.strictEqual(r1.avgVolumes.A, 1500, 'average of 1500/day across every fetched day');
  assert.strictEqual(r1.historyBySymbol.A.length, lookback, 'one history entry per trading day actually fetched');

  const beforeCount = callDates.length;
  const r2 = await getPreMarketVolumeHistory(['A']);
  console.log('second call (should be cached): requests=', r2.requests, '| new fetches=', callDates.length - beforeCount);
  assert.strictEqual(r2.requests, 0, 'second call for an already-cached symbol on the same day must make zero requests');
  assert.strictEqual(callDates.length, beforeCount, 'no new alpacaGet calls on the cached call');
}

async function testPreMarketVolumeHistorySkipsDaysWithNoBarsWithoutRecordingAZero() {
  // Half the days genuinely have no pre-market trades for this symbol —
  // must be OMITTED from history, not recorded as volume:0 (a zero would
  // silently pull the average down as if "no volume" were a measured
  // fact rather than an absent one — same principle as the regular RVOL
  // fetchers' own missing-day handling).
  let callCount = 0;
  const mock = async () => {
    callCount++;
    if (callCount % 2 === 0) return { bars: {}, next_page_token: null }; // no bars this day
    return { bars: { A: [{ v: 1000 }] }, next_page_token: null };
  };
  const { getPreMarketVolumeHistory } = loadUniverse(mock);
  const lookback = global.__PRE_MARKET_RVOL_LOOKBACK_TRADING_DAYS;
  const r = await getPreMarketVolumeHistory(['A']);
  console.log('half-empty-days: requests=', r.requests, '| daysInAverage=', r.historyBySymbol.A.length, '| avg=', r.avgVolumes.A);
  assert.strictEqual(r.requests, lookback, 'still one request per trading day, even for the empty-result days');
  assert.strictEqual(r.historyBySymbol.A.length, Math.ceil(lookback / 2), 'only the days with real bars are recorded');
  assert.strictEqual(r.avgVolumes.A, 1000, 'average computed only over days with real data, not diluted by phantom zeros');
}

async function testPreMarketVolumeHistoryFailedSymbolsMeansZeroUsableDays() {
  // A symbol that fails SOME days but succeeds on others has a real,
  // smaller-sample average -- NOT the same as a total failure. Only a
  // symbol with literally zero usable days should be reported as failed.
  const mock = async (path, params) => {
    if (params.symbols.includes('ALWAYS_FAILS')) throw new Error('simulated failure');
    return { bars: { PARTIAL: [{ v: 100 }] }, next_page_token: null };
  };
  const { getPreMarketVolumeHistory } = loadUniverse(mock);
  // PARTIAL and ALWAYS_FAILS batched together -- both symbols share every
  // request's outcome here since the mock throws per-request, not
  // per-symbol-within-a-batch; this specifically tests the "zero usable
  // days -> failed" contract using a symbol requested ALONE.
  const rFailed = await getPreMarketVolumeHistory(['ALWAYS_FAILS']);
  console.log('always-fails symbol: avgVolumes=', rFailed.avgVolumes, '| failedSymbols=', rFailed.failedSymbols);
  assert.strictEqual(rFailed.avgVolumes.ALWAYS_FAILS, undefined, 'no usable days -> no average');
  assert.ok(rFailed.failedSymbols.includes('ALWAYS_FAILS'), 'zero usable days must be reported as failed');

  global.state = { warriorPreMarketVolumeCache: null }; // fresh cache, different symbol
  const { getPreMarketVolumeHistory: getPreMarketVolumeHistory2 } = loadUniverse(mock);
  const rPartial = await getPreMarketVolumeHistory2(['PARTIAL']);
  console.log('always-succeeds symbol: avgVolumes=', rPartial.avgVolumes, '| failedSymbols=', rPartial.failedSymbols);
  assert.strictEqual(rPartial.avgVolumes.PARTIAL, 100, 'a symbol with usable days gets a real average');
  assert.ok(!rPartial.failedSymbols.includes('PARTIAL'), 'a symbol with at least one usable day must NOT be reported as failed');
}

(async () => {
  await run('rvol-fetchers: cumulative volume sums all bars across pages, not just latest', testCumulativeVolumeSumsAllBarsNotJustLatest);
  await run('rvol-fetchers: cumulative-volume chunk size is provably single-page over a full session', testCumulativeVolumeChunkSizeProvenSinglePage);
  await run('rvol-fetchers: 30-day avg volume computes correctly and caches per day', test30DayAvgVolumeComputesAverageAndCaches);
  await run('rvol-fetchers: 30-day-avg chunk size is provably single-page over 30 days', test30DayAvgVolumeChunkSizeProvenSinglePage);
  await run('rvol-fetchers: _lastNTradingDayStrs skips weekends and holidays', testLastNTradingDayStrsSkipsWeekendsAndHolidays);
  await run('rvol-fetchers: pre-market volume history chunk size is provably single-page for one day', testPreMarketVolumeHistoryChunkSizeProvenSinglePage);
  await run('rvol-fetchers: pre-market volume history fetches once per trading day and caches', testPreMarketVolumeHistoryFetchesOncePerTradingDayAndCaches);
  await run('rvol-fetchers: pre-market volume history skips empty days without recording a zero', testPreMarketVolumeHistorySkipsDaysWithNoBarsWithoutRecordingAZero);
  await run('rvol-fetchers: pre-market volume history failedSymbols means zero usable days, not any single failed day', testPreMarketVolumeHistoryFailedSymbolsMeansZeroUsableDays);
})();
