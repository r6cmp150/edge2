// tests/portfolio-price-unavailable.test.js — app.js's Portfolio
// sell-price fix (2026-10, Roman, explicit top priority: "it is live and
// corrupting money records"). Extracts openMarkSoldModal via regex (same
// technique tests/persist-quota.test.js already uses) and core/market-
// data.js's real getLivePrice — no reimplemented price logic.
//
// The bug: `currentPrice = getLivePrice(snap) || p.buyPrice` silently
// substituted the buy price whenever a single ticker's snapshot was
// missing from an otherwise-successful batch (the file-level
// priceFetchFailed flag only ever covered a WHOLE-batch failure). That
// fabricated number both looked like a real "Now" price on the card and
// pre-filled Mark as Sold's sale-price field — 22 real trades in
// trades_v2 were recorded at exactly the buy price as a result, not
// because the market actually closed them flat.
//
// This file tests the two surfaces Roman named explicitly: the Mark as
// Sold modal must render an EMPTY, unprefilled price field (never the
// fabricated number) whenever the caller could not vouch for a real
// price, with its own visible notice telling Roman to type the real
// fill — not leave him to notice a suspiciously-round number on his own.
'use strict';
const assert = require('assert');
const { readSource, evalModule, run } = require('./_lib');

function extractFn(name) {
  const src = readSource('app.js');
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name}() from app.js`);
  return m[0];
}

// openMarkSoldModal (2026-10-09) reads the position to refuse a pending
// order, and renders a sell order-type select -- real core/clock.js and
// core/orders.js supply those, not stubs.
global.state = { settings: {}, portfolio: [] };
evalModule(readSource('core/clock.js'), { expose: ['getPT', 'ptDateStr', 'classifySession', 'marketClosesHeld', 'ptWallClockToInstant'] });
evalModule(readSource('core/orders.js'), { expose: ['isPendingOrder', 'ORDER_TYPES'] });

function loadOpenMarkSoldModal(position = { id: 'pos1', orderType: null, filledAt: null }) {
  let captured = null;
  global.state.portfolio = [position];
  global.alert = () => {};
  global.showModal = (html) => { captured = html; };
  global.window = global.window || {}; // openMarkSoldModal sets window._saleDecision at the end
  const src = extractFn('openMarkSoldModal');
  // eslint-disable-next-line no-eval
  eval(src + '\nglobal.__openMarkSoldModal = openMarkSoldModal;');
  return { openMarkSoldModal: global.__openMarkSoldModal, getHtml: () => captured };
}

async function testUnavailablePriceRendersEmptyFieldNotFabricatedNumber() {
  const { openMarkSoldModal, getHtml } = loadOpenMarkSoldModal();
  openMarkSoldModal('pos1', null); // null -- the Mark as sold button's own onclick passes this exactly when priceUnavailable
  const html = getHtml();
  console.log('\n--- Mark as Sold, price unavailable ---\n' + html + '\n--- end ---\n');
  assert.ok(/id="sold-price"[^>]*value=""/.test(html), 'the sale-price input must be EMPTY, never pre-filled with a fabricated number');
  assert.ok(html.includes('Enter the real fill price from your broker; do not guess'), 'must show the explicit notice, not just a blank field with no explanation');
  assert.ok(html.includes('class="stale-table-warning"'), 'must use the existing shared warning style, not a silent blank field');
  assert.ok(!/value="0\.00"/.test(html), 'must never fall back to $0.00 either -- that would look like a real (and wrong) value');
}

async function testAvailablePriceStillPrefillsNormally() {
  const { openMarkSoldModal, getHtml } = loadOpenMarkSoldModal();
  openMarkSoldModal('pos1', 14.37);
  const html = getHtml();
  console.log('\n--- Mark as Sold, real price available ---\n' + html + '\n--- end ---\n');
  assert.ok(/id="sold-price"[^>]*value="14\.37"/.test(html), 'a real price must still pre-fill exactly as before -- this fix must not degrade the normal case');
  assert.ok(!html.includes('stale-table-warning'), 'no warning banner when a real price was available');
  assert.ok(/id="sold-order-type"[\s\S]*value="market" selected/.test(html), 'sell order type select present, defaulting to market (db/027)');
  // A pending order is not a position: the sale form must not open at all.
  const pend = loadOpenMarkSoldModal({ id: 'pos1', orderType: 'limit', filledAt: null });
  pend.openMarkSoldModal('pos1', 14.37);
  assert.strictEqual(pend.getHtml(), null, 'a pending order must never reach the sale form');
}

// getLivePrice itself is untouched by this fix (core/market-data.js) --
// confirms the REAL function, not an assumption, is what drives
// priceUnavailable's "!getLivePrice(snap)" half in renderPortfolioTab.
async function testGetLivePriceRealBehaviorMatchesWhatPriceUnavailableAssumes() {
  evalModule(readSource('core/market-data.js'), { expose: ['getLivePrice'] });
  const getLivePrice = global.getLivePrice;
  assert.strictEqual(getLivePrice(undefined), 0, 'a missing snapshot entry (the exact gap this bug lived in) must be falsy');
  assert.strictEqual(getLivePrice({}), 0, 'a snapshot object with neither dailyBar nor latestTrade must be falsy');
  assert.strictEqual(getLivePrice({ dailyBar: { c: 14.37 } }), 14.37, 'a real snapshot must return its real price (sanity check, not this fix\'s concern)');
}

(async () => {
  await run('portfolio-price-unavailable: Mark as Sold renders an EMPTY field, never the fabricated buy-price number', testUnavailablePriceRendersEmptyFieldNotFabricatedNumber);
  await run('portfolio-price-unavailable: a real available price still pre-fills normally (no regression)', testAvailablePriceStillPrefillsNormally);
  await run('portfolio-price-unavailable: getLivePrice\'s real falsy cases match what priceUnavailable in renderPortfolioTab relies on', testGetLivePriceRealBehaviorMatchesWhatPriceUnavailableAssumes);
})();
