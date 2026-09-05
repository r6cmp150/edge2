// tests/float-table.test.js — core/float-table.js, the client-side static
// float table lookup (2026-09-04) that replaces core/edgar.js's live
// client-side fetch, which a real boot check proved CORS-blocks entirely
// (see core/edgar.js's own header). This file covers the interface
// gate.js actually depends on: the fetch-once-per-page-load cache, the
// four table-entry statuses mapping to the right floatBySymbol shape, the
// "not in table at all" case being kept DISTINCT from "in table, no
// filing" (2026-09-04 explicit requirement — collapsing them hides a
// build-coverage gap), and a table-fetch failure blocking rather than
// silently reading as not-checked.
'use strict';
const assert = require('assert');
const { readSource, run, evalModule } = require('./_lib');

function loadFloatTable(fetchMock, dateStr) {
  global.getPT = () => new Date(`${dateStr}T13:00:00Z`);
  global.ptDateStr = () => dateStr;
  global.fetch = fetchMock;
  const src = readSource('core/float-table.js');
  const exposeCode = 'global.__getFloatDataForSymbols = getFloatDataForSymbols;';
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeCode);
  return { getFloatDataForSymbols: global.__getFloatDataForSymbols };
}

function tableResponse(table) {
  return { ok: true, status: 200, json: async () => table };
}

// Loads core/float-table.js against the REAL core/clock.js getPT/ptDateStr
// (not the argument-ignoring mocks loadFloatTable above uses) -- required
// to actually exercise the staleness bug/fix below. The bug (2026-09-04,
// found live in a boot check: "(-1d ago)" on a table built THAT SAME PT
// day) only manifests when getPT is called with an EXPLICIT argument
// (table.builtAt's instant) and correctly converts it to ITS OWN PT
// calendar date -- a mock that ignores its argument can't catch a
// regression back to the buggy comparison, since it would make every
// case trivially compute the same (wrong-for-the-wrong-reason) answer.
// getPT is wrapped so calling it with no argument (as "now") returns a
// FIXED, test-controlled instant instead of the real `new Date()`, while
// an explicit argument (as used for table.builtAt) still passes through
// to the real implementation unchanged.
function loadFloatTableWithRealClock(fetchMock, nowIso) {
  evalModule(readSource('core/clock.js'), { expose: ['getPT', 'ptDateStr'] });
  const realGetPT = global.getPT;
  global.getPT = (date) => realGetPT(date === undefined ? new Date(nowIso) : date);
  global.fetch = fetchMock;
  const src = readSource('core/float-table.js');
  const exposeCode = 'global.__getFloatDataForSymbols = getFloatDataForSymbols;';
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeCode);
  return { getFloatDataForSymbols: global.__getFloatDataForSymbols };
}

async function _stalenessFor(nowIso, builtAtIso) {
  const table = { builtAt: builtAtIso, bySymbol: {} };
  const mock = async () => tableResponse(table);
  const { getFloatDataForSymbols } = loadFloatTableWithRealClock(mock, nowIso);
  const { tableStalenessDays } = await getFloatDataForSymbols([]);
  return tableStalenessDays;
}

async function testTableStalenessZeroDaysSameBuiltDay() {
  // The exact reported bug: built earlier the SAME PT calendar day as
  // "now" must read 0, never negative. 2026-09-04T16:31:47Z = 9:31 AM PDT
  // (PT is UTC-7 in September); "now" is 1:00 PM PDT the same PT date.
  const days = await _stalenessFor('2026-09-04T20:00:00.000Z', '2026-09-04T16:31:47.496Z');
  console.log('staleness, built earlier same PT day:', days);
  assert.strictEqual(days, 0);
}

async function testTableStalenessOneDay() {
  const days = await _stalenessFor('2026-09-04T20:00:00.000Z', '2026-09-03T16:31:47.496Z');
  console.log('staleness, built 1 PT day earlier:', days);
  assert.strictEqual(days, 1);
}

async function testTableStalenessFourteenDays() {
  const days = await _stalenessFor('2026-09-04T20:00:00.000Z', '2026-08-21T16:31:47.496Z');
  console.log('staleness, built 14 PT days earlier:', days);
  assert.strictEqual(days, 14);
}

