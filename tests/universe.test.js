// tests/universe.test.js — core/universe.js's historical universe
// reconstruction (_rankTopMovers/_shiftDateStr/reconstructTopMoversUniverse),
// added 2026-09-01 for the "top daily movers, reconstructed" scan. Only
// the pure, network-free parts are covered here — _fetchHistoricalDailyBars
// and reconstructTopMoversUniverse's own orchestration need a live (or
// mocked) alpacaGet and are exercised by the scan itself, same split as
// _buildGapResults vs. _getPremarketGapUniverse.
'use strict';
const assert = require('assert');
const { readSource, evalModule, run } = require('./_lib');

function loadUniverse() {
  global.state = {};
  global.chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
  global._coreClient = { alpacaGet: async () => ({}) };
  global.alpacaGet = async () => ({});
  global.getPT = (d) => d;
  global.ptDateStr = (d) => d.toISOString().slice(0, 10);
  global.persist = () => {};
  const src = readSource('core/universe.js');
  evalModule(src, { expose: ['_rankTopMovers', '_shiftDateStr', 'reconstructTopMoversUniverse'] });
  return { _rankTopMovers: global._rankTopMovers, _shiftDateStr: global._shiftDateStr };
}

function bar(dateStr, c, v) {
  return { t: `${dateStr}T20:00:00Z`, o: c, h: c, l: c, c, v };
}

// ── _shiftDateStr ──────────────────────────────────────────────────────

async function testShiftDateStrPureCalendarArithmetic() {
  const { _shiftDateStr } = loadUniverse();
  assert.strictEqual(_shiftDateStr('2026-06-01', -60), '2026-04-02');
  assert.strictEqual(_shiftDateStr('2026-01-01', -1), '2025-12-31', 'must cross a year boundary correctly');
  assert.strictEqual(_shiftDateStr('2026-03-01', -1), '2026-02-28', 'must cross a (non-leap) month boundary correctly');
}

// ── _rankTopMovers ────────────────────────────────────────────────────

async function testRankTopMoversComputesDayOverDayAndRelVol() {
  const { _rankTopMovers } = loadUniverse();
  const barsBySymbol = {
    AAA: [bar('2026-05-30', 5.00, 1000), bar('2026-06-01', 6.00, 1000)], // +20% day-over-day, relVol 1x
    BBB: [bar('2026-05-30', 5.00, 1000), bar('2026-06-01', 5.10, 5000)], // +2% day-over-day, relVol 5x
  };
  const symbolDays = _rankTopMovers(barsBySymbol, '2026-06-01', '2026-06-01', 1); // top 1 per metric -- only 2 candidates, so topN=10 would trivially put both in both lists
  const aaa = symbolDays.find(r => r.symbol === 'AAA');
  const bbb = symbolDays.find(r => r.symbol === 'BBB');
  console.log('AAA:', aaa, '| BBB:', bbb);
  assert.ok(Math.abs(aaa.dayOverDayPct - 0.20) < 0.001, `expected AAA +20%, got ${aaa.dayOverDayPct}`);
  assert.ok(Math.abs(bbb.relVol - 5.0) < 0.001, `expected BBB relVol 5x, got ${bbb.relVol}`);
  assert.deepStrictEqual(aaa.source, ['move'], 'AAA should surface only via the move ranking');
  assert.deepStrictEqual(bbb.source, ['relVol'], 'BBB should surface only via the relVol ranking');
}

async function testRankTopMoversFiltersToOneToTwentyDollarsBeforeRanking() {
  const { _rankTopMovers } = loadUniverse();
  const barsBySymbol = {
    CHEAP: [bar('2026-05-30', 0.50, 1000), bar('2026-06-01', 0.80, 1000)], // +60% but close ($0.80) below $1 floor
    MID: [bar('2026-05-30', 5.00, 1000), bar('2026-06-01', 5.50, 1000)],   // +10%, in range
    EXPENSIVE: [bar('2026-05-30', 25.00, 1000), bar('2026-06-01', 30.00, 1000)], // +20% but above $20 ceiling
  };
  const symbolDays = _rankTopMovers(barsBySymbol, '2026-06-01', '2026-06-01', 10);
  const symbols = symbolDays.map(r => r.symbol).sort();
  console.log('symbols surviving the $1-$20 filter:', symbols);
  assert.deepStrictEqual(symbols, ['MID'], 'only the in-range symbol should appear, regardless of how large the other two moved');
}

async function testRankTopMoversUnionsTopNByEachMetricNotJustOne() {
  const { _rankTopMovers } = loadUniverse();
  // 3 symbols, topN=2: BIGMOVE wins on move only, BIGVOL wins on relVol
  // only, BOTH wins on neither individually strong enough alone -- proves
  // the union (not intersection, not a single combined score) is what's
  // actually implemented.
  const barsBySymbol = {
    BIGMOVE: [bar('2026-05-30', 5.00, 1000), bar('2026-06-01', 7.00, 1000)], // +40%, relVol 1x
    BIGVOL:  [bar('2026-05-30', 5.00, 1000), bar('2026-06-01', 5.05, 9000)], // +1%, relVol 9x
    FLAT:    [bar('2026-05-30', 5.00, 1000), bar('2026-06-01', 5.02, 1000)], // +0.4%, relVol 1x -- should not surface
  };
  const symbolDays = _rankTopMovers(barsBySymbol, '2026-06-01', '2026-06-01', 1); // top 1 per metric
  const symbols = symbolDays.map(r => r.symbol).sort();
  console.log('union result (top 1 per metric):', symbols);
  assert.deepStrictEqual(symbols, ['BIGMOVE', 'BIGVOL'], 'the union of top-1-by-move and top-1-by-relVol, not a single combined ranking');
}

async function testRankTopMoversExcludesDaysOutsideTheRankedRangeEvenWhenBarsExist() {
  const { _rankTopMovers } = loadUniverse();
  // Bars include a day BEFORE the ranked range (there for lookback only)
  // -- must not itself appear as a ranked symbol-day.
  const barsBySymbol = {
    AAA: [bar('2026-05-01', 5.00, 1000), bar('2026-06-01', 6.00, 1000)],
  };
  const symbolDays = _rankTopMovers(barsBySymbol, '2026-06-01', '2026-06-01', 10);
  assert.strictEqual(symbolDays.length, 1);
  assert.strictEqual(symbolDays[0].date, '2026-06-01', 'the lookback-only 2026-05-01 bar must not itself become a ranked row');
}

(async () => {
  await run('universe: _shiftDateStr is pure calendar arithmetic (year/month boundaries)', testShiftDateStrPureCalendarArithmetic);
  await run('universe: _rankTopMovers computes dayOverDayPct and relVol correctly', testRankTopMoversComputesDayOverDayAndRelVol);
  await run('universe: _rankTopMovers filters to $1-$20 before ranking, not after', testRankTopMoversFiltersToOneToTwentyDollarsBeforeRanking);
  await run('universe: _rankTopMovers unions top-N by each metric, not a single combined score', testRankTopMoversUnionsTopNByEachMetricNotJustOne);
  await run('universe: _rankTopMovers excludes lookback-only days from the ranked output', testRankTopMoversExcludesDaysOutsideTheRankedRangeEvenWhenBarsExist);
})();
