// tests/minute-bars-two-tier.test.js — core/universe.js's
// _fetchLatestSipMinuteBars two-tier fetch (45min pass 1, 3h pass 2
// fallback) and _getPremarketGapUniverse's instrument-filter fix.
//
// Covers two bugs found live 2026-08-24:
//   - Problem 1: _getPremarketGapUniverse used to take every
//     tradable/exchange symbol regardless of isEligibleInstrument,
//     letting warrants/units/leveraged ETFs (BTDL, HQWWW, FVNNU) reach the
//     ranked result.
//   - Problem 2: the single 3h-window fetch took ~1,329 requests / 5.7min
//     for a ~3,854-symbol run. Fixed with a two-tier fetch: 45min window
//     (provably single-page at limit:10000) for everyone, then a 3h
//     fallback pass only for symbols pass 1 found nothing for. Anything
//     still missing after both passes must be surfaced, not silently
//     dropped (same pattern as fetchMultiBars' Bug 3 droppedSymbols).
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

function loadUniverse(alpacaGetMock) {
  global.state = { universeAssetCache: null, universePriorCloseCache: null };
  global.persist = () => {};
  global.getPT = () => new Date('2026-08-24T13:00:00Z');
  global.ptDateStr = () => '2026-08-24';
  global.getMarketStatus = () => ({ status: 'OPEN' });
  global.chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
  global.alpacaGet = alpacaGetMock;
  const src = readSource('core/universe.js').replace(/^const ALPACA_TRADING_BASE.*$/m, "const ALPACA_TRADING_BASE = 'https://paper-api.alpaca.markets';");
  const exposeCode = 'global.__getPremarketGapUniverse = _getPremarketGapUniverse; global.__diagnosePremarketGap = diagnosePremarketGap;';
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeCode);
  return { _getPremarketGapUniverse: global.__getPremarketGapUniverse, diagnosePremarketGap: global.__diagnosePremarketGap };
}

function buildFixture() {
  // 250 symbols: 240 eligible instruments, 10 warrant-shaped (ineligible).
  const allAssets = [];
  for (let i = 0; i < 240; i++) allAssets.push({ symbol: `GOOD${i}`, exchange: 'NASDAQ', tradable: true, name: `Good Co ${i} Common Stock` });
  for (let i = 0; i < 10; i++) allAssets.push({ symbol: `WARR${i}`, exchange: 'NASDAQ', tradable: true, name: `Bad Co ${i} Warrants` });

  // Of the 240 eligible, the first 150 have a prior close in $1-$20.
  const priorCloseMap = {};
  allAssets.forEach((a, i) => {
    if (a.symbol.startsWith('GOOD') && i < 150) priorCloseMap[a.symbol] = 5 + (i % 10);
    else if (a.symbol.startsWith('WARR')) priorCloseMap[a.symbol] = 5; // in-range too, so the filter bug (if reintroduced) would let these through
  });
  const priceFilteredSymbols = Object.keys(priorCloseMap).filter(s => s.startsWith('GOOD'));

  // Pass 1 (45min) finds a bar for all but 5 symbols. Of those 5, pass 2
  // (3h) recovers 3, leaving 2 genuinely missing after both passes.
  const missingFromPass1 = priceFilteredSymbols.slice(0, 5);
  const recoveredInPass2 = missingFromPass1.slice(0, 3);

  const callLog = [];
  const alpacaGetMock = async (path, params) => {
    callLog.push({ path, params: { ...params } });
    if (path === '/v2/assets') return allAssets;
    if (path === '/stocks/bars' && params.feed === 'iex') {
      const syms = params.symbols.split(',');
      const bars = {};
      syms.forEach(s => { if (priorCloseMap[s] != null) bars[s] = [{ c: priorCloseMap[s] }]; });
      return { bars, next_page_token: null };
    }
    if (path === '/stocks/bars' && params.feed === 'sip') {
      const syms = params.symbols.split(',');
      const windowMin = Math.round((new Date(params.end) - new Date(params.start)) / 60000);
      const bars = {};
      syms.forEach(s => {
        if (windowMin === 45 && !missingFromPass1.includes(s)) bars[s] = [{ c: 6, v: 100 }];
        if (windowMin === 180 && recoveredInPass2.includes(s)) bars[s] = [{ c: 6, v: 100 }];
      });
      return { bars, next_page_token: null };
    }
    throw new Error('unexpected call: ' + path + ' ' + JSON.stringify(params));
  };

  return { allAssets, priorCloseMap, priceFilteredSymbols, missingFromPass1, recoveredInPass2, callLog, alpacaGetMock };
}

