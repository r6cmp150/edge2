// tests/asset-index-fields.test.js -- 2026-11-18, P2 (the reviewer: "show that name and exchange are never read from
// the cache, do not observe it"). The cached asset index (state.universeAssetCache, persisted on Roman's phone, ~1.1M
// characters) stored { symbol, exchange, name, isEligibleInstrument } per asset; an estimate put name + exchange at
// 50-59% of it. From this change it stores { symbol, isEligibleInstrument } only. Shown three ways:
//   1. EXECUTED: every core consumer of the index, run for real against a cached index whose name and exchange
//      THROW when read, and whose symbol reads are counted (a consumer that never reached the index proves nothing);
//   2. SCRIPTS: every script line that touches an index entry accesses only symbol / isEligibleInstrument;
//   3. ENUMERATED: every use of _getAssetIndex / _assetIndexBySymbol / universeAssetCache is classified below, and the
//      list fails both ways (a new consumer must be classified; a stale entry must go).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSource, run: runNow, REPO_ROOT } = require('./_lib');
const queue = [];
const run = (name, fn) => queue.push([name, fn]);

const POISON = 'POISON: a cached asset entry\'s';
function poisonedEntry(symbol, eligible, reads) {
  return Object.defineProperties({}, {
    symbol: { enumerable: true, get() { reads.symbol++; return symbol; } },
    isEligibleInstrument: { enumerable: true, get() { reads.eligible++; return eligible; } },
    name: { enumerable: false, get() { throw new Error(`${POISON} name was read (${symbol})`); } },
    exchange: { enumerable: false, get() { throw new Error(`${POISON} exchange was read (${symbol})`); } },
  });
}
const FILLER = n => Array.from({ length: n }, (_, i) => 'FILL' + i);

function load(alpacaGet, cache) {
  global.state = { universeAssetCache: cache, edgeLiquidityCache: null, settings: {} };
  global.persist = () => {};
  // eslint-disable-next-line no-eval
  eval(readSource('core/clock.js') + '\nglobal.getPT = getPT; global.ptDateStr = ptDateStr; global.previousTradingDay = previousTradingDay; global.isTradingDay = isTradingDay; global.ptDateTimeOf = ptDateTimeOf; global.scanFreshness = scanFreshness;');
  global.getMarketStatus = () => ({ status: 'PRE' }); // the diagnostics ask the session first
  global.fetchSnapshots = async syms => Object.fromEntries(syms.map(s => [s, { latestTrade: { p: 5 }, dailyBar: { c: 5, v: 9e6 }, prevDailyBar: { c: 4 } }]));
  global.sipSafeEndParams = d => ({ end: d }); // core/api-client.js's, for a past window
  global.getRequestStats = () => ({ issued: 0 }); global.diffRequestStats = () => ({ issued: 0 }); // request counters
  global.chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
  global.alpacaGet = alpacaGet;
  global.createApiClient = () => ({ alpacaGet: (...a) => global.alpacaGet(...a) });
  global._coreClient = global.createApiClient('CORE');
  global.assertPageNotSuspiciouslyFull = () => {};
  global.HISTORICAL_BAR_ADJUSTMENT = 'all';
  // the REAL price and session reading (2026-11-23: universe.js's actives read sessionInputs), not a stub of the old order
  // eslint-disable-next-line no-eval
  eval(readSource('core/market-data.js') + '\nglobal.getLivePrice = getLivePrice; global.sessionInputs = sessionInputs;');
  // eslint-disable-next-line no-eval
  eval(readSource('core/universe.js') + `
    global._getAssetIndex = _getAssetIndex; global.getAssetListing = getAssetListing; global.getUniverse = getUniverse;
    global.reconstructTopMoversUniverse = reconstructTopMoversUniverse; global.diagnosePremarketGap = diagnosePremarketGap;
    global.diagnosePrevDailyBarCoverage = diagnosePrevDailyBarCoverage;`);
}

