// tests/portfolio-sort.test.js — the portfolio sort control (2026-11-02).
//
// Six modes: "Closest to time limit" (the order this tab always had, now
// with an id tiebreak, and the default), most profit / most loss (P/L %),
// newest / oldest purchase (filledAt), highest current score. Presentation
// only: renderPortfolioTab is the sole writer of prevRSI, peakPrice and
// momentumProtectionActivated, so it must visit every holding exactly once,
// in the same order, writing the same values, whatever the mode.
//
// Three states on every key: a number, or unknown. Unknowns sit in their own
// bucket at the bottom in both directions; a real 0.0% is 0.0%, not
// unknown. A missing filledAt is unknown, never buyDate/buyTime/the id (the
// id is the recording instant: the buyDayOfWeek defect).
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');
const grabFn = name => {
  const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(i >= 0, name);
  return app.slice(i, app.indexOf('\n}\n', i) + 3);
};
const grabLine = prefix => { const i = app.indexOf(prefix); assert.ok(i >= 0, prefix); return app.slice(i, app.indexOf('\n', i) + 1); };
const SORT_BLOCK_START = '// ── Portfolio sort (2026-11-02)';
const sortBlock = (src = app) => src.slice(src.indexOf(SORT_BLOCK_START), src.indexOf('async function renderPortfolioTab() {'));

// Monday 2026-11-02 10:00 PST (18:00Z): REGULAR session, after the open.
const NOW = Date.parse('2026-11-02T18:00:00Z');
const HOUR = 3600e3;
const MODES = ['TIME_LIMIT', 'MOST_PROFIT', 'MOST_LOSS', 'NEWEST', 'OLDEST', 'HIGHEST_SCORE'];

// ── 1. The comparator alone, on keys ────────────────────────────────────
// One fixture: ties (A/B on every key, C/F on urgency), an unknown score
// (C, F), an unknown price (D stale, F unavailable), a missing filledAt
// (D, F), and a genuine 0.0% (C). Ids are strings, as positions' are.
const KEYS = [
  { id: '1000', t: 'A', keys: { urgency: 0.5,  pnlPct: 5,    filledAtMs: Date.parse('2026-10-30T14:00:00Z'), score: 80 } },
  { id: '1001', t: 'B', keys: { urgency: 0.5,  pnlPct: 5,    filledAtMs: Date.parse('2026-10-30T14:00:00Z'), score: 80 } },
  { id: '1002', t: 'C', keys: { urgency: 0,    pnlPct: 0,    filledAtMs: Date.parse('2026-11-02T15:00:00Z'), score: null } },
  { id: '1003', t: 'D', keys: { urgency: 1,    pnlPct: null, filledAtMs: null,                               score: 60 } },
  { id: '1004', t: 'E', keys: { urgency: 0.33, pnlPct: -3,   filledAtMs: Date.parse('2026-10-29T16:00:00Z'), score: 90 } },
  { id: '0999', t: 'F', keys: { urgency: 0,    pnlPct: null, filledAtMs: null,                               score: null } },
];
const EXPECTED = {
  TIME_LIMIT:    'D A B E F C', // A/B tie -> id; F/C tie at 0 -> id ('0999' < '1002')
  MOST_PROFIT:   'A B C E | F D', // C's 0.0% is ranked, between +5 and -3
  MOST_LOSS:     'E C A B | F D', // unknowns still at the bottom, still in id order
  NEWEST:        'C A B E | F D',
  OLDEST:        'E A B C | F D',
  HIGHEST_SCORE: 'E A B D | F C',
};
// "known | unknown", so the bucket boundary is asserted, not just the order.
function ordered(ctx, mode, input) {
  const cards = input.map(c => ({ ...c, keys: { ...c.keys } }));
  cards.sort(ctx.comparePortfolioCards(mode));
  const key = (ctx.PORTFOLIO_SORTS[mode] || ctx.PORTFOLIO_SORTS.TIME_LIMIT).key;
  const known = cards.filter(c => c.keys[key] != null).map(c => c.t), unknown = cards.filter(c => c.keys[key] == null).map(c => c.t);
  assert.deepStrictEqual(cards.map(c => c.t), [...known, ...unknown], `${mode}: an unknown interleaved with known values`);
  return unknown.length ? `${known.join(' ')} | ${unknown.join(' ')}` : known.join(' ');
}
// Every rotation and the reverse of the input: the sort must not depend on
// the order it was handed (that's what the id tiebreak is for).
const inputs = [...KEYS.map((_, i) => [...KEYS.slice(i), ...KEYS.slice(0, i)]), [...KEYS].reverse()];
function comparatorCtx(blockSrc) {
  const ctx = { Object, String, Number, Date, Math, console, state: {}, localStorage: null, SCORING_VERSION: 2, SCORING_HASH: 'h' };
  vm.createContext(ctx);
  vm.runInContext(blockSrc + '\n;globalThis.PORTFOLIO_SORTS = PORTFOLIO_SORTS; globalThis.comparePortfolioCards = comparePortfolioCards;', ctx);
  return ctx;
}
function assertAllOrderings(ctx) {
  for (const mode of MODES) for (const input of inputs) assert.strictEqual(ordered(ctx, mode, input), EXPECTED[mode], mode);
}

