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

// ── dataQualityFlag ────────────────────────────────────────────────────

async function testDataQualityFlagsExtremeMoveWithoutVolumeSupport() {
  const { _rankTopMovers } = loadUniverse();
  const barsBySymbol = {
    // +900% day-over-day (0.50 -> 5.00) on perfectly ordinary volume
    // (1000, same as every prior day -- relVol 1x) -- exactly the
    // split-artifact shape, no real activity behind the move.
    SPLIT: [bar('2026-05-30', 0.50, 1000), bar('2026-06-01', 5.00, 1000)],
  };
  const symbolDays = _rankTopMovers(barsBySymbol, '2026-06-01', '2026-06-01', 10);
  const row = symbolDays.find(r => r.symbol === 'SPLIT');
  console.log('flagged row:', row);
  assert.ok(row.dataQualityFlag, 'an extreme move on unremarkable volume must be flagged');
  assert.strictEqual(row.dataQualityFlag.reason, 'extreme-move-without-volume-support');
  assert.ok(Math.abs(row.dataQualityFlag.dayOverDayPct - 9.0) < 0.01, 'the flag must carry the underlying numbers, not just a boolean');
  assert.strictEqual(row.dataQualityFlag.relVol, 1);
}

async function testDataQualityDoesNotFlagExtremeMoveWithVolumeSupport() {
  const { _rankTopMovers } = loadUniverse();
  const barsBySymbol = {
    // Same +900% move, but on 10x relative volume -- real activity, not
    // an artifact. Must NOT be flagged, let alone discarded: this is
    // exactly the explosive-day shape Warrior exists to trade.
    REAL: [bar('2026-05-30', 0.50, 1000), bar('2026-06-01', 5.00, 10000)],
  };
  const symbolDays = _rankTopMovers(barsBySymbol, '2026-06-01', '2026-06-01', 10);
  const row = symbolDays.find(r => r.symbol === 'REAL');
  console.log('unflagged row:', row);
  assert.strictEqual(row.dataQualityFlag, null, 'an extreme move WITH volume support must not be flagged — the flag is not a threshold on move size alone');
}

async function testDataQualityDoesNotFlagOrdinaryMoves() {
  const { _rankTopMovers } = loadUniverse();
  const barsBySymbol = {
    ORDINARY: [bar('2026-05-30', 5.00, 1000), bar('2026-06-01', 5.50, 1000)], // +10%, unremarkable
  };
  const symbolDays = _rankTopMovers(barsBySymbol, '2026-06-01', '2026-06-01', 10);
  const row = symbolDays.find(r => r.symbol === 'ORDINARY');
  assert.strictEqual(row.dataQualityFlag, null, 'an ordinary move must never be flagged, regardless of volume');
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

// ── lagSelectionByOneDay (2026-09-01, lookahead fix) ─────────────────────

async function testLagSelectionRanksDayDByDayDMinus1sMoveNotItsOwn() {
  const { _rankTopMovers } = loadUniverse();
  // AAA: huge move ON day D (2026-06-02), flat the day before -- selected
  // under default (same-day) ranking, must NOT be selected once ranking
  // is lagged to D-1, since D-1 (2026-06-01) was flat.
  // BBB: huge move ON day D-1 (2026-06-01), flat on day D itself -- the
  // mirror image: must NOT be selected by default ranking (D's own move
  // is flat) but MUST be selected once ranking is lagged to D-1.
  // Volume also distinguishes D-1 on purpose (not just price): AAA's D-1
  // is flat on BOTH metrics, BBB's D-1 is elevated on BOTH -- otherwise a
  // relVol tie (both at 1x) would let AAA back in through the relVol
  // half of the union via stable-sort tie-break order, which isn't what
  // this test is checking.
  const barsBySymbol = {
    AAA: [bar('2026-05-30', 5.00, 1000), bar('2026-06-01', 5.02, 1000), bar('2026-06-02', 8.00, 1000)], // D-1: +0.4% on 1x volume; D: +59%
    BBB: [bar('2026-05-30', 5.00, 1000), bar('2026-06-01', 8.00, 9000), bar('2026-06-02', 8.02, 1000)], // D-1: +60% on 9x volume; D: +0.25%
  };
  const defaultRanking = _rankTopMovers(barsBySymbol, '2026-06-02', '2026-06-02', 1); // top-1 by move
  const laggedRanking = _rankTopMovers(barsBySymbol, '2026-06-02', '2026-06-02', 1, { lagSelectionByOneDay: true });
  console.log('default (same-day) ranking selects:', defaultRanking.map(r => r.symbol), '| lagged (D-1) ranking selects:', laggedRanking.map(r => r.symbol));
  assert.deepStrictEqual(defaultRanking.map(r => r.symbol).sort(), ['AAA'], 'default mode must select AAA -- it moved ON day D');
  assert.deepStrictEqual(laggedRanking.map(r => r.symbol).sort(), ['BBB'], 'lagged mode must select BBB -- it moved on D-1, known before D opens; AAA\'s D-1 was flat');
}

async function testLagSelectionStillReportsDayDsOwnCloseAndVolumeNotDayDMinus1s() {
  const { _rankTopMovers } = loadUniverse();
  const barsBySymbol = {
    BBB: [bar('2026-05-30', 5.00, 1000), bar('2026-06-01', 8.00, 5000), bar('2026-06-02', 9.50, 2000)],
  };
  const [row] = _rankTopMovers(barsBySymbol, '2026-06-02', '2026-06-02', 10, { lagSelectionByOneDay: true });
  console.log('lagged-mode row (must carry day D\'s own close/volume, not D-1\'s):', row);
  assert.strictEqual(row.date, '2026-06-02', 'the row IS day D -- that\'s the day being replayed');
  assert.strictEqual(row.close, 9.50, 'close must be day D\'s own close (used for the $1-$20 filter and downstream replay), never D-1\'s, regardless of selection mode');
  assert.strictEqual(row.volume, 2000, 'volume must be day D\'s own volume, not the D-1 volume used only for selection');
}

(async () => {
  await run('universe: lagSelectionByOneDay ranks day D by day D-1\'s move, not its own', testLagSelectionRanksDayDByDayDMinus1sMoveNotItsOwn);
  await run('universe: lagSelectionByOneDay still reports day D\'s own close/volume', testLagSelectionStillReportsDayDsOwnCloseAndVolumeNotDayDMinus1s);
  await run('universe: _shiftDateStr is pure calendar arithmetic (year/month boundaries)', testShiftDateStrPureCalendarArithmetic);
  await run('universe: _rankTopMovers computes dayOverDayPct and relVol correctly', testRankTopMoversComputesDayOverDayAndRelVol);
  await run('universe: dataQualityFlag flags an extreme move without volume support', testDataQualityFlagsExtremeMoveWithoutVolumeSupport);
  await run('universe: dataQualityFlag does not flag an extreme move WITH volume support', testDataQualityDoesNotFlagExtremeMoveWithVolumeSupport);
  await run('universe: dataQualityFlag does not flag an ordinary move', testDataQualityDoesNotFlagOrdinaryMoves);
  await run('universe: _rankTopMovers filters to $1-$20 before ranking, not after', testRankTopMoversFiltersToOneToTwentyDollarsBeforeRanking);
  await run('universe: _rankTopMovers unions top-N by each metric, not a single combined score', testRankTopMoversUnionsTopNByEachMetricNotJustOne);
  await run('universe: _rankTopMovers excludes lookback-only days from the ranked output', testRankTopMoversExcludesDaysOutsideTheRankedRangeEvenWhenBarsExist);
})();
