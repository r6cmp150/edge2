// tests/app-list-at-buy.test.js -- 2026-11-25. The reviewer: "nothing in this system records what was on his screen."
// The signals tab now keeps the cards it renders (symbols and scores, nothing more) and a buy records them inside its
// snapshot as appListAtBuy. CAPTURE-NOT-CONSUME: RECORDED AND UNUSED. The forward test's C keeps the watch line; no
// measure may read this until a later declaration says so (and removes the last check here).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSource, run, REPO_ROOT } = require('./_lib');

const app = readSource('app.js');
const fnSrc = name => { const i = app.search(new RegExp('^(async )?function ' + name + '\\(', 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };

// renderSignalsTab with everything around it stubbed: the capture is tested by what the render does
function renderWith({ signals, filtered, lastScanTime = Date.now() }) {
  const container = { innerHTML: '' };
  Object.assign(global, {
    state: { settings: { alpacaKey: 'k' }, signals, lastScanTime, preMarketMovers: [], selectedUniverse: 'OTHER' },
    document: { getElementById: () => container },
    updateBudgetBar() {}, getMarketStatus: () => ({ status: 'OPEN' }), isAfternoonMode: () => false,
    getFreshnessHtml: () => '', buildMacroBanner: () => '', getHoldings: () => [], renderFilterButtons: () => '',
    buildNothingShowingText: () => '', buildDroppedSuffixHtml: () => '', buildPrefilterRuleSuffixHtml: () => '',
    getOwnedPosition: () => null, getPendingOrder: () => null, TICKERS: [], buildNothingQualifiesHtml: () => '',
    getFilteredSignals: () => filtered, renderStockCard: s => `<card ${s.ticker}>`, ensureScanHistory() {}, refreshScanHistoryDom() {},
    renderPreMarketSection: () => '',
  });
  // eslint-disable-next-line no-eval
  eval(fnSrc('renderSignalsTab') + '\nglobal.__r = renderSignalsTab;');
  global.__r();
  return { container, onScreen: global.state.appListOnScreen };
}

run('the render keeps exactly the cards it put on screen, symbols and scores only', () => {
  const sig = [{ ticker: 'AAA', score: 40, price: 3, extra: 'x' }, { ticker: 'BBB', score: 22, price: 1.5 }, { ticker: 'CCC', score: 90, price: 9 }];
  const { container, onScreen } = renderWith({ signals: sig, filtered: [sig[2], sig[0]] });
  assert.deepStrictEqual(onScreen.items, [{ ticker: 'CCC', score: 90 }, { ticker: 'AAA', score: 40 }], 'the filtered cards, in display order; BBB was not shown');
  assert.ok(container.innerHTML.includes('<card CCC>') && !container.innerHTML.includes('<card BBB>'));
  assert.ok(!Number.isNaN(Date.parse(onScreen.renderedAt)));
});

run('no card on screen is recorded as an empty list, a real record, not an absence', () => {
  assert.deepStrictEqual(renderWith({ signals: [{ ticker: 'A', score: 30 }], filtered: [] }).onScreen.items, [], 'filters matched nothing');
  assert.deepStrictEqual(renderWith({ signals: [], filtered: [] }).onScreen.items, [], 'nothing above the display line');
});

run('appListAtBuy: RECORDED with a copy, or NOT_RECORDED with why; never absent', () => {
  global.state = { appListOnScreen: null };
  // eslint-disable-next-line no-eval
  eval(fnSrc('appListAtBuy') + '\nglobal.__a = appListAtBuy;');
  const none = global.__a();
  assert.strictEqual(none.state, 'NOT_RECORDED'); assert.ok(/had not rendered/.test(none.reason));
  global.state.appListOnScreen = { renderedAt: '2026-11-27T15:00:00.000Z', items: [{ ticker: 'AAA', score: 40 }] };
  const rec = global.__a();
  assert.deepStrictEqual(rec, { state: 'RECORDED', renderedAt: '2026-11-27T15:00:00.000Z', items: [{ ticker: 'AAA', score: 40 }] });
  global.state.appListOnScreen.items[0].score = 99;
  assert.strictEqual(rec.items[0].score, 40, 'a copy: a later render does not rewrite what the buy stored');
});

run('the buy attaches it to its snapshot before any await, beside appShowedAtBuy', () => {
  const f = fnSrc('finalizeAddPortfolio').replace(/\/\/.*$/gm, c => ' '.repeat(c.length));
  const att = f.indexOf('if (signalSnapshotAtBuy) signalSnapshotAtBuy.appListAtBuy = appListAtBuy();');
  assert.ok(att > f.indexOf('signalSnapshotAtBuy.appShowedAtBuy = appShowedAtBuy(ticker);') && att < f.search(/\bawait\s/));
});

run('RECORDED AND UNUSED: no script, core module or engine reads it', () => {
  const hits = [];
  const walk = d => { for (const e of fs.readdirSync(path.join(REPO_ROOT, d), { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(m?js|cjs)$/.test(e.name) && /appListAtBuy|appListOnScreen/.test(fs.readFileSync(path.join(REPO_ROOT, p), 'utf8'))) hits.push(p); } };
  for (const d of ['scripts', 'core', 'engines', 'shell']) if (fs.existsSync(path.join(REPO_ROOT, d))) walk(d);
  assert.deepStrictEqual(hits, [], 'a measure that wants the list must be declared first, and must remove this check in the same commit');
  assert.strictEqual(app.split('appListOnScreen').length - 1, 4, 'app.js: set in the render, read only by appListAtBuy (and named in two comments)');
});