run('all six orderings: ties by id, unknowns pinned to the bottom both ways, 0.0% ranked as 0.0%', () => {
  const ctx = comparatorCtx(sortBlock());
  assert.deepStrictEqual(Object.keys(ctx.PORTFOLIO_SORTS), MODES);
  assert.strictEqual(ctx.PORTFOLIO_SORTS.TIME_LIMIT.label, 'Closest to time limit');
  assertAllOrderings(ctx);
  // An unrecognized mode sorts as the default, never as nothing.
  assert.strictEqual(ordered(ctx, 'BOGUS', KEYS).replace(/ \| /, ' '), EXPECTED.TIME_LIMIT);
});

run('mutations the fixture catches: falsy-as-unknown, no bucket, unknowns following the direction, no tiebreak', () => {
  const block = sortBlock();
  const MUTANTS = {
    '|| (0 read as unknown)':         ['const ux = x == null, uy = y == null;', 'const ux = !x && x !== 0 ? true : !x, uy = !y;'],
    'no unknown bucket':              ['if (ux !== uy) return ux ? 1 : -1;', ''],
    'unknowns follow the direction':  ['if (ux !== uy) return ux ? 1 : -1;', 'if (ux !== uy) return ux ? -dir : dir;'],
    'no id tiebreak':                 ['return comparePositionIds(a.id, b.id);', 'return 0;'],
    'tiebreak reversed by direction': ['return comparePositionIds(a.id, b.id);', 'return dir * comparePositionIds(a.id, b.id);'],
    'direction ignored':              ['if (!ux && x !== y) return x < y ? -dir : dir;', 'if (!ux && x !== y) return x < y ? 1 : -1;'],
  };
  for (const [name, [from, to]] of Object.entries(MUTANTS)) {
    assert.ok(block.includes(from), `mutation anchor missing: ${name}`);
    const ctx = comparatorCtx(block.replace(from, to));
    assert.throws(() => assertAllOrderings(ctx), assert.AssertionError, `mutant survived: ${name}`);
  }
});

run('the stored mode is validated on read; the default is "Closest to time limit"', () => {
  const store = {};
  const ctx = comparatorCtx(sortBlock());
  ctx.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  vm.runInContext('globalThis.cur = currentPortfolioSort; globalThis.set = setPortfolioSort; globalThis.renderPortfolioTab = () => {};', ctx);
  assert.strictEqual(ctx.cur(), 'TIME_LIMIT', 'nothing stored');
  for (const bad of ['', 'most_profit', 'constructor', '__proto__', 'toString', '{"x":1}', 'null']) {
    store.edge2_portfolioSort = bad;
    assert.strictEqual(ctx.cur(), 'TIME_LIMIT', `stored ${JSON.stringify(bad)} falls back to the default`);
  }
  store.edge2_portfolioSort = 'NEWEST';
  assert.strictEqual(ctx.cur(), 'NEWEST');
  ctx.set('MOST_LOSS');
  assert.strictEqual(store.edge2_portfolioSort, 'MOST_LOSS');
  assert.strictEqual(ctx.cur(), 'MOST_LOSS');
  ctx.set('NOT_A_MODE');
  assert.strictEqual(store.edge2_portfolioSort, 'MOST_LOSS', 'an invalid mode is never stored');
  // Storage that throws: the default, and a choice still applies this session.
  const ctx2 = comparatorCtx(sortBlock());
  ctx2.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  vm.runInContext('globalThis.cur = currentPortfolioSort; globalThis.set = setPortfolioSort; globalThis.renderPortfolioTab = () => {};', ctx2);
  assert.strictEqual(ctx2.cur(), 'TIME_LIMIT');
  ctx2.set('OLDEST');
  assert.strictEqual(ctx2.cur(), 'OLDEST');
});

