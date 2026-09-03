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
  global.state = { universeAssetCache: null, universePriorCloseCache: null, warrior30DayVolumeCache: null, ...stateOverrides };
  global.persist = () => {};
  global.getPT = () => new Date('2026-08-25T16:00:00Z'); // mid-session PT-equivalent for ptDateStr purposes only
  global.ptDateStr = () => '2026-08-25';
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
    global.__RVOL_VOLUME_CHUNK_SIZE = RVOL_VOLUME_CHUNK_SIZE;
    global.__RVOL_DAILY_AVG_CHUNK_SIZE = RVOL_DAILY_AVG_CHUNK_SIZE;
  `;
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeCode);
  return {
    fetchCumulativeMinuteVolume: global.__fetchCumulativeMinuteVolume,
    getSip30DayAvgVolume: global.__getSip30DayAvgVolume,
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

(async () => {
  await run('rvol-fetchers: cumulative volume sums all bars across pages, not just latest', testCumulativeVolumeSumsAllBarsNotJustLatest);
  await run('rvol-fetchers: cumulative-volume chunk size is provably single-page over a full session', testCumulativeVolumeChunkSizeProvenSinglePage);
  await run('rvol-fetchers: 30-day avg volume computes correctly and caches per day', test30DayAvgVolumeComputesAverageAndCaches);
  await run('rvol-fetchers: 30-day-avg chunk size is provably single-page over 30 days', test30DayAvgVolumeChunkSizeProvenSinglePage);
})();