async function testTableStalenessMidnightPTBoundary() {
  // Built 00:01 AM PT on 9/4 (07:01 UTC, PDT = UTC-7). "Now" at 23:59 PM PT
  // the SAME calendar day (9/4) -- nearly 24 real hours later -- must still
  // read 0. One real minute later, once PT midnight has actually passed
  // into 9/5, must read 1. This is the boundary the calendar-date
  // (not elapsed-real-time) semantics exists to get right.
  const builtAt = '2026-09-04T07:01:00.000Z';
  const justBeforeMidnight = await _stalenessFor('2026-09-05T06:59:00.000Z', builtAt); // 23:59 PT on 9/4
  const justAfterMidnight = await _stalenessFor('2026-09-05T07:01:00.000Z', builtAt); // 00:01 PT on 9/5
  console.log('staleness just before PT midnight:', justBeforeMidnight, '| just after:', justAfterMidnight);
  assert.strictEqual(justBeforeMidnight, 0, 'still the same PT calendar day as the build, despite ~23h58m of real elapsed time');
  assert.strictEqual(justAfterMidnight, 1, 'crossed into the next PT calendar day, despite only ~2 minutes of real elapsed time since the previous check');
}

async function testFetchesTableOnceThenCachesForTheSession() {
  let fetchCalls = 0;
  const table = { builtAt: '2026-09-01T00:00:00.000Z', bySymbol: { A: { status: 'value', impliedFloatShares: 1_000_000, referenceDate: '2026-09-01' } } };
  const mock = async () => { fetchCalls++; return tableResponse(table); };
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  await getFloatDataForSymbols(['A']);
  await getFloatDataForSymbols(['A']);
  console.log('fetch() calls across two lookups:', fetchCalls);
  assert.strictEqual(fetchCalls, 1, 'the table must be fetched once and reused, not once per getFloatDataForSymbols call');
}

async function testValueEntryProducesPassFailShape() {
  const table = { builtAt: '2026-09-01T00:00:00.000Z', bySymbol: { DAIC: { status: 'value', impliedFloatShares: 1_169_024, referenceDate: '2026-03-10', sharesOutstandingAtCheck: 30_259_579 } } };
  const mock = async () => tableResponse(table);
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  const { floatBySymbol } = await getFloatDataForSymbols(['DAIC']);
  console.log('value entry result:', floatBySymbol.DAIC);
  assert.strictEqual(floatBySymbol.DAIC.impliedFloatShares, 1_169_024);
  assert.strictEqual(floatBySymbol.DAIC.referenceDate, '2026-03-10');
  assert.strictEqual(floatBySymbol.DAIC.stalenessDays, 178, '2026-09-04 minus 2026-03-10');
}

async function testStalenessIsShownButNoLongerAHardBound() {
  // ADDED then DROPPED the same day (2026-09-04): a 180-day hard bound was
  // built after BIAF/GRI passed the gate on 431-day-old filings, then
  // dropped once re-measurement showed it collapsed backtest coverage to
  // 1.2% while the REAL fix (core/edgar.js's dilution correction) was
  // available and does the actual job the bound was only proxying for --
  // see core/float-table.js's header for the full trace. A value far
  // beyond the old 180-day figure (431 days, BIAF's own real staleness)
  // must still surface as a number, with its age shown, not blocked.
  const table = { builtAt: '2026-09-01T00:00:00.000Z', bySymbol: { BIAF: { status: 'value', impliedFloatShares: 22_394_073, referenceDate: '2025-06-30', dilutionCorrected: true } } };
  const mock = async () => tableResponse(table);
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  const { floatBySymbol } = await getFloatDataForSymbols(['BIAF']);
  console.log('431-days-old (no bound) result:', floatBySymbol.BIAF);
  assert.strictEqual(floatBySymbol.BIAF.impliedFloatShares, 22_394_073, 'age alone must never block a value now -- the dilution correction and the volume-consistency backstop are the real checks');
  assert.strictEqual(floatBySymbol.BIAF.stalenessDays, 431, '2026-09-04 minus 2025-06-30 -- age is still SHOWN, just not a gate');
  assert.strictEqual(floatBySymbol.BIAF.dilutionCorrected, true);
}