// ── 2. The real renderPortfolioTab, all six modes ──────────────────────
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
// 20 daily closes so RSI and ATR compute; the last is the position's price.
const dailyBars = (last, upTo = '2026-10-30') => {
  const end = Date.parse(upTo + 'T04:00:00Z');
  return Array.from({ length: 20 }, (_, i) => {
    const c = +(last * (0.9 + 0.1 * (i % 3) / 2 + i * 0.004)).toFixed(4);
    return { t: new Date(end - (19 - i) * 86400e3).toISOString(), o: c, h: c * 1.02, l: c * 0.98, c, v: 1e6 };
  });
};
const snapAt = (c, day = '2026-11-02') => ({ dailyBar: { t: `${day}T05:00:00Z`, c, v: 1e6 }, latestTrade: { p: c } });
const SCORING_HASH_REAL = readSource('core/edge-scoring.js').match(/const SCORING_HASH = '([0-9a-f]+)'/)[1];
const sig = (score, scannedAt, extra = {}) => ({ score, label: 'SOFT BUY', scoringVersion: 2, scannedAt,
  signal: { ticker: 'x', score, signal: 'SOFT BUY', scoringVersion: 2, scoringHash: SCORING_HASH_REAL, ...extra } });

function fixture() {
  const pos = (id, ticker, o) => ({ id, ticker, company: ticker + ' Inc', engineSource: 'EDGE', shares: 10, stop: 1, target: 99,
    scoreAtBuy: 70, orderType: 'market', duration: 'WEEK', peakPrice: null, momentumProtectionActivated: false, rsiSuspendedAtGainPct: null, ...o });
  return {
    portfolio: [
      pos('1000', 'AAA', { buyPrice: 10, buyDate: '2026-10-30', filledAt: '2026-10-30T14:00:00.000Z', duration: '3-DAY' }),
      pos('1001', 'BBB', { buyPrice: 20, buyDate: '2026-10-30', filledAt: '2026-10-30T14:00:00.000Z', duration: '3-DAY' }),
      // A real 0.0%: buy 5, now 5.
      pos('1002', 'CCC', { buyPrice: 5, buyDate: '2026-11-02', filledAt: '2026-11-02T15:00:00.000Z', duration: 'DAY' }),
      // An earlier session's close (no trade on the feed today), a legacy
      // row with no filledAt: unknown fill time, never buyDate.
      pos('1003', 'DDD', { buyPrice: 10, buyDate: '2026-10-29', filledAt: null, orderType: null, duration: 'DAY' }),
      pos('1004', 'EEE', { buyPrice: 10, buyDate: '2026-10-29', filledAt: '2026-10-29T16:00:00.000Z', duration: 'WEEK' }),
      // No snapshot at all: priceUnavailable. No score. No filledAt: a
      // legacy row (orderType null), the only holding that can lack one --
      // an order type with no fill is a pending order, not a holding.
      pos('0999', 'FFF', { buyPrice: 8, buyDate: '2026-11-02', filledAt: null, orderType: null, duration: 'WEEK' }),
      // +25% with a lower stored peak: writes peakPrice, activates momentum.
      pos('1005', 'GGG', { buyPrice: 10, buyDate: '2026-10-28', filledAt: '2026-10-28T17:00:00.000Z', peakPrice: 11, duration: 'WEEK' }),
    ],
    snapshots: { AAA: snapAt(10.5), BBB: snapAt(21), CCC: snapAt(5), DDD: snapAt(11, '2026-10-30'), EEE: snapAt(9.7), GGG: snapAt(12.5) },
    ownedScores: {
      AAA: sig(80, NOW - HOUR), BBB: sig(80, NOW - HOUR),
      CCC: sig(75, Date.parse('2026-10-30T21:00:00Z')), // Friday 14:00 PT: before Monday's open
      DDD: sig(60, NOW - HOUR), EEE: sig(90, NOW - 2 * HOUR), GGG: sig(70, NOW - HOUR),
    },
    ownedPrevRSI: { AAA: 55, GGG: 61 },
  };
}

