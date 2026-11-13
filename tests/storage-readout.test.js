// tests/storage-readout.test.js -- 2026-11-13. Settings -> App Info -> "Storage on this phone": the only instrument that
// can say what older builds left on Roman's phone (cleared by the reviewer with four constraints, each held here):
//   1. read-only: no delete control of any kind;
//   2. every key, with its size, largest first, and the total: nothing filtered;
//   3. each key labelled by what this build knows: its tier, the code that writes it outside persist(), or
//      "not named by this build";
//   4. it writes nothing: run against a storage whose writes throw, it still renders, and its source calls no write.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const store = readSource('core/store.js');
const grab = n => { const i = app.search(new RegExp(`^function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
const constBlock = n => { const i = app.indexOf(`const ${n} = {`); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n};\n', i) + 4); };
const tiers = store.slice(store.indexOf('const PERSIST_TIER = {'), store.indexOf('\n};\n', store.indexOf('const PERSIST_TIER = {')) + 4);

function harness(entries) {
  const m = new Map(Object.entries(entries));
  const writes = [];
  const localStorage = {
    get length() { return m.size; },
    key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k) => { writes.push(['set', k]); throw new Error('the readout must not write'); },
    removeItem: (k) => { writes.push(['remove', k]); throw new Error('the readout must not delete'); },
    clear: () => { writes.push(['clear']); throw new Error('the readout must not clear'); },
  };
  const el = { innerHTML: '' };
  const c = { localStorage, document: { getElementById: id => (id === 'storage-readout' ? el : null) }, navigator: {}, String, Math, Object, console };
  vm.createContext(c);
  vm.runInContext([tiers, constBlock('STORAGE_KEYS_OUTSIDE_PERSIST'), grab('storageKeyLabel'), grab('storageReadoutRows'), grab('renderStorageReadout'),
    ';globalThis.__rows = storageReadoutRows; globalThis.__render = renderStorageReadout;'].join('\n'), c);
  return { c, el, writes };
}

run('every key, largest first, with the total; labelled by tier, by its outside-persist writer, or "not named by this build"', () => {
  const big = n => 'x'.repeat(n);
  const h = harness({ edge_signals: big(5000), edge_warriorFloatCache: big(900000), edge_ownedPeakRSI: big(300), edge2_pin_hash: 'h', zz_someoneElse: big(40), edge_oldThing: big(120000) });
  const rows = JSON.parse(JSON.stringify(h.c.__rows()));
  assert.deepStrictEqual(rows.map(r => r.key), ['edge_warriorFloatCache', 'edge_oldThing', 'edge_signals', 'edge_ownedPeakRSI', 'zz_someoneElse', 'edge2_pin_hash'], 'all six, largest first');
  const label = Object.fromEntries(rows.map(r => [r.key, r.label]));
  assert.strictEqual(label.edge_warriorFloatCache, 'tier 4 (a cache)');
  assert.strictEqual(label.edge_ownedPeakRSI, 'tier 2 (measured state)');
  assert.strictEqual(label.edge2_pin_hash, 'the PIN (written outside persist)');
  assert.strictEqual(label.edge_oldThing, 'not named by this build');
  assert.strictEqual(label.zz_someoneElse, 'not named by this build');
  assert.strictEqual(rows.find(r => r.key === 'edge_signals').chars, 'edge_signals'.length + 5000, 'size is key plus value, in characters');
  h.c.__render();
  const total = rows.reduce((n, r) => n + r.chars, 0);
  assert.ok(h.el.innerHTML.includes(`6 keys, ${total.toLocaleString('en-US')} characters in all`), h.el.innerHTML.slice(0, 200));
  for (const r of rows) assert.ok(h.el.innerHTML.includes(r.key), `${r.key} is shown: nothing filtered`);
});

run('read-only: no delete control, no write of any kind, even against a storage whose writes throw', () => {
  const h = harness({ edge_signals: 'abc', edge_unknown: 'z' });
  h.c.__render();
  assert.deepStrictEqual(h.writes, [], 'nothing written, removed or cleared');
  assert.ok(!/<button|onclick|delete|remove/i.test(h.el.innerHTML.replace('nothing here can be deleted from the app', '')), 'no control: ' + h.el.innerHTML.slice(0, 300));
  for (const n of ['storageKeyLabel', 'storageReadoutRows', 'renderStorageReadout']) {
    assert.ok(!/setItem|removeItem|\.clear\(|persist\(/.test(grab(n)), `${n} calls no write`);
  }
});

run('a key from storage is text, never markup', () => {
  const h = harness({ '<img src=x onerror=alert(1)>': 'v' });
  h.c.__render();
  assert.ok(!h.el.innerHTML.includes('<img'), h.el.innerHTML.slice(0, 200));
  assert.ok(h.el.innerHTML.includes('&lt;img'));
});

run('the outside-persist table names only keys the code really uses', () => {
  const c = {};
  vm.createContext(c);
  vm.runInContext(constBlock('STORAGE_KEYS_OUTSIDE_PERSIST') + ';globalThis.__t = STORAGE_KEYS_OUTSIDE_PERSIST;', c);
  const tableAt = app.indexOf('const STORAGE_KEYS_OUTSIDE_PERSIST = {');
  const rest = app.slice(0, tableAt) + app.slice(app.indexOf('\n};\n', tableAt)) + store;
  for (const k of Object.keys(c.__t)) assert.ok(rest.includes(`'${k}'`), `${k}: named in the table but used nowhere else in the code`);
});

run('Settings shows it, in App Info', () => {
  assert.ok(app.includes('<span class="settings-label">Storage on this phone (read-only)</span>') && app.includes('id="storage-readout"'));
  assert.ok(/\n  loadDatabaseUsage\(\);\n  renderStorageReadout\(\);\n/.test(app), 'rendered with Settings');
});