async function testDiscardedEntryCarriesItsSpecificReason() {
  const table = { builtAt: '2026-09-01T00:00:00.000Z', bySymbol: { AAPL: { status: 'discarded', reason: 'implied float (15,022,537,748) exceeds shares outstanding (14,594,180,000) — value discarded as invalid' } } };
  const mock = async () => tableResponse(table);
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  const { floatBySymbol } = await getFloatDataForSymbols(['AAPL']);
  console.log('discarded entry result:', floatBySymbol.AAPL);
  assert.strictEqual(floatBySymbol.AAPL.impliedFloatShares, null);
  assert.match(floatBySymbol.AAPL.invalidReason, /exceeds shares outstanding/);
}

async function testNoFilingEntryHasItsOwnReason() {
  const table = { builtAt: '2026-09-01T00:00:00.000Z', bySymbol: { XYZ: { status: 'no-filing' } } };
  const mock = async () => tableResponse(table);
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  const { floatBySymbol } = await getFloatDataForSymbols(['XYZ']);
  assert.match(floatBySymbol.XYZ.invalidReason, /no EntityPublicFloat filing/i);
}

async function testUnmappedEntryHasItsOwnReason() {
  const table = { builtAt: '2026-09-01T00:00:00.000Z', bySymbol: { GHOST: { status: 'unmapped' } } };
  const mock = async () => tableResponse(table);
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  const { floatBySymbol } = await getFloatDataForSymbols(['GHOST']);
  assert.match(floatBySymbol.GHOST.invalidReason, /no SEC CIK mapping/i);
}

async function testNoPriceDataEntryCarriesItsOwnReason() {
  // Reclassified 2026-09-04 (see core/edgar.js's header) -- permanent for
  // that filing, not a build failure, but also NOT the same claim as
  // "no filing" -- must carry its own distinct reason.
  const table = { builtAt: '2026-09-01T00:00:00.000Z', bySymbol: { GFUZ: { status: 'no-price-data', reason: "no historical price data available near the float's reference date (2025-06-30) — the company may not have been publicly traded yet at that time" } } };
  const mock = async () => tableResponse(table);
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  const { floatBySymbol } = await getFloatDataForSymbols(['GFUZ']);
  console.log('no-price-data result:', floatBySymbol.GFUZ);
  assert.strictEqual(floatBySymbol.GFUZ.impliedFloatShares, null);
  assert.match(floatBySymbol.GFUZ.invalidReason, /no historical price data/i);
}

async function testInvalidReferenceDateEntryCarriesItsOwnReason() {
  const table = { builtAt: '2026-09-01T00:00:00.000Z', bySymbol: { NATH: { status: 'invalid-reference-date', reason: 'float reference date (2026-09-26) is after today (2026-09-04) — a data-integrity issue in the SEC filing, not a missing price' } } };
  const mock = async () => tableResponse(table);
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  const { floatBySymbol } = await getFloatDataForSymbols(['NATH']);
  assert.strictEqual(floatBySymbol.NATH.impliedFloatShares, null);
  assert.match(floatBySymbol.NATH.invalidReason, /after today/i);
}