function renderCtx() {
  const ctx = { Date: FakeDate, Math, JSON, Set, Map, Intl, Object, String, Number, Array, Infinity, NaN, isFinite, console, Promise };
  vm.createContext(ctx);
  for (const f of ['core/clock.js', 'core/indicators.js', 'core/market-data.js', 'core/orders.js', 'core/edge-scoring.js']) vm.runInContext(strip(readSource(f)), ctx);
  vm.runInContext([
    sortBlock(), grabFn('renderPortfolioTab'), grabFn('currentSignalForHolding'), grabFn('currentOwnedScore'),
    grabFn('filterByEngine'), grabFn('durHoldLabel'), grabFn('renderIntradayLineCard'),
    grabLine('const MAX_HOLD_DAYS = '), grabLine('const DEFAULT_MAX_LOSS_PCT = '),
  ].join('\n') + '\n;globalThis.renderPortfolioTab = renderPortfolioTab;', ctx);
  return ctx;
}

// One render in `mode` from a fresh copy of the fixture. Records, per
// position, every property write (in order, with its value), plus every
// backgroundSavePosition call's argument as it stood, every persist(), and
// the state maps the loop writes.
async function renderIn(ctx, mode, alter = () => {}) {
  const fx = fixture();
  alter(fx);
  const writes = {}, saves = [], persists = [];
  const tracked = fx.portfolio.map(p => {
    writes[p.id] = [];
    return new Proxy(p, { set(t, k, v) { writes[t.id].push([k, v]); t[k] = v; return true; } });
  });
  const els = { 'tab-content': { innerHTML: '', insertAdjacentHTML() {} }, 'pf-list': { innerHTML: '' }, 'pf-summary': { innerHTML: '' } };
  Object.assign(ctx, {
    state: { settings: { alpacaKey: 'k' }, portfolio: tracked, ownedScores: fx.ownedScores, signals: [], lastScanTime: null,
      ownedPrevRSI: fx.ownedPrevRSI, ownedPeakRSI: {}, portfolioPrices: {}, deletedPositionIds: new Set(), aiCache: {},
      portfolioEngineFilter: 'ALL', portfolioSort: mode, sold: [], macroContext: null },
    document: { getElementById: id => els[id] || null },
    localStorage: { getItem: () => null, setItem() {} },
    fetchSnapshots: async () => fx.snapshots,
    fetchMultiBars: async () => ({ results: Object.fromEntries(Object.entries(fx.snapshots).map(([t, s]) => [t, dailyBars(s.dailyBar.c)])) }),
    fetchAHSnapshots: async () => ({}),
    fetchTodaySipBarsMulti: async () => ({ barsBySymbol: {}, failedSymbols: [] }),
    fetchHeldListing: async tickers => Object.fromEntries(tickers.map(t => [t, 'listed'])),
    fetchAssetStatus: async () => ({}),
    computeIntradayPanel: ({ buyPrice, nowPrice }) => ({ state: 'OK', nowPct: (nowPrice - buyPrice) / buyPrice * 100 }),
    backgroundSavePosition: p => saves.push([p.id, JSON.stringify(p)]),
    persist: k => persists.push(k),
    calcUnifiedRecommendation: () => ({}), buildUnifiedPortfolioBanner: () => '', buildRegisteredEngineExitBanner: () => '',
    getEngine: () => null, neutralEngineExitFallback: () => ({}), buildFridayFlag: () => '',
    updateBudgetBar() {}, buildPendingOrdersHtml: () => '', buildWeekendBanner: () => '', buildEngineFilterControl: () => '',
    renderBuildStatus() {}, checkBuildStatus() {}, renderEngineBadge: () => '', listingWarningText: () => '',
    computeTradeMetrics: () => ({ totalPnL: 0, count: 0, excluded: 0 }),
  });
  await ctx.renderPortfolioTab();
  const list = els['pf-list'].innerHTML;
  return {
    writes, saves, persists, list, summary: els['pf-summary'].innerHTML,
    order: [...list.matchAll(/<div class="pf-ticker">([A-Z]+) /g)].map(m => m[1]).join(' '),
    maps: JSON.stringify([ctx.state.ownedPrevRSI, ctx.state.ownedPeakRSI, ctx.state.portfolioPrices]),
    finalPositions: JSON.stringify(fx.portfolio),
  };
}

