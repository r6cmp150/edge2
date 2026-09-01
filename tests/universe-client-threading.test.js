// tests/universe-client-threading.test.js — proves core/universe.js's
// public entry points actually forward a caller's client all the way down
// to the real alpacaGet call, added 2026-08-30.
//
// Why this is its own file, separate from tests/engine-tagging.test.js
// (which proves createApiClient itself tags correctly) and
// tests/minute-bars-two-tier.test.js/rvol-fetchers.test.js (which mock
// alpacaGet entirely and don't exercise tagging at all): the actual
// defect this session's family audit found was that a MAJORITY of both
// engines' real traffic flows through these shared universe.js helpers,
// not direct alpacaGet calls — so createApiClient alone doesn't separate
// engines; it has to be threaded through here specifically, or the fix is
// necessary but insufficient. This loads the REAL core/api-client.js
// alongside the real core/universe.js (not mocks of either) so the
// engine tag has to survive the actual call chain: getUniverse ->
// _getPremarketGapUniverse -> _getAssetIndex -> client.alpacaGet.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

function loadRealStack() {
  global.state = { universeAssetCache: null, universePriorCloseCache: null, settings: { alpacaKey: 'k', alpacaSecret: 's' } };
  global.persist = () => {};
  global.getPT = () => new Date('2026-08-24T13:00:00Z');
  global.ptDateStr = () => '2026-08-24';
  global.getMarketStatus = () => ({ status: 'OPEN' });
  global.chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
  // Real core/api-client.js first (defines alpacaGet, createApiClient,
  // _coreClient, getRequestStats, diffRequestStats as globals) — then
  // real core/universe.js on top, exactly the load order index.html uses.
  const apiClientSrc = readSource('core/api-client.js');
  const universeSrc = readSource('core/universe.js');
  const exposeCode = `
    global.__createApiClient = createApiClient;
    global.__getUniverse = getUniverse;
    global.__getRequestStats = getRequestStats;
    global.__diffRequestStats = diffRequestStats;
  `;
  // eslint-disable-next-line no-eval
  eval(apiClientSrc + '\n' + universeSrc + '\n' + exposeCode);
  return {
    createApiClient: global.__createApiClient, getUniverse: global.__getUniverse,
    getRequestStats: global.__getRequestStats, diffRequestStats: global.__diffRequestStats,
  };
}

// Empty asset list from /v2/assets short-circuits the rest of the
// premarket-gap chain (0 eligible symbols -> _getPriorCloses returns
// immediately without fetching -> priceFilteredSymbols.length is 0 ->
// early return) — deliberately minimal, isolating exactly the ONE request
// (_getAssetIndex's own) needed to prove the client survived the chain,
// without needing to fabricate full bars/asset fixtures.
function mockFetch() {
  return async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('/v2/assets') ? [] : { bars: {} }) });
}

async function testGetUniverseThreadsAGivenClientAllTheWayToAlpacaGet() {
  const { createApiClient, getUniverse, getRequestStats, diffRequestStats } = loadRealStack();
  global.fetch = mockFetch();

  const warriorClient = createApiClient('WARRIOR');
  const beforeWarrior = getRequestStats('WARRIOR');
  const beforeCore = getRequestStats('CORE');

  await getUniverse({ session: 'PRE', strategy: 'premarket-gap' }, warriorClient);

  const warriorDiff = diffRequestStats(beforeWarrior, getRequestStats('WARRIOR'));
  const coreDiff = diffRequestStats(beforeCore, getRequestStats('CORE'));
  console.log('getUniverse(premarket-gap) with an explicit WARRIOR client:', { warrior: warriorDiff, core: coreDiff });
  assert.strictEqual(warriorDiff.issued, 1, 'the client passed into getUniverse must be the one _getAssetIndex actually uses, all the way down the real call chain');
  assert.strictEqual(coreDiff.issued, 0, 'passing a real client must mean NONE of this call\'s requests fall through to the CORE default');
}

async function testGetUniverseDefaultsToCoreWhenNoClientGiven() {
  const { getUniverse, getRequestStats, diffRequestStats } = loadRealStack();
  global.fetch = mockFetch();

  const beforeCore = getRequestStats('CORE');
  await getUniverse({ session: 'PRE', strategy: 'premarket-gap' }); // no client -- Warrior's OWN files don't pass one yet, on this branch
  const coreDiff = diffRequestStats(beforeCore, getRequestStats('CORE'));
  console.log('getUniverse(premarket-gap) with no client:', coreDiff);
  assert.strictEqual(coreDiff.issued, 1, 'omitting the client must degrade to the honest CORE default, not silently misattribute to a hardcoded engine');
}

(async () => {
  await run('universe-client-threading: getUniverse threads a given client all the way to alpacaGet', testGetUniverseThreadsAGivenClientAllTheWayToAlpacaGet);
  await run('universe-client-threading: getUniverse defaults to CORE when no client is given', testGetUniverseDefaultsToCoreWhenNoClientGiven);
})();