async function testSymbolNotInTableAtAllHasADistinctReasonFromNoFiling() {
  // The 2026-09-04 requirement: "not in the table at all" must never read
  // the same as "in table, confirmed no filing" -- it's the signal that
  // the weekly build is missing coverage for this symbol (new listing or
  // a build-time failure), which "no filing" would hide.
  const table = { builtAt: '2026-09-01T00:00:00.000Z', bySymbol: { XYZ: { status: 'no-filing' } } }; // NEWLISTING absent entirely
  const mock = async () => tableResponse(table);
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  const { floatBySymbol } = await getFloatDataForSymbols(['NEWLISTING']);
  console.log('not-in-table result:', floatBySymbol.NEWLISTING);
  assert.strictEqual(floatBySymbol.NEWLISTING.impliedFloatShares, null);
  assert.match(floatBySymbol.NEWLISTING.invalidReason, /not in this week's float table/i);
  assert.ok(!/no EntityPublicFloat filing/i.test(floatBySymbol.NEWLISTING.invalidReason), 'must NOT reuse the "no filing" wording -- it is a structurally different claim');
}

async function testTableFetchFailureBlocksEverySymbolRequested() {
  const mock = async () => { throw new Error('simulated network failure'); };
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  const { floatBySymbol, failedSymbols } = await getFloatDataForSymbols(['A', 'B']);
  console.log('table-fetch-failure result:', { floatBySymbol, failedSymbols });
  assert.deepStrictEqual(Object.keys(floatBySymbol), []);
  assert.deepStrictEqual(failedSymbols.sort(), ['A', 'B'], 'a real fetch failure must block every requested symbol (fetch-failed/BLOCKED), not silently read as not-checked');
}

async function testTableFetchNonOkResponseAlsoBlocks() {
  const mock = async () => ({ ok: false, status: 500 });
  const { getFloatDataForSymbols } = loadFloatTable(mock, '2026-09-04');
  const { failedSymbols } = await getFloatDataForSymbols(['A']);
  assert.ok(failedSymbols.includes('A'));
}

async function testTableBuiltAtAndStalenessSurfaceToTheCaller() {
  // Uses the real-clock helper, not the argument-ignoring mock (2026-09-04)
  // -- the mock can't distinguish table.builtAt's actual calendar date from
  // "today" at all, which would make this pass for the wrong reason (or
  // regress silently) once tableStalenessDays actually routes through
  // getPT/ptDateStr. builtAt's instant (09:31 AM PDT, well after PT
  // midnight) deliberately mirrors the exact shape of the reported bug.
  const table = { builtAt: '2026-09-01T16:31:47.496Z', bySymbol: {} };
  const mock = async () => tableResponse(table);
  const { getFloatDataForSymbols } = loadFloatTableWithRealClock(mock, '2026-09-04T20:00:00.000Z');
  const { tableBuiltAt, tableStalenessDays } = await getFloatDataForSymbols(['A']);
  console.log('table provenance:', { tableBuiltAt, tableStalenessDays });
  assert.strictEqual(tableBuiltAt, '2026-09-01T16:31:47.496Z');
  assert.strictEqual(tableStalenessDays, 3, '2026-09-04 minus 2026-09-01, both PT calendar dates');
}

(async () => {
  await run('float-table: fetches the table once, caches it for the session', testFetchesTableOnceThenCachesForTheSession);
  await run('float-table: a value entry produces the pass/fail shape gate.js expects', testValueEntryProducesPassFailShape);
  await run('float-table: staleness is shown but no longer a hard bound (dropped 2026-09-04, see header)', testStalenessIsShownButNoLongerAHardBound);
  await run('float-table: a discarded entry carries its specific guard reason', testDiscardedEntryCarriesItsSpecificReason);
  await run('float-table: a no-filing entry has its own reason', testNoFilingEntryHasItsOwnReason);
  await run('float-table: an unmapped entry has its own reason', testUnmappedEntryHasItsOwnReason);
  await run('float-table: a no-price-data entry carries its own reason', testNoPriceDataEntryCarriesItsOwnReason);
  await run('float-table: an invalid-reference-date entry carries its own reason', testInvalidReferenceDateEntryCarriesItsOwnReason);
  await run('float-table: a symbol not in the table at all has a reason distinct from "no filing"', testSymbolNotInTableAtAllHasADistinctReasonFromNoFiling);
  await run('float-table: a table fetch failure blocks every requested symbol', testTableFetchFailureBlocksEverySymbolRequested);
  await run('float-table: a non-ok table fetch response also blocks', testTableFetchNonOkResponseAlsoBlocks);
  await run('float-table: builtAt/staleness surface to the caller', testTableBuiltAtAndStalenessSurfaceToTheCaller);
  await run('float-table: staleness is 0 days when built earlier the same PT calendar day (the reported bug)', testTableStalenessZeroDaysSameBuiltDay);
  await run('float-table: staleness is 1 day when built the previous PT calendar day', testTableStalenessOneDay);
  await run('float-table: staleness is 14 days when built 14 PT calendar days earlier', testTableStalenessFourteenDays);
  await run('float-table: staleness crosses the PT midnight boundary correctly, not by elapsed real time', testTableStalenessMidnightPTBoundary);
})();