const T = { A: 'AAA', B: 'BBB', C: 'CCC', D: 'DDD', E: 'EEE', F: 'FFF', G: 'GGG' };

run('renderPortfolioTab in all six modes: the same writes, the same values, the same saves; only the card order differs', async () => {
  const ctx = renderCtx();
  const r = {};
  for (const mode of MODES) r[mode] = await renderIn(ctx, mode);
  const base = r.TIME_LIMIT;
  // The fixture really exercises the writes (else "identical" is vacuous).
  assert.ok(base.writes['1005'].some(([k, v]) => k === 'momentumProtectionActivated' && v === true), 'GGG activates momentum protection');
  assert.ok(base.writes['1005'].some(([k, v]) => k === 'peakPrice' && v === 12.5), 'GGG peakPrice');
  assert.ok(base.writes['1000'].some(([k, v]) => k === 'prevRSI' && v === 55), 'AAA prevRSI from the previous render');
  assert.ok(base.saves.length >= 3, `saves made: ${base.saves.length}`);
  assert.ok(base.writes['0999'].every(([k]) => k !== 'peakPrice'), 'no peak written from an unavailable price');
  for (const mode of MODES) {
    const m = r[mode];
    for (const id of Object.keys(base.writes)) assert.deepStrictEqual(m.writes[id], base.writes[id], `${mode}: position ${id}'s writes (keys AND values, in order)`);
    assert.deepStrictEqual(m.saves, base.saves, `${mode}: backgroundSavePosition, same calls, same arguments, same order`);
    assert.deepStrictEqual(m.persists, base.persists, `${mode}: persist calls`);
    assert.strictEqual(m.maps, base.maps, `${mode}: ownedPrevRSI / ownedPeakRSI / portfolioPrices`);
    assert.strictEqual(m.finalPositions, base.finalPositions, `${mode}: every position ends identical`);
    assert.strictEqual(m.summary, base.summary, `${mode}: the summary doesn't depend on the order`);
  }
  // Visited in the holdings' own order, whatever the mode.
  assert.deepStrictEqual(base.saves.map(s => s[0]), [...base.saves.map(s => s[0])].sort((a, b) =>
    fixture().portfolio.findIndex(p => p.id === a) - fixture().portfolio.findIndex(p => p.id === b)));
  // End to end: the keys the render built sort as the comparator says.
  const want = {
    TIME_LIMIT:    'D G E A B F C', // closes/window: D 2/1, G 3/5, E 2/5, A=B 1/3 (id), F=C 0 (id)
    MOST_PROFIT:   'G A B C E F D', // C's real 0.0% ranked; F (no price) and D (earlier close) at the bottom, by id
    MOST_LOSS:     'E C A B G F D',
    NEWEST:        'C A B E G F D',
    OLDEST:        'G E A B C F D',
    HIGHEST_SCORE: 'E A B G D F C', // C: Friday's scan, before Monday's open: unknown
  };
  for (const mode of MODES) assert.strictEqual(r[mode].order, want[mode].split(' ').map(x => T[x]).join(' '), mode);
});

