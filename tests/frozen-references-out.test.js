// tests/frozen-references-out.test.js -- 2026-11-26, THE STANDING CHECK (the reviewer, CC-option-A §1.4). The freeze
// stops its closure at an OUT declaration, so an OUT name that frozen code CALLS is a place where a change goes unseen.
// The audit of 2026-11-26 found three that carried values into frozen code (calcPeakRiskScore, sigToggleKey,
// knownNumber), and its first run after the restart found six more (the Add flow's listing and open-lot dialogs, and
// the loader of state.sold, which the frozen after-hours warning quotes). Now every OUT name a frozen declaration
// references must be listed in the spec (out_referenced_by_frozen) with why it may stay out, and nothing else may be:
//   - a NEW reference fails until the name is frozen, or listed with a reason;
//   - a listed name no longer referenced fails, so the list cannot rot into a blanket exemption.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const L = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/instrument-freeze.mjs')).href);
const spec = JSON.parse(readSource('data/forward-test/instrument-freeze-spec.json'));
const app = readSource('app.js');

// every OUT name referenced by a frozen declaration's code (the detector's own normalize: comments are not code;
// a name inside a string counts, which over-includes, the safe direction)
function outReferencedByFrozen(src, sp) {
  const outNames = new Set(Object.values(sp.app_js.out).flatMap(g => g.names));
  const by = new Map(L.chunks(src).map(c => [c.name, c]));
  const hits = new Map();
  for (const f of L.frozenDeclarations(src, sp)) {
    for (const id of new Set(L.normalize(by.get(f).text).match(/[A-Za-z_$][\w$]*/g) || [])) {
      if (id !== f && outNames.has(id)) (hits.get(id) || hits.set(id, []).get(id)).push(f);
    }
  }
  return hits;
}

await run('every OUT name that frozen code references is listed with its reason, and nothing else is', () => {
  const hits = outReferencedByFrozen(app, spec), listed = spec.out_referenced_by_frozen.names;
  const unlisted = [...hits.keys()].filter(n => !(n in listed)).map(n => `${n} <- ${hits.get(n).join(', ')}`);
  assert.deepStrictEqual(unlisted, [], 'frozen code references an OUT name with no reason: freeze it, or list it with why it may stay out');
  assert.deepStrictEqual(Object.keys(listed).filter(n => !hits.has(n)), [], 'a listed name no frozen code references any more: remove it');
  for (const [n, why] of Object.entries(listed)) assert.ok(typeof why === 'string' && why.length > 40, `${n} carries its reason`);
});

await run('the ones that carried a value or a choice-moment text into frozen code are frozen, not listed', () => {
  const listed = spec.out_referenced_by_frozen.names;
  const outNames = new Set(Object.values(spec.app_js.out).flatMap(g => g.names));
  for (const n of ['calcPeakRiskScore', 'sigToggleKey', 'knownNumber', 'listingWarningText', 'openLotsMessage', 'OPEN_LOT_CHOICES',
    'friendlyBuyWhen', 'loadSoldFromSupabase', 'mapTradesV2ToSoldShape']) {
    assert.ok(!outNames.has(n) && !(n in listed), `${n} is frozen`);
  }
});

await run('the check fires: a frozen function newly calling an OUT helper is named; listing it with a reason clears it', () => {
  // a frozen function (runScreener) gains a call to an OUT display helper (scoringLegendText)
  const mutated = app.replace('async function runScreener() {', 'async function runScreener() { scoringLegendText();');
  assert.notStrictEqual(mutated, app);
  const hits = outReferencedByFrozen(mutated, spec);
  assert.ok(hits.has('scoringLegendText') && hits.get('scoringLegendText').includes('runScreener'));
  assert.ok(!('scoringLegendText' in spec.out_referenced_by_frozen.names), 'so the first test would fail on it');
});
})();
