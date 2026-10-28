// tests/layout-check.test.js — 2026-10-27. The bottom-nav report ("doesn't
// appear until I scroll to the very bottom, sometimes, any tab") couldn't be
// reproduced off the phone, so app.js carries a read-only diagnostic
// (checkLayout) that records the state when it happens. It must catch the
// symptom, stay silent otherwise, never throw, and never change the page
// it's watching.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const i = app.indexOf('const LAYOUT_LOG_KEY'); const j = app.indexOf('// Fills every element marked data-build-status');
const DIAG = app.slice(i, j);

function load({ innerH = 844, vvH = 844, appH = 844, navBottom = 844, scrollY = 0, docH = 844, throws = false } = {}) {
  const store = {};
  global.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  const rect = h => () => { if (throws) throw new Error('layout read failed'); return h; };
  global.document = {
    getElementById: id => ({ app: { getBoundingClientRect: rect({ height: appH }) }, 'bottom-nav': { getBoundingClientRect: rect({ bottom: navBottom }) } }[id] || null),
    scrollingElement: { scrollTop: scrollY, scrollHeight: docH },
  };
  global.window = { innerHeight: innerH, visualViewport: { height: vvH }, scrollY, matchMedia: () => ({ matches: true }) };
  Object.defineProperty(global, 'navigator', { value: { standalone: true, userAgent: 'test-agent' }, configurable: true, writable: true });
  global.CSS = { supports: () => true };
  global.state = { activeTab: 'portfolio' };
  const warn = console.warn; console.warn = () => {};
  // eslint-disable-next-line no-eval
  try { eval(DIAG + '\nglobal.__check = checkLayout; global.__note = noteLayoutEvent; global.__summary = layoutCheckSummaryText;'); } finally { console.warn = warn; }
  return store;
}
const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

run('silent when the nav is on screen and the document has not scrolled', () => {
  const store = load();
  assert.strictEqual(global.__check('test'), null);
  assert.strictEqual(store.edge_layoutAnomalies, undefined, 'nothing recorded');
  assert.strictEqual(global.__summary(), 'No layout problems recorded.');
});

run('catches the symptom: app taller than the screen, nav at the end of the document', () => {
  const store = load({ appH: 2632, navBottom: 2632, docH: 2632 });
  global.__note('modal-close');
  const r = quiet(() => global.__check('modal-close'));
  assert.ok(r, 'recorded');
  assert.deepStrictEqual({ appH: r.appH, innerH: r.innerH, navBottom: r.navBottom, last: r.last, standalone: r.standalone, tab: r.tab }, { appH: 2632, innerH: 844, navBottom: 2632, last: 'modal-close', standalone: true, tab: 'portfolio' });
  assert.strictEqual(JSON.parse(store.edge_layoutAnomalies).length, 1);
  assert.strictEqual(r.vvDiff, 0, 'window and visible viewport agree: not an address-bar transition');
  assert.ok(/1 recorded\. Last .* after modal-close \(modal-close\): window 844 vs visible 844 \(same\); app 2632, nav bottom 2632, page scrolled 0, home-screen app\./.test(global.__summary()), global.__summary());
});

// Android Chrome (Roman's browser): the address bar collapsing or expanding
// changes the viewport mid-scroll. The pair innerHeight vs
// visualViewport.height, recorded when the nav is off-screen, separates
// that transition from everything else in one reading.
run('records the address-bar pair: window vs visible viewport, and says when they differ', () => {
  load({ innerH: 780, vvH: 724, appH: 836, navBottom: 836, docH: 836, scrollY: 56 });
  const r = quiet(() => global.__check('document-scroll'));
  assert.deepStrictEqual({ innerH: r.innerH, vvH: r.vvH, vvDiff: r.vvDiff }, { innerH: 780, vvH: 724, vvDiff: 56 });
  assert.ok(global.__summary().includes('window 780 vs visible 724 (differ by 56)'), global.__summary());
});

run('catches a scrolled document even when the app height looks right', () => {
  load({ scrollY: 120, docH: 964 });
  assert.ok(quiet(() => global.__check('document-scroll')));
});

run('never throws, and keeps at most 20 records', () => {
  load({ throws: true });
  assert.strictEqual(global.__check('test'), null, 'a failed layout read returns null, never throws');
  const store = load({ appH: 2000, navBottom: 2000 });
  const realNow = Date.now; let t = 1e12; Date.now = () => (t += 6000);
  try { for (let k = 0; k < 25; k++) quiet(() => global.__check('t')); } finally { Date.now = realNow; }
  assert.strictEqual(JSON.parse(store.edge_layoutAnomalies).length, 20);
});

run('read-only: the diagnostic never moves or restyles the page, and is wired in', () => {
  // Reading scrollTop is measurement; calling scrollTo or assigning scrollTop would move the page.
  assert.ok(!/\.style\b|scrollTo\s*\(|scrollTop\s*=(?!=)|scrollIntoView|classList|position\s*[:=]/.test(DIAG.replace(/\/\/.*$/gm, '')), 'the diagnostic changes nothing it watches');
  assert.ok(app.includes('installLayoutCheck(); // bottom-nav diagnostic'));
  assert.ok(/function closeModal\(\) \{[\s\S]*?noteLayoutEvent\('modal-close'\)/.test(app));
  assert.ok(/function switchTab\(name\) \{\n  state\.activeTab = name;\n  noteLayoutEvent/.test(app));
  assert.ok(app.includes('${layoutCheckSummaryText()}'), 'summarised in Settings');
});