run('markers: the earlier close on every P/L it prices, the scan date, the unranked cards', async () => {
  const ctx = renderCtx();
  const profit = await renderIn(ctx, 'MOST_PROFIT');
  const card = (r, t) => r.list.split('<div class="portfolio-card">').find(c => c.includes(`<div class="pf-ticker">${t} `));
  const ddd = card(profit, 'DDD');
  // Header P/L, the "Now" label, and the intraday "% today" line: three
  // displays of one P/L, one marker, one source.
  assert.strictEqual((ddd.match(/class="pf-earlier-close-tag"[^>]*>2026-10-30 close</g) || []).length, 3, ddd);
  assert.ok(ddd.includes('Not ranked by “Most profit”: price is the 2026-10-30 close'));
  assert.ok(/\$11\.00/.test(ddd), 'the price is still shown (display, not priceUnavailable)');
  assert.ok(!card(profit, 'AAA').includes('pf-earlier-close-tag'), "today's price is unmarked");
  assert.ok(card(profit, 'FFF').includes('Not ranked by “Most profit”: price unavailable'));
  assert.ok(profit.list.includes('<div class="pf-unranked-divider">Not ranked (2) — value unknown</div>'));
  assert.ok(profit.list.indexOf('pf-unranked-divider') < profit.list.indexOf('<div class="pf-ticker">DDD '), 'the divider sits above the unknowns');
  assert.ok(profit.summary.includes('Includes 1 position priced at an earlier session\'s close, no trade on the feed yet today (DDD).'));
  assert.ok(profit.summary.includes('price unavailable (FFF)'));
  // The score label carries the date when the scan wasn't today, and says
  // why the sort won't rank it; today's scan shows the time alone.
  const ccc = card(profit, 'CCC');
  assert.ok(ccc.includes('(scan 2026-10-30 14:00)') && ccc.includes('not current: scanned before the 2026-11-02 open'), ccc);
  assert.ok(card(profit, 'AAA').includes('(scan 09:00)') && !card(profit, 'AAA').includes('not current'));
  const newest = await renderIn(ctx, 'NEWEST');
  assert.ok(card(newest, 'DDD').includes('Not ranked by “Newest purchase”: fill time not recorded'));
  // The default mode has no unknowns here, so no divider and no notes.
  const def = await renderIn(ctx, 'TIME_LIMIT');
  assert.ok(!def.list.includes('pf-unranked-divider') && !def.list.includes('pf-sort-unranked'));
});

run('the unpriced and earlier-close lists are alphabetical, whatever order the holdings are in', async () => {
  const ctx = renderCtx();
  // AAA loses its price and EEE gets an earlier close too; then the same
  // with the holdings reversed, so visit order and alphabetical disagree.
  const alter = reverse => fx => {
    delete fx.snapshots.AAA;
    fx.snapshots.EEE = snapAt(9.7, '2026-10-30');
    if (reverse) fx.portfolio.reverse();
  };
  for (const reverse of [false, true]) {
    const r = await renderIn(ctx, 'TIME_LIMIT', alter(reverse));
    assert.ok(r.summary.includes('price unavailable (AAA, FFF)'), `reverse=${reverse}: ${r.summary}`);
    assert.ok(r.summary.includes('(DDD, EEE)'), `reverse=${reverse}`);
  }
});

run('wiring: the stale-close state never reaches priceUnavailable, exit dispatch or Mark as Sold; the recommendation reads the resolver unchanged', () => {
  const src = grabFn('renderPortfolioTab');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(code.includes('const priceUnavailable = priceFetchFailed || !getLivePrice(snap) || notTradingNow;'), 'priceUnavailable unchanged');
  for (const name of ['showsEarlierSessionClose', 'quoteAge']) {
    const uses = code.split('\n').filter(l => new RegExp(`\\b${name}\\b`).test(l));
    for (const l of uses) {
      assert.ok(!/priceUnavailable\s*=|priceFetchFailed:|openMarkSoldModal|evaluateExit|calcUnifiedRecommendation|exitResult|backgroundSavePosition|peakPrice/.test(l), `${name} reaches the exit path: ${l.trim()}`);
    }
  }
  assert.ok(code.includes("calcUnifiedRecommendation({ ...p, currentPrice, rsi, priceFetchFailed: priceUnavailable }, currentSignal, state.macroContext, snap);"), 'recommendation call unchanged');
  assert.ok(code.includes("openMarkSoldModal('${p.id}', ${priceUnavailable ? 'null' : currentPrice})"), 'Mark as Sold pre-fill unchanged');
  assert.ok(!/portfolioScoreState/.test(grabFn('calcUnifiedRecommendation')), 'the recommendation never reads the sort state');
  // No sort before the loop: the loop walks holdings itself.
  assert.ok(code.includes('holdings.forEach(p => {') && !/sortedPortfolio/.test(code));
  assert.ok(code.indexOf('cards.sort(comparePortfolioCards(sortMode));') > code.indexOf('holdings.forEach(p => {'));
  // A missing filledAt is unknown: no fallback to buyDate, buyTime or the id.
  assert.ok(code.includes('filledAtMs: p.filledAt ? knownNumber(Date.parse(p.filledAt)) : null,'));
  // ?? / == null, never || on a key.
  assert.ok(!/keys\[[^\]]+\]\s*\|\|/.test(code) && !/pnlPct\s*\|\|/.test(code));
});

