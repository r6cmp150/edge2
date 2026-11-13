// tests/banner-one-line.test.js -- 2026-11-04. Rendered at 390px, the market banner's
// failure text overflowed its fixed 36px and was clipped ("HUN sale NOT recorded" lost
// its ticker), and each failure hid the ones below it with no count. So it is one line
// with a count, and a tap opens every problem over the cards. The layout half can only
// be seen in a browser; what's checkable here is what the layout rests on.
'use strict';
const assert = require('assert');
const { readSource, run, settingLabelsSrc, persistFailureDetailSrc } = require('./_lib');

const app = readSource('app.js');
const grab = n => { const i = app.search(new RegExp(`^function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
function load(fixture) {
  const el = { style: {}, innerHTML: '' };
  global.document = { getElementById: id => (id === 'market-banner' ? el : null) };
  global.state = { saleWriteFailures: {}, positionSaveFailures: {}, ...fixture };
  // CHANGED 2026-11-12, declared: the banner and the mode re-read now redraw the LIVE band; stubbed here, held by tests/live-band.test.js.
  global.renderLiveBand = () => {};
  global.getMarketStatus = () => ({ color: 'var(--green)', label: 'Market open', countdown: 'Closes in 2h 14m' });
  // eslint-disable-next-line no-eval
  // CHANGED 2026-11-13, declared: the banner's failed-save detail is persistFailureDetail now (by tier); loaded for real.
  eval(`${persistFailureDetailSrc()}\n${settingLabelsSrc()}\n${grab('settingsBannerLine')}\n${grab('toggleBannerDetail')}\n${grab('updateMarketBanner')}\nglobal.__b = updateMarketBanner; global.__t = toggleBannerDetail;`);
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

// 2026-11-08: each sale entry shows what it already holds -- its position_id (the key),
// its `at`, and the database's message -- so the queue can be read without a tap.
run('a sale entry shows its position_id, at and database message, escaped; a missing field says so', () => {
  const msg = 'duplicate key value violates unique constraint "trades_v2_position_id_once" <x>';
  const el = load({ saleWriteFailures: {
    '1793977255030': { ticker: 'UEC', code: 'SALE_DUPLICATE', message: msg, at: '2026-11-06T15:40:00.000Z' },
    '1793977708842': { ticker: 'FUN', code: 'SALE_FAILED', message: 'Failed to fetch', at: '2026-11-06T15:14:41.000Z', args: [] },
    '17': { ticker: 'OLD', code: 'SALE_DUPLICATE' },
  } });
  global.__t();
  const h = el.innerHTML;
  assert.ok(h.includes('position 1793977255030 · at 2026-11-06T15:40:00.000Z · duplicate key value violates unique constraint &quot;trades_v2_position_id_once&quot; &lt;x&gt;'), h);
  assert.ok(h.includes('position 1793977708842 · at 2026-11-06T15:14:41.000Z · Failed to fetch'), 'a NOT recorded entry shows its facts too');
  assert.ok(h.includes('position 17 · at not recorded · no message recorded'), 'an entry without at/message says so, never blank');
  assert.ok(!h.includes('<x>') && !h.includes('"trades_v2'), 'the database message is escaped');
  assert.strictEqual((h.match(/class="banner-facts"/g) || []).length, 3, 'one facts line per sale entry, none elsewhere');
});

run('the facts line renders only what the entry holds: no write, no new state', () => {
  const src = grab('updateMarketBanner');
  const i = src.indexOf('const facts = f =>'); assert.ok(i >= 0);
  const line = src.slice(i, src.indexOf('\n', i));
  assert.ok(!/persist\(|state\.|localStorage|new Date|toLocale/.test(line), line);
});

// 2026-11-08: a sold position whose portfolio row is still there has its own line,
// never worded as a sale failure.
run('"still shows as open": its own red line, the sale state named, Remove again, never "sale NOT recorded"', () => {
  const el = load({ positionsStillOpen: {
    7: { ticker: 'UEC', sale: 'WRITTEN', message: 'position 7: the delete removed no row and the row is still there' },
    8: { ticker: 'XE', sale: 'SALE_FAILED', message: '<b>' },
  } });
  global.__t();
  const h = el.innerHTML;
  assert.ok(h.includes('UEC still shows as open') && h.includes('Its sale is recorded.') && h.includes("removePositionAgain('7')"), h);
  assert.ok(h.includes('XE still shows as open') && h.includes('Its sale is queued on this phone, not yet recorded'));
  assert.ok(h.includes('position 7 · position 7: the delete removed no row') && h.includes('&lt;b&gt;') && !h.includes('<b>'));
  assert.ok(!h.includes('UEC sale NOT recorded') && !h.includes('XE sale NOT recorded'), 'never presented as a sale failure');
});

// 2026-11-08: found by rendering change 2 at 390px, not by a test. The collapsed line showed a
// routine refusal while a sale recorded with DIFFERENT numbers sat behind "+3".
run('the collapsed line shows NOT recorded, then DIFFERENT numbers, then could-not-read, before routine refusals', () => {
  const cmpd = v => [{ code: 'SALE_DUPLICATE', message: 'm', at: 'a', comparison: { verdict: v, differ: ['sell_price'], stored: {}, submitted: {} } }];
  const legacy = { ticker: 'OLD', code: 'SALE_DUPLICATE', message: 'm', at: 'a' };
  let el = load({ saleWriteFailures: { a: legacy, b: { ticker: 'MAT', code: 'SALE_DUPLICATE', attempts: cmpd('MATCH') }, c: { ticker: 'CNR', code: 'SALE_DUPLICATE', attempts: cmpd('COULD_NOT_READ') }, d: { ticker: 'DIF', code: 'SALE_DUPLICATE', attempts: cmpd('DIFFER') } } });
  assert.ok(el.innerHTML.includes('DIF sale recorded with different numbers'), 'DIFFER leads: ' + el.innerHTML);
  el = load({ saleWriteFailures: { a: legacy, c: { ticker: 'CNR', code: 'SALE_DUPLICATE', attempts: cmpd('COULD_NOT_READ') } } });
  assert.ok(el.innerHTML.includes('CNR sale was already recorded'), 'could-not-read before an unchecked refusal');
  el = load({ saleWriteFailures: { d: { ticker: 'DIF', code: 'SALE_DUPLICATE', attempts: cmpd('DIFFER') }, f: { ticker: 'NRC', code: 'SALE_FAILED' } } });
  assert.ok(el.innerHTML.includes('NRC sale NOT recorded'), 'a sale not recorded still leads');
});

// 2026-11-11: the sell form prefills a live quote, so no sale line may say Roman entered or
// typed a value: "submitted" is what is known.
run('no sale line claims a value was entered: every comparison state, and the pre-build one', () => {
  const cmpd = v => [{ code: 'SALE_DUPLICATE', message: 'm', at: 'a', comparison: { verdict: v, differ: ['sell_price'], stored: { sell_price: 1, shares: 1, sell_date: 'd' }, submitted: { sell_price: 2, shares: 1, sell_date: 'd' }, reason: 'r' } }];
  const el = load({ saleWriteFailures: {
    a: { ticker: 'MAT', code: 'SALE_DUPLICATE', attempts: cmpd('MATCH') }, b: { ticker: 'DIF', code: 'SALE_DUPLICATE', attempts: cmpd('DIFFER') },
    c: { ticker: 'CNR', code: 'SALE_DUPLICATE', attempts: cmpd('COULD_NOT_READ') }, d: { ticker: 'OLD', code: 'SALE_DUPLICATE', message: 'm', at: 'a' },
  } });
  global.__t();
  assert.ok(!/\b(you entered|You entered|your numbers|Yours were)\b/.test(el.innerHTML), el.innerHTML);
  assert.ok(!/your fill/.test(el.innerHTML), 'paper trades have no fill: no line may refer to one');
});