// A mocked Alpaca that answers every path with an empty-but-valid shape, and /v2/assets with a raw list.
function alpaca(log) {
  return async (p, params) => {
    log.push(p);
    if (p === '/v2/assets') {
      return [{ symbol: 'AAA', exchange: 'NASDAQ', tradable: true, name: 'Aaa Corp Common Stock' },
        { symbol: 'FUND', exchange: 'NYSE', tradable: true, name: 'Some Income Fund' },
        { symbol: 'OTC1', exchange: 'OTC', tradable: true, name: 'Otc Thing' },
        ...FILLER(1100).map(s => ({ symbol: s, exchange: 'NYSE', tradable: true, name: 'Filler Corp Common Stock' }))];
    }
    if (/movers/.test(p)) return { gainers: [{ symbol: 'AAA', price: 5, change: 1, percent_change: 25 }], losers: [] };
    if (/most-actives/.test(p)) return { most_actives: [{ symbol: 'AAA', volume: 9e6, trade_count: 1 }] };
    if (/snapshots/.test(p)) return {};
    return { bars: {}, next_page_token: null };
  };
}

function poisonedCache(reads) {
  return {
    fetchedAt: new Date().toISOString(),
    assets: [poisonedEntry('AAA', true, reads), poisonedEntry('FUND', false, reads), ...FILLER(1100).map(s => poisonedEntry(s, true, reads))],
    outsideIndex: { OTC1: true },
  };
}

// 1. EXECUTED
const CONSUMERS = [
  ['getAssetListing (EDGE prefilter, app and logger)', () => global.getAssetListing(['AAA', 'FUND', 'ZZZ'])],
  ["getUniverse movers (Warrior's intraday universe)", async () => {
    const r = await global.getUniverse({ session: 'OPEN', strategy: 'movers' });
    const syms = JSON.stringify(r);
    assert.ok(/"AAA"/.test(syms), 'AAA (eligible, in range) passes the eligibility filter, so the filter consulted its cached entry: ' + syms.slice(0, 300));
  }],
  ['getUniverse premarket-gap', () => global.getUniverse({ session: 'pre', strategy: 'premarket-gap' })],
  ['reconstructTopMoversUniverse', () => global.reconstructTopMoversUniverse({ startDateStr: '2026-11-02', endDateStr: '2026-11-06', topN: 5 })],
  ['diagnosePremarketGap', () => global.diagnosePremarketGap()],
  ['diagnosePrevDailyBarCoverage', () => global.diagnosePrevDailyBarCoverage()],
];
for (const [name, call] of CONSUMERS) {
  run(`EXECUTED: ${name} reads the cached index without touching name or exchange`, async () => {
    const reads = { symbol: 0, eligible: 0 }; const log = [];
    load(alpaca(log), poisonedCache(reads));
    let err = null;
    try { await call(); } catch (e) { err = e; }
    assert.ok(!(err && String(err.message).startsWith(POISON)), `${name} read a dropped field: ${err && err.message}`);
    assert.strictEqual(err, null, `${name} must COMPLETE against the mock, or the run proves nothing past the point it threw: ${err && err.message}`);
    assert.ok(reads.symbol > 0, `${name} never reached the cached index (no symbol read${err ? '; it threw first: ' + err.message : ''}), so this proves nothing`);
    assert.ok(!log.includes('/v2/assets'), `${name} refetched the asset list instead of reading the cache`);
  });
}

run('the index is BUILT and CACHED with symbol and isEligibleInstrument only, eligibility still judged from the name', async () => {
  const log = [];
  load(alpaca(log), null);
  const idx = await global._getAssetIndex();
  assert.ok(log.includes('/v2/assets'));
  for (const a of idx) assert.deepStrictEqual(Object.keys(a).sort(), ['isEligibleInstrument', 'symbol'], JSON.stringify(a));
  assert.deepStrictEqual(Object.keys(global.state.universeAssetCache.assets[0]).sort(), ['isEligibleInstrument', 'symbol'], 'the persisted copy too');
  const by = Object.fromEntries(idx.map(a => [a.symbol, a.isEligibleInstrument]));
  assert.strictEqual(by.AAA, true);
  assert.strictEqual(by.FUND, false, 'a fund is still excluded: the name is read from the RAW asset at build time');
  assert.ok(!('OTC1' in by) && global.state.universeAssetCache.outsideIndex.OTC1 === true, 'outsideIndex unchanged');
});

