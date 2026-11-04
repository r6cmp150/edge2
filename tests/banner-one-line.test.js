// tests/banner-one-line.test.js -- 2026-11-04. Rendered at 390px, the market banner's
// failure text overflowed its fixed 36px and was clipped ("HUN sale NOT recorded" lost
// its ticker), and each failure hid the ones below it with no count. So it is one line
// with a count, and a tap opens every problem over the cards. The layout half can only
// be seen in a browser; what's checkable here is what the layout rests on.
'use strict';
const assert = require('assert');
const { readSource, run, settingLabelsSrc } = require('./_lib');

const app = readSource('app.js');
const grab = n => { const i = app.search(new RegExp(`^function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
function load(fixture) {
  const el = { style: {}, innerHTML: '' };
  global.document = { getElementById: id => (id === 'market-banner' ? el : null) };
  global.state = { saleWriteFailures: {}, positionSaveFailures: {}, ...fixture };
  global.getMarketStatus = () => ({ color: 'var(--green)', label: 'Market open', countdown: 'Closes in 2h 14m' });
  // eslint-disable-next-line no-eval
  eval(`${settingLabelsSrc()}\n${grab('settingsBannerLine')}\n${grab('toggleBannerDetail')}\n${grab('updateMarketBanner')}\nglobal.__b = updateMarketBanner; global.__t = toggleBannerDetail;`);
  global.__b();
  return el;
}
const ALL = {
  persistFailure: { key: 'sold' },
  saleWriteFailures: { a: { ticker: 'DUP', code: 'SALE_DUPLICATE' }, b: { ticker: 'HUN', code: 'SALE_FAILED' }, c: { ticker: 'BIAF', code: 'SALE_FAILED' } },
  positionSaveFailures: { p: { ticker: 'SNXX', code: 'POSITION_UNWRITABLE', message: 'x' } },
  snapshotWriteFailures: { s: { ticker: 'CLF', row: {} } },
  ratingWriteFailures: [{ rows: [{}, {}] }],
  dataReadProblems: { trades_v2: 'the Sold list read back empty' },
};
const TITLES = ['Save failed — sold', 'HUN sale NOT recorded', 'BIAF sale NOT recorded', 'DUP sale was already recorded', "Couldn't save SNXX", 'CLF buy snapshot NOT saved', '1 scan snapshot batch NOT saved (2 rows)', "Couldn't confirm data from Supabase"];

run('no problem: market status and its countdown, nothing else', () => {
  const el = load({});
  assert.ok(el.innerHTML.includes('Market open') && el.innerHTML.includes('Closes in 2h 14m'));
  assert.ok(!el.innerHTML.includes('banner-line') && !el.innerHTML.includes('banner-panel'));
});

run('collapsed: the most urgent title, how many more, and market status; nothing that can overflow', () => {
  const el = load(ALL);
  assert.ok(el.innerHTML.includes('Save failed — sold'));
  assert.ok(el.innerHTML.includes(`>+${TITLES.length - 1}<`), 'the count of what is behind it: ' + el.innerHTML);
  assert.ok(el.innerHTML.includes('Market open'), 'market status stays visible during a failure');
  for (const t of TITLES.slice(1)) assert.ok(!el.innerHTML.includes(t), `${t} is not on the line`);
  assert.ok(!el.innerHTML.includes('banner-panel') && !el.innerHTML.includes('Retry') && !el.innerHTML.includes('Storage full'), 'no detail on the line');
  assert.ok(el.innerHTML.includes('aria-expanded="false"') && el.innerHTML.includes('onclick="toggleBannerDetail()"'));
});

run('one problem shows no count', () => {
  const el = load({ snapshotWriteFailures: { s: { ticker: 'CLF', row: {} } } });
  assert.ok(el.innerHTML.includes('CLF buy snapshot NOT saved') && !el.innerHTML.includes('banner-count'));
});

run('a tap opens EVERY problem, in priority order, each with its detail and its own button', () => {
  const el = load(ALL);
  global.__t();
  const at = TITLES.map(t => el.innerHTML.lastIndexOf(t));
  at.forEach((p, i) => assert.ok(p >= 0, `${TITLES[i]} missing from the panel`));
  assert.deepStrictEqual(at, at.slice().sort((a, b) => a - b), 'priority order: ' + at);
  for (const s of ["retrySaleWrite('b')", "retrySaleWrite('c')", "dismissSaleNotice('a')", "retrySnapshotWrite('s')", 'retryRatingWrites()', "Don't re-submit it by hand", 'Tap Retry (safe', 'Closes in 2h 14m']) {
    assert.ok(el.innerHTML.includes(s), `${s} missing: every failure gets its action, not only the first`);
  }
  assert.ok(el.innerHTML.includes('aria-expanded="true"'));
  global.__t();
  assert.ok(!el.innerHTML.includes('banner-panel'), 'a second tap closes it');
});

run('the clock does not rewrite unchanged content, and any change does', () => {
  const el = load(ALL);
  global.__t();
  el.innerHTML = 'SENTINEL';
  global.__b();
  assert.strictEqual(el.innerHTML, 'SENTINEL', 'unchanged: a 30-second tick must not reset the panel or replace a button mid-tap');
  global.state.snapshotWriteFailures = {};
  global.__b();
  assert.ok(!el.innerHTML.includes('CLF') && el.innerHTML.includes('HUN sale NOT recorded'), 'a resolved failure leaves');
});

run('the layout it rests on: one fixed line that cannot wrap, a panel over the cards', () => {
  const css = readSource('styles.css');
  const rule = sel => { const m = css.match(new RegExp(`(^|\\n)${sel.replace('.', '\\.')} \\{([^}]*)\\}`)); assert.ok(m, sel); return m[2]; };
  assert.ok(/height: var\(--banner-h\)/.test(rule('.market-banner')) && /position: relative/.test(rule('.market-banner')));
  assert.ok(/white-space: nowrap/.test(rule('.banner-title')) && /text-overflow: ellipsis/.test(rule('.banner-title')) && /min-width: 0/.test(rule('.banner-title')));
  assert.ok(/min-width: 0/.test(rule('.banner-line')), 'without it the flex child refuses to shrink, and the ellipsis never happens');
  assert.ok(/position: absolute/.test(rule('.banner-panel')) && /top: 100%/.test(rule('.banner-panel')), 'over the cards, not pushing them down');
  assert.ok(/max-height: 60vh/.test(rule('.banner-panel')) && /overflow-y: auto/.test(rule('.banner-panel')), 'a long list scrolls inside it');
});