run('portfolioScoreState: version, hash and scan time decide known vs unknown; the score itself is never altered', () => {
  const ctx = renderCtx();
  ctx.state = { settings: {} };
  vm.runInContext('globalThis.__ss = portfolioScoreState;', ctx);
  const s = (o) => ctx.__ss({ score: 80, scoringVersion: 2, scoringHash: SCORING_HASH_REAL, scannedAt: NOW - HOUR, ...o });
  assert.deepStrictEqual({ ...s({}) }, { score: 80, unknown: null });
  assert.deepStrictEqual({ ...s({ score: 0 }) }, { score: 0, unknown: null }, 'a real 0 is known');
  // Absent and different are different facts, and say so.
  assert.strictEqual(s({ scoringVersion: undefined }).unknown, 'scoring version not recorded', 'absent');
  assert.strictEqual(s({ scoringVersion: null }).unknown, 'scoring version not recorded', 'absent (null)');
  assert.deepStrictEqual({ ...s({ scoringVersion: 1 }) }, { score: null, unknown: 'scored by scoring v1, current is v2' }, 'present and different');
  assert.strictEqual(s({ scoringHash: 'deadbeef00112233' }).unknown, `scored by formula deadbeef0011, current is ${SCORING_HASH_REAL.slice(0, 12)}`, 'a recorded hash that differs');
  assert.strictEqual(s({ scoringHash: null }).score, 80, 'no hash recorded (stored before 2026-11-02): judged by version');
  assert.strictEqual(s({ scannedAt: null }).unknown, 'scan time not recorded');
  assert.strictEqual(s({ scannedAt: Date.parse('2026-11-02T14:29:00Z') }).unknown, 'scanned before the 2026-11-02 open', '06:29 today');
  assert.strictEqual(s({ scannedAt: Date.parse('2026-11-02T14:31:00Z') }).score, 80, '06:31 today: current');
  assert.strictEqual(ctx.__ss(null).unknown, 'no scan has scored it');
  // A not-evaluated marker reports its own reason, not a claim about a formula.
  assert.strictEqual(ctx.__ss({ score: null, notEvaluatedReason: 'stored score is from scoring v1, current is v2; refreshed at the next scan' }).unknown,
    'not evaluated (stored score is from scoring v1, current is v2; refreshed at the next scan)');
});

run("displayQuoteAge: yesterday's close is marked during and after the session only; unknown is not judged", () => {
  const ctx = renderCtx();
  ctx.state = { settings: {} };
  vm.runInContext('globalThis.__qa = displayQuoteAge;', ctx);
  const fri = snapAt(10, '2026-10-30');
  assert.deepStrictEqual({ ...ctx.__qa(fri, NOW) }, { state: 'EARLIER_SESSION_CLOSE', asOf: '2026-10-30' }, 'Monday 10:00');
  assert.strictEqual(ctx.__qa(fri, Date.parse('2026-11-02T14:00:00Z')).state, 'CURRENT', 'Monday 06:00, pre-market: Friday is the newest close there is');
  assert.strictEqual(ctx.__qa(fri, Date.parse('2026-10-31T18:00:00Z')).state, 'CURRENT', 'Saturday');
  assert.strictEqual(ctx.__qa(snapAt(10), NOW).state, 'CURRENT');
  assert.strictEqual(ctx.__qa(fri, Date.parse('2026-11-03T00:00:00Z')).state, 'EARLIER_SESSION_CLOSE', 'Monday 16:00, after hours');
  assert.strictEqual(ctx.__qa(fri, Date.parse('2026-11-03T01:00:00Z')).state, 'CURRENT', 'Monday 17:00, closed: the newest close there is');
  assert.strictEqual(ctx.__qa({ latestTrade: { p: 3 } }, NOW).state, 'UNJUDGED', 'price not from a dailyBar');
  assert.strictEqual(ctx.__qa(undefined, NOW).state, 'UNJUDGED');
  assert.strictEqual(ctx.__qa({ dailyBar: { c: 3 } }, NOW).state, 'UNJUDGED', 'dailyBar with no date');
});