async function testInstrumentFilterAppliedToPremarketGap() {
  const { alpacaGetMock } = buildFixture();
  const { _getPremarketGapUniverse } = loadUniverse(alpacaGetMock);
  const result = await _getPremarketGapUniverse();
  const anyIneligible = result.some(r => r.symbol.startsWith('WARR'));
  console.log(`Result count: ${result.length}, any WARR* (ineligible) symbols present: ${anyIneligible}`);
  assert.strictEqual(anyIneligible, false, 'ineligible-instrument symbols (WARR*) reached the premarket-gap result — Problem 1 regressed');
}

async function testTwoTierCoverageAndMissingSurfaced() {
  const fixture = buildFixture();
  const { diagnosePremarketGap } = loadUniverse(fixture.alpacaGetMock);
  const diag = await diagnosePremarketGap();

  console.log('tradableCount:', diag.tradableCount, '| eligibleCount:', diag.eligibleCount, '| priceFilteredCount:', diag.priceFilteredCount);
  console.log('missingAfterBothPasses:', diag.missingAfterBothPasses, '| coverageRate:', diag.coverageRate);
  console.log('requests:', diag.requests);

  assert.strictEqual(diag.tradableCount, 250);
  assert.strictEqual(diag.eligibleCount, 240, 'WARR* symbols should be excluded before price filtering');
  assert.strictEqual(diag.priceFilteredCount, 150);
  assert.strictEqual(diag.missingAfterBothPasses, 2, 'expected exactly 2 symbols (GOOD3, GOOD4) to remain missing after both passes');
  assert.ok(Math.abs(diag.coverageRate - 148 / 150) < 0.001);

  // pass2 must only re-request the symbols pass 1 missed (5), not the whole
  // 150 — this is the whole cost-saving point of the two-tier design.
  const pass2Calls = fixture.callLog.filter(c => c.path === '/stocks/bars' && c.params.feed === 'sip' && Math.round((new Date(c.params.end) - new Date(c.params.start)) / 60000) === 180);
  const pass2SymbolCount = pass2Calls.reduce((n, c) => n + c.params.symbols.split(',').length, 0);
  console.log('pass2 symbols requested:', pass2SymbolCount, '(expected 5, not 150)');
  assert.strictEqual(pass2SymbolCount, 5, 'pass 2 re-requested more than just the symbols pass 1 missed');

  // Phase 1 acceptance #2 ("no alphabetical bias") — letterDistribution
  // must actually be present and its counts must sum to resultCount, or
  // the diagnostic's distribution line would be silently wrong/incomplete.
  console.log('letterDistribution:', diag.letterDistribution);
  assert.ok(diag.letterDistribution && typeof diag.letterDistribution === 'object', 'letterDistribution missing from diagnosePremarketGap result');
  const letterSum = Object.values(diag.letterDistribution).reduce((a, b) => a + b, 0);
  assert.strictEqual(letterSum, diag.resultCount, 'letterDistribution counts do not sum to resultCount');
  // Fixture symbols are all "GOOD..." -> everything should land under 'G'.
  assert.strictEqual(diag.letterDistribution.G, diag.resultCount, 'expected all fixture results under letter G');
}

(async () => {
  await run('minute-bars-two-tier: instrument filter applied to premarket-gap (Problem 1)', testInstrumentFilterAppliedToPremarketGap);
  await run('minute-bars-two-tier: two-tier coverage, missing symbols surfaced, pass2 scoped correctly (Problem 2)', testTwoTierCoverageAndMissingSurfaced);
})();
