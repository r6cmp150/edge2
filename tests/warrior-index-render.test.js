// tests/warrior-index-render.test.js — engines/warrior/index.js's card
// rendering, specifically _pillarValueDisplay's float branch. Node-side,
// not a browser check (2026-09-04, explicit call): CORS needed a real
// browser because that failure only exists there; a rendered string is
// pure formatting with no environment dependence, so a Node assertion
// pins it permanently rather than relying on someone spotting it once in
// a screenshot.
//
// index.js is a real ES module (import/export), and _pillarValueDisplay
// isn't exported -- loaded here the same way tests/_lib.js's classic-
// script technique works elsewhere in this suite: strip the few
// import/export statements (this function has no dependency on any of
// them -- it's a pure function of the `pillar` object) and eval the rest,
// exposing the one function under test.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

function loadPillarValueDisplay() {
  // Stubs for the imported names index.js uses in a few TOP-LEVEL const
  // declarations (e.g. the replay-panel classifier list) -- evaluated
  // immediately when the const is declared, unlike a function body, so
  // these must exist before eval even though _pillarValueDisplay itself
  // never touches any of them.
  global.evaluateGateBatch = undefined;
  global._selectStrategy = undefined;
  global.runReplayForSymbols = undefined;
  global.evaluateSetupsBatch = undefined;
  global.SETUP_REPLAY_CATALOG = [];
  global.ALL_SETUPS_ID = 'all';
  global.scanDateRangeForSetups = undefined;
  global.estimateRangeScanRequests = undefined;
  global._tradingDaysBetween = undefined;

  let src = readSource('engines/warrior/index.js');
  src = src.replace(/^import .*$/gm, '');
  src = src.replace(/^export function/gm, 'function');
  // eslint-disable-next-line no-eval
  eval(src + '\nglobal.__pillarValueDisplay = _pillarValueDisplay;');
  return global.__pillarValueDisplay;
}

async function testDilutionCorrectedEntryRendersTheCorrectionCaveat() {
  const _pillarValueDisplay = loadPillarValueDisplay();
  const pillar = { id: 'float', status: 'pass', value: 1_010_611, asOfDate: '2025-06-30', stalenessDays: 431, dilutionCorrected: true };
  const text = _pillarValueDisplay(pillar);
  console.log('dilution-corrected render:', text);
  assert.ok(text.includes('dilution-adj., assumes constant free-float %'), `expected the correction caveat, got: ${text}`);
}

async function testNoSharesDataEntryRendersTheUncorrectedCaveat() {
  const _pillarValueDisplay = loadPillarValueDisplay();
  const pillar = { id: 'float', status: 'fail', value: 131_358_775, asOfDate: '2025-06-30', stalenessDays: 431, dilutionCorrected: false };
  const text = _pillarValueDisplay(pillar);
  console.log('uncorrected (no shares data) render:', text);
  assert.ok(text.includes('NOT dilution-adjusted (no shares data)'), `expected the uncorrected caveat, got: ${text}`);
}

(async () => {
  await run('warrior/index: a dilution-corrected float entry renders the correction caveat', testDilutionCorrectedEntryRendersTheCorrectionCaveat);
  await run('warrior/index: a no-shares-data float entry renders the uncorrected caveat', testNoSharesDataEntryRendersTheUncorrectedCaveat);
})();