run('the two clock rules return three NAMED states, each a non-null object; no reader branches on truthiness', () => {
  const ctx = renderCtx();
  ctx.state = { settings: {} };
  vm.runInContext('globalThis.__sa = scanSessionAge; globalThis.__da = dailyBarSessionAge;', ctx);
  const plain = o => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(plain(ctx.__sa(null)), { state: 'UNJUDGED' });
  assert.deepStrictEqual(plain(ctx.__sa(NOW - HOUR)), { state: 'CURRENT' });
  assert.deepStrictEqual(plain(ctx.__sa(Date.parse('2026-10-30T21:00:00Z'))),
    { state: 'PRIOR_SESSION', scan: { date: '2026-10-30', hhmm: '14:00' }, openDate: '2026-11-02' });
  assert.deepStrictEqual(plain(ctx.__da({ dailyBarAgeTradingDays: null, scanSession: 'REGULAR' })), { state: 'UNJUDGED' });
  assert.deepStrictEqual(plain(ctx.__da({ dailyBarAgeTradingDays: 0, scanSession: 'REGULAR' })), { state: 'CURRENT' });
  assert.deepStrictEqual(plain(ctx.__da({ dailyBarAgeTradingDays: 1, scanSession: 'PRE_MARKET', dailyBarAsOf: '2026-10-30' })), { state: 'CURRENT' });
  assert.deepStrictEqual(plain(ctx.__da({ dailyBarAgeTradingDays: 1, scanSession: 'AFTER_HOURS', dailyBarAsOf: '2026-10-30' })), { state: 'EARLIER_SESSION', asOf: '2026-10-30' });
  // Every reader reads .state; none tests the result itself.
  const files = { 'app.js': app, 'core/entry-gate.js': readSource('core/entry-gate.js') };
  let readers = 0;
  for (const [f, src] of Object.entries(files)) {
    for (const m of src.matchAll(/const (\w+) = (?:scanSessionAge|dailyBarSessionAge)\(/g)) {
      readers++;
      const v = m[1], after = src.slice(m.index, m.index + 600);
      assert.ok(!new RegExp(`(!|\\?\\?|\\|\\||&&)\\s*${v}\\b(?!\\.)|\\b${v}\\s*(\\?|&&|\\|\\||==)|if \\(${v}\\)`).test(after), `${f}: ${v} tested by truthiness`);
    }
    assert.ok(!/(scanSessionAge|dailyBarSessionAge)\([^)]*\)\s*(!==?|===?|\?|&&|\|\|)/.test(src), `${f}: a call result compared directly`);
  }
  assert.ok(/dailyBarSessionAge\(signal\)\.state !== 'EARLIER_SESSION'/.test(files['core/entry-gate.js']), 'gate: STALE_DAILY_BAR reads .state');
  assert.ok(readers >= 3, `readers found: ${readers}`);
});

run('the intraday line carries the price tag as a parameter, on every line that shows a percentage', () => {
  const ctx = renderCtx();
  vm.runInContext('globalThis.__il = renderIntradayLineCard;', ctx);
  const TAG = '<span class="pf-earlier-close-tag">2026-10-30 close</span>';
  const up = ctx.__il({ state: 'OK', nowPct: 4.2 }, TAG), down = ctx.__il({ state: 'OK', nowPct: -3.1, maxLossPct: 6 }, TAG);
  assert.ok(up.includes('Up 4.2% today') && up.includes(TAG), up);
  assert.ok(down.includes('Down 3.1% today') && down.includes(TAG), down);
  assert.ok(!ctx.__il({ state: 'OK', nowPct: 4.2 }).includes('pf-earlier-close-tag'), 'no tag passed, none shown');
  for (const st of ['FAILED', 'NO_DATA', 'INACTIVE']) assert.ok(!ctx.__il({ state: st }, TAG).includes(TAG), `${st}: no percentage, so no tag`);
  assert.ok(!/renderIntradayLineCard\([^)]*\)\.replace\(/.test(app), 'never spliced into the renderer\'s markup');
});
