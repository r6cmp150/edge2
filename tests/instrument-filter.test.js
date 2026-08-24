// tests/instrument-filter.test.js — core/universe.js's
// EXCLUDED_INSTRUMENT_NAME_RE / ADR_RE / _isEligibleInstrument.
//
// Fixtures are real, specific names confirmed live this session (not
// invented examples): BTDL (a real ETF that reached the premarket-gap
// result before the Problem 1 fix), HQWWW/FVNNU (warrant/unit shapes),
// BAK (the ADR carve-out false positive that was found and fixed live),
// and "Fundamental Global Inc." (the word-boundary false-positive risk
// that was checked against live data before "fund" was added to the
// exclude-list). This is a regression fixture: if any of these ever
// misclassify again, a future edit broke something this session spent real
// live-API budget establishing.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

function loadFilter() {
  const src = readSource('core/universe.js');
  const startMarker = 'function _inPriceRange';
  const endMarker = 'function _isEligibleInstrument(asset) {';
  const endOfFn = src.indexOf('\n}', src.indexOf(endMarker)) + 2;
  const startIdx = src.indexOf(startMarker);
  const snippet = src.slice(startIdx, endOfFn);
  const exposeCode = 'global.__isEligibleInstrument = _isEligibleInstrument;';
  // eslint-disable-next-line no-eval
  eval(snippet + '\n' + exposeCode);
  return global.__isEligibleInstrument;
}

const FIXTURES = [
  // [symbol, name, expectEligible, why]
  ['GOOD1', 'Ordinary Common Stock Co', true, 'plain common stock, no exclude-list keyword'],
  ['BTDL', 'GraniteShares 2x Long BTDR Daily ETF', false, 'real ETF that reached the premarket-gap result before the Problem 1 instrument-filter fix (2026-08-24)'],
  ['HQWWW', 'HQ Acquisition Corp Warrant', false, 'warrant-shaped name'],
  ['FVNNU', 'Fintech Ecosystem Development Corp Unit', false, 'unit-shaped name (SPAC unit)'],
  ['BAK', 'Braskem S.A. American Depositary Shares (Each representing Two Class A Preferred Shares)', true, 'ADR carve-out — "Preferred" describes the underlying share the ADS represents, not the ADS itself; confirmed live this session as a real false positive before the carve-out existed'],
  ['FGF', 'Fundamental Global Inc.', true, 'word-boundary check — "fund" must not match inside "Fundamental"; verified live via diagnoseFundKeywordCandidates before "fund" was added to the exclude-list'],
  ['DEP1', 'SomeBank Depositary Shares representing 1/1000th interest in a 6% Preferred Stock', false, 'bare "Depositary Shares" WITHOUT "American" is a genuinely different, preferred-stock-backed structure — correctly excluded by "preferred" on its own, no ADR carve-out applies'],
  ['WARR1', 'Some Corp Warrants', false, 'plural warrant form'],
  ['ETFX', 'Some Sector ETF', false, 'ETF keyword'],
  ['ETNX', 'Some Index ETN', false, 'ETN keyword'],
  ['NOTE1', 'Some Corp 5% Notes due 2030', false, 'notes keyword'],
];

async function testInstrumentFilterFixtures() {
  const isEligible = loadFilter();
  const failures = [];
  for (const [symbol, name, expectEligible] of FIXTURES) {
    const actual = isEligible({ symbol, name });
    const status = actual === expectEligible ? 'ok' : 'MISMATCH';
    console.log(`  ${status.padEnd(8)} ${symbol.padEnd(6)} eligible=${actual}  "${name}"`);
    if (actual !== expectEligible) failures.push(symbol);
  }
  assert.strictEqual(failures.length, 0, `instrument filter regressed on: ${failures.join(', ')}`);
}

(async () => {
  await run('instrument-filter: fixture regression suite', testInstrumentFilterFixtures);
})();
