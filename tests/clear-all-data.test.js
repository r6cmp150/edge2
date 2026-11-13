// tests/clear-all-data.test.js -- 2026-11-13. "Clear All Data" said: "This will delete your portfolio and trade history.
// This cannot be undone." It removes eight keys of this phone's storage, all copies of what the database holds, and
// never touched the only things kept solely on the phone. The reviewer ruled the text corrected and PINNED BY A TEST OF
// WHAT IT ACTUALLY CLEARS, and that it name the keys as the Storage readout lists them. Run for real here.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const grab = n => { const i = app.search(new RegExp(`^function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
const line = p => { const i = app.indexOf(p); assert.ok(i >= 0, p); return app.slice(i, app.indexOf('\n', i) + 1); };

function harness() {
  const m = new Map();
  for (const k of ['settings', 'portfolio', 'sold', 'analysisPeriods', 'signals', 'lastScanTime', 'news', 'lastPassedCount',
    'ownedPeakRSI', 'ownedPrevRSI', 'warriorPreMarketRvolObservations', 'saleWriteFailures', 'snapshotWriteFailures', 'ratingWriteFailures', 'someOldBuildKey']) m.set('edge_' + k, 'v');
  m.set('edge2_pin_hash', 'h');
  const confirms = [];
  const c = {
    localStorage: { removeItem: k => m.delete(k), getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) },
    showConfirm: (msg, cb) => confirms.push({ msg, cb }), showAlert: () => {}, loadState: () => {}, renderSettingsTab: () => {}, updateNavBadges: () => {},
    MASTER_TICKERS: [], TICKERS: [],
  };
  vm.createContext(c);
  vm.runInContext(line('const CLEAR_ALL_KEYS = ') + grab('clearAllDataText') + grab('clearAllData') + ';globalThis.__clear = clearAllData; globalThis.__keys = CLEAR_ALL_KEYS;', c);
  return { c, m, confirms };
}

run('it removes exactly the keys its confirm names, and nothing else: the peak RSI, the queues and unknown keys stay', () => {
  const h = harness();
  const before = new Set(h.m.keys());
  h.c.__clear();
  assert.strictEqual(h.confirms.length, 1, 'it asks first');
  assert.deepStrictEqual([...h.m.keys()].sort(), [...before].sort(), 'nothing is removed before the answer');
  h.confirms[0].cb();
  const removed = [...before].filter(k => !h.m.has(k)).sort();
  const named = h.confirms[0].msg.match(/edge_[A-Za-z]+/g).sort();
  assert.deepStrictEqual(removed, named, 'the confirm names exactly what goes');
  assert.deepStrictEqual(removed, [...h.c.__keys].map(k => 'edge_' + k).sort());
  for (const k of ['edge_ownedPeakRSI', 'edge_ownedPrevRSI', 'edge_warriorPreMarketRvolObservations', 'edge_saleWriteFailures', 'edge_snapshotWriteFailures', 'edge_ratingWriteFailures', 'edge_someOldBuildKey', 'edge2_pin_hash']) {
    assert.ok(h.m.has(k), `${k} stays`);
  }
});

run('the confirm says what is true: copies on this phone, the database untouched, the peak RSI and queued writes kept', () => {
  const h = harness();
  h.c.__clear();
  const t = h.confirms[0].msg;
  assert.ok(!/delete your portfolio and trade history|cannot be undone/i.test(t), 'the old false claim is gone: ' + t);
  assert.ok(/copies kept on this phone/.test(t) && /in the database are not touched/.test(t), t);
  assert.ok(/does not remove the peak RSI of open positions or any queued write/.test(t), t);
  assert.ok(/as listed under Storage on this phone/.test(t), 'it points at the readout, so the two describe one world');
  // (the reviewer) the cost first, the identifiers last
  assert.ok(t.indexOf('those stay') < t.indexOf('edge_'), 'the reassurance arrives before the first key name: ' + t);
});

// The export, renamed (2026-11-13): measured, it reads only the database, holds nothing kept only on this phone, and
// nothing loads it back. A control is named for what it does.
run('the export is named for what it does, and says what it does not include', () => {
  assert.ok(!/>Export All Data</.test(app), 'the old name, which promised everything, is gone');
  assert.ok(app.includes('onclick="exportAllData(this)">Download Database Copy</button>'));
  const i = app.indexOf('const EXPORT_SCOPE_TEXT = ');
  const scope = app.slice(i, app.indexOf('\n', i));
  assert.ok(/copy of the database records/.test(scope) && /not a backup of this phone/.test(scope), scope);
  assert.ok(/does not include the peak RSI of open positions or any queued write/.test(scope) && /nothing can be loaded back/.test(scope), scope);
  assert.ok(app.includes('<div class="settings-hint" id="export-scope" style="padding:0 16px 12px">${EXPORT_SCOPE_TEXT}</div>'), 'shown under the button');
  // The scope line is true only while the export reads the database alone. If it ever starts reading this phone's
  // storage, the line (and this test) must be revisited, not left to go stale.
  const at = app.indexOf('async function exportAllData(');
  const fn = app.slice(at, app.indexOf('\n}\n', at));
  assert.ok(at >= 0 && !/localStorage|state\.owned|persist\(/.test(fn), 'the export reads nothing from this phone, as its line says');
});
