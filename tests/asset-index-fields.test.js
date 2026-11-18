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
  eval(readSource('core/clock.js') + '\nglobal.getPT = getPT; global.ptDateStr = ptDateStr; global.previousTradingDay = previousTradingDay; global.isTradingDay = isTradingDay;');
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
  global.getLivePrice = snap => snap.dailyBar?.c || snap.latestTrade?.p;
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
const REGISTRY = {
  // file: number of uses (calls of _getAssetIndex / _assetIndexBySymbol, mentions of universeAssetCache), outside comments
  'app.js': 2, // the state declaration and the persisted-keys load list
  'core/universe.js': 14, // _getAssetIndex, its six consumers (EXECUTED above), _assetIndexBySymbol, getAssetListing
  'core/store.js': 1, // its persist tier
  'scripts/build-exit-model-dataset.mjs': 3, // eval export, one call (SCRIPTS above)
  'scripts/build-float-table.mjs': 4,
  'scripts/probe-survivorship-bias.mjs': 3,
  'scripts/probe-topn-window.mjs': 3,
  'scripts/log-signals-edge.mjs': 2, // its state stub and loadReal list: reaches the index only via getAssetListing (EXECUTED)
  'scripts/log-signals-warrior.mjs': 4, // loadReal list, one call, _assetIndexBySymbol (SCRIPTS above)
};
function uses() {
  const files = ['app.js', ...['core', 'engines', 'shell', 'scripts', 'scripts/lib'].flatMap(d => {
    const dir = path.join(REPO_ROOT, d);
    if (!fs.existsSync(dir)) return [];
    const walk = p => fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap(x => walk(path.join(p, x))) : [p];
    return walk(dir).filter(p => /\.(m?js)$/.test(p)).map(p => path.relative(REPO_ROOT, p).replace(/\\/g, '/'));
  })];
  const out = {};
  for (const f of [...new Set(files)]) {
    const n = readSource(f).split('\n').filter(l => !/^\s*\/\//.test(l))
      .reduce((a, l) => a + (l.match(/_getAssetIndex\b|_assetIndexBySymbol\b|universeAssetCache\b/g) || []).length, 0);
    if (n) out[f] = n;
  }
  return out;
}
run('ENUMERATED: every use of the cached index is classified, and every classification still has its uses', () => {
  const found = uses();
  const problems = [];
  for (const [f, n] of Object.entries(found)) if (REGISTRY[f] !== n) problems.push(`${f}: ${n} use(s) in code, ${REGISTRY[f] || 0} classified`);
  for (const f of Object.keys(REGISTRY)) if (!found[f]) problems.push(`${f}: classified, no use in code any more`);
  assert.deepStrictEqual(problems, [], 'classify the new consumer (does it read name or exchange from the CACHE?) and update REGISTRY:\n  ' + problems.join('\n  '));
});

// 2026-11-18: the total is declared, so a case that never settles (or never starts) is a FAIL, not a silent early exit.
require('./_lib').expectTests(queue.length);
(async () => { for (const [n, f] of queue) await runNow(n, f); })();