// 2. SCRIPTS: the lines that touch an index entry, and the properties they access.
const SCRIPT_LINES = {
  'scripts/build-exit-model-dataset.mjs': /assetIndex/,
  'scripts/build-float-table.mjs': /assetIndex/,
  'scripts/probe-survivorship-bias.mjs': /assetIndex/,
  'scripts/probe-topn-window.mjs': /assetIndex/,
  'scripts/log-signals-warrior.mjs': /assetIndex|assetsBySymbol|\basset\b/,
};
const ALLOWED_PROPS = new Set(['symbol', 'isEligibleInstrument', 'length', 'filter', 'map', 'slice', 'forEach']);
run('SCRIPTS: every line that touches a cached index entry accesses only symbol / isEligibleInstrument', () => {
  for (const [f, re] of Object.entries(SCRIPT_LINES)) {
    const lines = readSource(f).split('\n').filter(l => !/^\s*\/\//.test(l) && re.test(l));
    assert.ok(lines.length, `${f}: no line found (the enumeration below should have caught a removal)`);
    for (const l of lines) {
      const props = [...l.matchAll(/\b(?:assetIndex|asset|a)\??\.(\w+)/g)].map(m => m[1]);
      const bad = props.filter(p => !ALLOWED_PROPS.has(p));
      assert.deepStrictEqual(bad, [], `${f}: ${l.trim()}`);
    }
  }
});

// 3. ENUMERATED, both ways.
// IDENTIFIED, NOT COUNTED (2026-11-18, the reviewer: "a count can be satisfied by an impostor"). This was a per-file
// COUNT of uses: a consumer removed and a new one added in the same file kept the count, and the new one, unexecuted
// above, could read name or exchange from the cache unseen. Now each use is the exact line (trimmed, outside comments)
// that touches the index; a changed or new line fails until it is classified here, and the count follows.
const USES = {
  "app.js": [
    "universeAssetCache: null, // { fetchedAt, assets: [{symbol,isEligibleInstrument}] (P2, 2026-11-18), outsideIndex } — core/universe.js, 24h cache — persisted",
    "['sold','analysisPeriods','signals','lastScanTime','news','signalToggles','lastPassedCount','lastScanDroppedCount','selectedUniverse','notifications','ownedScores','ownedPrevRSI','ownedPeakRSI','universeAssetCache','universePriorCloseCache','warrior30DayVolumeCache','warriorPreMarketVolumeCache','warriorPreMarketRvolObservations','saleWriteFailures','snapshotWriteFailures','ratingWriteFailures','macroGroqLast'].forEach(k => {",
  ],
  "core/store.js": [
    "sold: 4, analysisPeriods: 4, signals: 4, news: 4, ownedScores: 4, universeAssetCache: 4, universePriorCloseCache: 4,",
  ],
  "core/universe.js": [
    "async function _getAssetIndex(client = _coreClient) {",
    "const cache = state.universeAssetCache;",
    "state.universeAssetCache = { fetchedAt: new Date().toISOString(), assets, outsideIndex };",
    "persist('universeAssetCache');",
    "const assets = await _getAssetIndex(client);",
    "const outsideIndex = state.universeAssetCache?.outsideIndex;",
    "state.universeAssetCache = null;",
    "function _assetIndexBySymbol(assets) {",
    "_getAssetIndex(client),",
    "const assetsBySymbol = _assetIndexBySymbol(assetIndex);",
    "const assetIndex = await _getAssetIndex(client);",
    "const assetIndex = await _getAssetIndex(client);",
    "const assetIndex = await _getAssetIndex();",
    "const assetIndex = await _getAssetIndex(client);",
  ],
  "scripts/build-exit-model-dataset.mjs": [
    "eval(universeSrc + '\\nglobal._getAssetIndex = _getAssetIndex; global._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._isEligibleInstrument = _isEligibleInstrument; global.ALLOWED_EXCHANGES = ALLOWED_EXCHANGES; global._shiftDateStr = _shiftDateStr;');",
    "const assetIndex = await global._getAssetIndex(client);",
  ],
  "scripts/build-float-table.mjs": [
    "global.state = { settings: { alpacaKey: alpacaKeyId, alpacaSecret: alpacaSecretKey }, warriorEdgarCikMapCache: null, warriorFloatCache: null, universeAssetCache: null };",
    "eval(universeSrc + '\\nglobal._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._getAssetIndex = _getAssetIndex;');",
    "const assetIndex = await global._getAssetIndex(global._coreClient);",
  ],
  "scripts/log-signals-edge.mjs": [
    "universeAssetCache: null, // core/universe.js asset list, fetched once per run",
    "loadReal('core/universe.js', ['runEdgePrefilter', 'edgePrefilterFailures', 'getEdgeLiquidity', 'getAssetListing', '_getAssetIndex', '_fetchSipDailyBars']);",
  ],
  "scripts/log-signals-warrior.mjs": [
    "'_getAssetIndex', '_assetIndexBySymbol', '_inPriceRange', 'getUniverse',",
    "const [assetIndex] = await Promise.all([global._getAssetIndex(global._coreClient)]);",
    "const assetsBySymbol = global._assetIndexBySymbol(assetIndex);",
  ],
  "scripts/probe-survivorship-bias.mjs": [
    "eval(universeSrc + '\\nglobal._getAssetIndex = _getAssetIndex; global._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._rankTopMovers = _rankTopMovers; global._shiftDateStr = _shiftDateStr; global._isEligibleInstrument = _isEligibleInstrument; global.ALLOWED_EXCHANGES = ALLOWED_EXCHANGES;');",
    "const assetIndex = await global._getAssetIndex(global._coreClient);",
  ],
  "scripts/probe-topn-window.mjs": [
    "eval(universeSrc + '\\nglobal._getAssetIndex = _getAssetIndex; global._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._rankTopMovers = _rankTopMovers; global._shiftDateStr = _shiftDateStr;');",
    "const assetIndex = await global._getAssetIndex(global._coreClient);",
  ],
};
function uses() {
  const files = ['app.js', ...['core', 'engines', 'shell', 'scripts'].flatMap(d => {
    const dir = path.join(REPO_ROOT, d);
    if (!fs.existsSync(dir)) return [];
    const walk = q => fs.statSync(q).isDirectory() ? fs.readdirSync(q).flatMap(x => walk(path.join(q, x))) : [q];
    return walk(dir).filter(q => /\.(m?js)$/.test(q)).map(q => path.relative(REPO_ROOT, q).replace(/\\/g, '/'));
  })];
  const out = {};
  for (const f of [...new Set(files)]) {
    const lines = readSource(f).split('\n').filter(l => !/^\s*\/\//.test(l) && /_getAssetIndex\b|_assetIndexBySymbol\b|universeAssetCache\b/.test(l)).map(l => l.trim());
    if (lines.length) out[f] = lines;
  }
  return out;
}
run('ENUMERATED: every line that touches the cached index is identified, and every identified line still exists', () => {
  assert.deepStrictEqual(uses(), USES, 'a use of the cached index changed or is new: classify it (does it read name or exchange from the CACHE?) and identify its line here');
});

// 2026-11-18: the total is declared, so a case that never settles (or never starts) is a FAIL, not a silent early exit.
require('./_lib').expectTests(queue.length);
(async () => { for (const [n, f] of queue) await runNow(n, f); })();
