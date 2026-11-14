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
      // A score (85, so ranking it would put it second) with NO scan time:
      // scanSessionAge -> UNJUDGED, where the two readers deliberately
      // disagree. The sort must not rank it; the gate must pass it.
      pos('1006', 'HHH', { buyPrice: 10, buyDate: '2026-10-30', filledAt: '2026-10-30T18:00:00.000Z', duration: 'WEEK' }),
    ],
    snapshots: { AAA: snapAt(10.5), BBB: snapAt(21), CCC: snapAt(5), DDD: snapAt(11, '2026-10-30'), EEE: snapAt(9.7), GGG: snapAt(12.5), HHH: snapAt(10.2) },
    ownedScores: {
      AAA: sig(80, NOW - HOUR), BBB: sig(80, NOW - HOUR),
      CCC: sig(75, Date.parse('2026-10-30T21:00:00Z')), // Friday 14:00 PT: before Monday's open
      DDD: sig(60, NOW - HOUR), EEE: sig(90, NOW - 2 * HOUR), GGG: sig(70, NOW - HOUR),
      HHH: sig(85, undefined), // stored with no scannedAt
    },
    ownedPrevRSI: { AAA: 55, GGG: 61 },
  };
}

function renderCtx() {
  // CHANGED 2026-11-12, declared: the scan price history adds hooks these functions now call; stubbed here, held by tests/scan-history.test.js.
  const ctx = { Date: FakeDate, Math, JSON, Set, Map, Intl, Object, String, Number, Array, Infinity, NaN, isFinite, console, Promise,
    scanHistoryCardHtml: () => '', ensureScanHistory: () => {}, refreshScanHistoryDom: () => {} };
  vm.createContext(ctx);
  for (const f of ['core/clock.js', 'core/indicators.js', 'core/market-data.js', 'core/orders.js', 'core/edge-scoring.js', 'core/entry-gate.js']) vm.runInContext(strip(readSource(f)), ctx);
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
  // CHANGED 2026-11-13, declared: two optional fixture hooks (fx.barsFail: the daily-bar fetch throws; fx.bars[t]:
  // that symbol's bars) and rsiSeen/captures, which record the RSI each verdict and capture was handed. Existing
  // cases set neither hook and read neither map.
  const writes = {}, saves = [], persists = [], verdicts = {}, rsiSeen = {}, captures = [];
  const tracked = fx.portfolio.map(p => {
    writes[p.id] = [];
    return new Proxy(p, { set(t, k, v) { writes[t.id].push([k, v]); t[k] = v; return true; } });
  });
  const els = { 'tab-content': { innerHTML: '', insertAdjacentHTML() {} }, 'pf-list': { innerHTML: '' }, 'pf-summary': { innerHTML: '' } };
  Object.assign(ctx, {
    state: { settings: { alpacaKey: 'k' }, portfolio: tracked, ownedScores: fx.ownedScores, signals: [], lastScanTime: null,
      ownedPrevRSI: fx.ownedPrevRSI, ownedPeakRSI: {}, portfolioPrices: {}, displayedVerdicts: {}, deletedPositionIds: new Set(), aiCache: {},
      portfolioEngineFilter: 'ALL', portfolioSort: mode, sold: [], macroContext: null },
    document: { getElementById: id => els[id] || null },
    localStorage: { getItem: () => null, setItem() {} },
    fetchSnapshots: async () => fx.snapshots,
    fetchMultiBars: fx.barsFail ? async () => { throw new Error('bars down (fixture)'); }
      : async () => ({ results: Object.fromEntries(Object.entries(fx.snapshots).map(([t, s]) => [t, (fx.bars && fx.bars[t]) || dailyBars(s.dailyBar.c)])) }),
    fetchAHSnapshots: async () => ({}),
    fetchTodaySipBarsMulti: async () => ({ barsBySymbol: {}, failedSymbols: [] }),
    fetchHeldListing: async tickers => Object.fromEntries(tickers.map(t => [t, 'listed'])),
    fetchAssetStatus: async () => ({}),
    computeIntradayPanel: ({ buyPrice, nowPrice }) => ({ state: 'OK', nowPct: (nowPrice - buyPrice) / buyPrice * 100 }),
    backgroundSavePosition: p => saves.push([p.id, JSON.stringify(p)]),
    persist: k => persists.push(k),
    // Record what each verdict was computed from: "computed, never blocked".
    calcUnifiedRecommendation: (pos) => { verdicts[pos.ticker] = { engine: 'EDGE', price: pos.currentPrice, priceFetchFailed: pos.priceFetchFailed }; rsiSeen[pos.ticker] = { rsi: pos.rsi, why: pos.rsiNotMeasured }; return {}; },
    buildUnifiedPortfolioBanner: (r, tag) => `<div class="stub-banner" data-tag="${tag === undefined ? 'UNDEFINED' : tag ? 'TAG:' + encodeURIComponent(tag) : ''}"></div>`,
    buildRegisteredEngineExitBanner: (r, tag) => `<div class="stub-banner" data-status="${r.status}" data-tag="${tag === undefined ? 'UNDEFINED' : tag ? 'TAG:' + encodeURIComponent(tag) : ''}"></div>`,
    getEngine: () => ({ evaluateExit: (pos, live) => { verdicts[pos.ticker] = { engine: pos.engineSource, price: live.price }; return { status: 'HOLDING', reasons: [] }; } }),
    neutralEngineExitFallback: () => ({}), buildFridayFlag: () => '', capturedDisplay: (v, inputs) => { captures.push(inputs); return {}; }, macroConditionForRecord: () => null,
    updateBudgetBar() {}, buildPendingOrdersHtml: () => '', buildWeekendBanner: () => '', buildEngineFilterControl: () => '',
    renderBuildStatus() {}, checkBuildStatus() {}, renderEngineBadge: () => '', listingWarningText: () => '',
    computeTradeMetrics: () => ({ totalPnL: 0, count: 0, excluded: 0 }),
  });
  await ctx.renderPortfolioTab();
  const list = els['pf-list'].innerHTML;
  return {
    writes, saves, persists, verdicts, rsiSeen, captures, peak: { ...ctx.state.ownedPeakRSI }, prev: { ...ctx.state.ownedPrevRSI }, list, summary: els['pf-summary'].innerHTML,
    order: [...list.matchAll(/<div class="pf-ticker">([A-Z]+) /g)].map(m => m[1]).join(' '),
    maps: JSON.stringify([ctx.state.ownedPrevRSI, ctx.state.ownedPeakRSI, ctx.state.portfolioPrices]),
    finalPositions: JSON.stringify(fx.portfolio),
  };
}

const T = { A: 'AAA', B: 'BBB', C: 'CCC', D: 'DDD', E: 'EEE', F: 'FFF', G: 'GGG', H: 'HHH' };

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
    TIME_LIMIT:    'D G E A B H F C', // closes/window: D 2/1, G 3/5, E 2/5, A=B 1/3 (id), H 1/5, F=C 0 (id)
    MOST_PROFIT:   'G A B H C E F D', // C's real 0.0% ranked; F (no price) and D (earlier close) at the bottom, by id
    MOST_LOSS:     'E C H A B G F D',
    NEWEST:        'C H A B E G F D',
    OLDEST:        'G E A B H C F D',
    HIGHEST_SCORE: 'E A B G D F C H', // C: Friday's scan; H: no scan time (85, would be 2nd): both unknown, by id
  };
  for (const mode of MODES) assert.strictEqual(r[mode].order, want[mode].split(' ').map(x => T[x]).join(' '), mode);
});

run('a score with no scan time: the sort refuses to rank it, the gate passes it (the deliberate disagreement, at both readers)', async () => {
  const ctx = renderCtx();
  const r = await renderIn(ctx, 'HIGHEST_SCORE');
  const hhh = r.list.split('<div class="portfolio-card">').find(c => c.includes('<div class="pf-ticker">HHH '));
  assert.ok(hhh.includes('Not ranked by “Highest current score”: scan time not recorded'), hhh);
  assert.ok(hhh.includes('not current: scan time not recorded'), 'the card says so beside the score');
  // The SAME resolved signal, through the real gate, at the same moment:
  // UNJUDGED passes there (no evidence of a problem), so no PRIOR_SESSION.
  vm.runInContext('globalThis.__resolved = currentSignalForHolding("HHH"); globalThis.__gate = entryGateForSignal(globalThis.__resolved);', ctx);
  assert.strictEqual(ctx.__resolved.score, 85);
  assert.strictEqual(ctx.__resolved.scannedAt, null);
  assert.strictEqual(ctx.__gate.rule, null, `gate: ${JSON.stringify(ctx.__gate)}`);
  assert.strictEqual(ctx.__gate.gated, false);
  // And a scan before the open is refused by BOTH readers (they agree there).
  vm.runInContext('globalThis.__ccc = entryGateForSignal(currentSignalForHolding("CCC"));', ctx);
  assert.strictEqual(ctx.__ccc.rule, 'PRIOR_SESSION');
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

run('wiring: the stale-close state never reaches priceUnavailable or exit dispatch; it only marks displays and withholds the sale pre-fill', () => {
  const src = grabFn('renderPortfolioTab');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(code.includes('const priceUnavailable = priceFetchFailed || !getLivePrice(snap) || notTradingNow;'), 'priceUnavailable unchanged');
  for (const name of ['showsEarlierSessionClose', 'quoteAge']) {
    const uses = code.split('\n').filter(l => new RegExp(`\\b${name}\\b`).test(l));
    for (const l of uses) {
      // Mark as Sold is the one record path it reaches, and only to WITHHOLD
      // (asserted exactly below); a verdict is never blocked for it.
      if (/openMarkSoldModal/.test(l)) continue;
      assert.ok(!/priceUnavailable\s*=|priceFetchFailed:|evaluateExit|calcUnifiedRecommendation|exitResult\s*=|backgroundSavePosition|peakPrice/.test(l), `${name} reaches the exit path: ${l.trim()}`);
    }
  }
  // CHANGED 2026-11-13, declared: the call also carries rsiNotMeasured (the RSI is measured or null, with its reason).
  assert.ok(code.includes("calcUnifiedRecommendation({ ...p, currentPrice, rsi, rsiNotMeasured, priceFetchFailed: priceUnavailable }, currentSignal, state.macroContext, snap);"), 'recommendation call unchanged');
  assert.ok(code.includes("openMarkSoldModal('${p.id}', ${(priceUnavailable || showsEarlierSessionClose) ? 'null' : currentPrice}, ${showsEarlierSessionClose ? `'${quoteAge.asOf}'` : 'null'})"), 'Mark as Sold: withheld on an earlier close, never pre-filled from it');
  // The verdict is computed whatever the quote's age: the exit dispatch
  // conditions mention priceUnavailable only.
  assert.ok(code.includes("const exitResult = priceUnavailable\n        ? { status: 'CANNOT_EVALUATE',"), 'exit dispatch gated on priceUnavailable alone');
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
  // LINT (not a test; the behavioural tests above are the tests): STATE IS
  // DETERMINED FROM .state ALONE. Every use of a result is one of:
  //   - `.state === / !== '<a literal from that function's own state set>'`
  //   - a payload field READ (or destructure), only after the reader has
  //     already compared .state to a literal, and never as a condition itself
  // `if (age.state)` (truthy for every state), `!age`, `age && …`, a
  // misspelt state, and `if (!x.asOf)` (correct today only because only one
  // state carries asOf; see the producer test above) all fail.
  const STATES = { scanSessionAge: ['UNJUDGED', 'CURRENT', 'PRIOR_SESSION'], dailyBarSessionAge: ['UNJUDGED', 'CURRENT', 'EARLIER_SESSION'] };
  const PAYLOAD = { scanSessionAge: ['scan', 'openDate'], dailyBarSessionAge: ['asOf'] };
  const files = { 'app.js': app, 'core/entry-gate.js': readSource('core/entry-gate.js') };
  const strip = src => src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const lit = fn => `(?:===|!==)\\s*'(?:${STATES[fn].join('|')})'`;
  let uses = 0;
  for (const [f, raw] of Object.entries(files)) {
    const src = strip(raw);
    for (const fn of Object.keys(STATES)) {
      for (const m of src.matchAll(new RegExp(`(?<!function )\\b${fn}\\(`, 'g'))) {
        const before = src.slice(Math.max(0, m.index - 40), m.index), callEnd = src.indexOf(')', m.index) + 1;
        const v = (before.match(/const (\w+) = $/) || [])[1];
        if (!v) { // used inline: must be compared to a literal right there
          uses++;
          assert.ok(new RegExp(`^\\.state\\s*${lit(fn)}`).test(src.slice(callEnd)), `${f}: ${fn}(…) used inline without a literal state comparison: ${src.slice(m.index, callEnd + 40)}`);
          continue;
        }
        const body = src.slice(callEnd, src.indexOf('\n}\n', callEnd));
        for (const u of body.matchAll(new RegExp(`\\b${v}\\b`, 'g'))) {
          uses++;
          const rest = body.slice(u.index + v.length), lead = body.slice(Math.max(0, u.index - 6), u.index);
          const stateCompare = new RegExp(`^\\.state\\s*${lit(fn)}`).test(rest);
          const payloadRead = new RegExp(`^\\.(?:${PAYLOAD[fn].join('|')})\\b`).test(rest);
          const destructure = /\}\s*=\s*$/.test(lead) && /^\s*;/.test(rest);
          const ctxt = `…${body.slice(Math.max(0, u.index - 30), u.index + 40)}…`;
          assert.ok(stateCompare || payloadRead || destructure, `${f}: ${fn} result '${v}' used without a literal state comparison: ${ctxt}`);
          if (payloadRead || destructure) {
            // Read inside a branch .state already established...
            const established = new RegExp(`\\b${v}\\.state\\s*${lit(fn)}`).test(body.slice(0, u.index));
            assert.ok(established, `${f}: ${fn} payload of '${v}' read before any .state comparison: ${ctxt}`);
            // ...and never the branch condition itself.
            const afterField = rest.replace(/^\.\w+/, '');
            const asCondition = /(?:!|&&|\|\||\?|if \(|while \()\s*$/.test(body.slice(Math.max(0, u.index - 8), u.index))
              || /^\s*(?:\)|\?|&&|\|\||[=!]==?|[<>])/.test(afterField);
            assert.ok(!asCondition, `${f}: ${fn} payload of '${v}' used as a condition (state comes from .state alone): ${ctxt}`);
          }
        }
      }
    }
  }
  assert.ok(uses >= 8, `uses checked: ${uses}`);
});

run('PRODUCER INVARIANT: only the stale state carries a payload (asOf; scan/openDate), for every input', () => {
  // Readers branch on .state; this pins the payload to its state at the
  // source, so adding asOf to CURRENT (a reasonable-looking change) fails
  // HERE and sends whoever makes it to the readers, instead of to a wrong card.
  const ctx = renderCtx();
  ctx.state = { settings: {} };
  vm.runInContext('globalThis.__sa = scanSessionAge; globalThis.__da = dailyBarSessionAge;', ctx);
  const keys = o => Object.keys(o).sort().join(',');
  let n = 0;
  for (const age of [null, undefined, 0, 1, 2, 30, NaN]) for (const scanSession of ['PRE_MARKET', 'REGULAR', 'AFTER_HOURS', 'CLOSED', null]) {
    for (const dailyBarAsOf of ['2026-10-30', null, '']) {
      const r = ctx.__da({ dailyBarAgeTradingDays: age, scanSession, dailyBarAsOf });
      n++;
      assert.strictEqual(keys(r), r.state === 'EARLIER_SESSION' ? 'asOf,state' : 'state', `dailyBarSessionAge(${age}, ${scanSession}) -> ${JSON.stringify(r)}`);
    }
  }
  for (const at of [null, undefined, NOW - HOUR, NOW - 5 * HOUR, Date.parse('2026-10-30T21:00:00Z'), Date.parse('2026-11-02T14:29:00Z'), Date.parse('2026-11-02T14:30:00Z'), 0]) {
    const r = ctx.__sa(at);
    n++;
    assert.strictEqual(keys(r), r.state === 'PRIOR_SESSION' ? 'openDate,scan,state' : 'state', `scanSessionAge(${at}) -> ${JSON.stringify(r)}`);
  }
  assert.ok(n > 100);
});

run('state.portfolioPrices is session-only: never persisted or restored, so no entry can predate the { price, quoteAge } shape', () => {
  // updateNavBadges reads cached.quoteAge.state unguarded. That is safe only
  // while every entry comes from this build's render; if this map is ever
  // persisted or restored, an old bare-number entry would throw there.
  assert.ok(!/persist\(\s*'portfolioPrices'\s*\)/.test(app), 'never persisted');
  const restore = app.match(/function loadState\(\) \{[\s\S]*?\]\.forEach\(k => \{/)[0];
  assert.ok(!restore.includes("'portfolioPrices'"), 'never restored by loadState');
  const writes = [...app.matchAll(/state\.portfolioPrices\[[^\]]+\]\s*=(?!=)/g)].map(m => m[0]);
  assert.deepStrictEqual(writes, ['state.portfolioPrices[p.ticker] ='], 'one write site');
  const reads = app.split('\n').filter(l => /state\.portfolioPrices\b/.test(l) && !/^\s*\/\//.test(l) && !/^\s*portfolioPrices:/.test(l));
  assert.strictEqual(reads.length, 3, `writer pair + one reader, nothing else: ${reads.join(' | ')}`);
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

run('exit side, display: the verdict is computed and carries the same tag as the P/L; Mark as Sold withholds the earlier close', async () => {
  const ctx = renderCtx();
  const r = await renderIn(ctx, 'TIME_LIMIT');
  const card = t => r.list.split('<div class="portfolio-card">').find(c => c.includes(`<div class="pf-ticker">${t} `));
  const tagOf = t => decodeURIComponent((card(t).match(/class="stub-banner" data-tag="([^"]*)"/) || [])[1]);
  const DDD_TAG = 'TAG:<span class="pf-earlier-close-tag" title="No trade on the feed yet today: this is the 2026-10-30 close">2026-10-30 close</span>';
  // The banner gets EXACTLY the tag the P/L got (one state, one source)...
  assert.ok(card('DDD').includes('stub-banner'), 'a verdict is still computed for the earlier-close card');
  assert.strictEqual(tagOf('DDD'), DDD_TAG);
  assert.ok(card('DDD').includes(DDD_TAG.slice(4)), 'the same span is on the P/L');
  // ...and nothing on a current price. Never undefined: always passed.
  for (const t of ['AAA', 'CCC', 'EEE', 'GGG', 'HHH']) assert.strictEqual(tagOf(t), '', t);
  // Computed, never blocked: the verdict ran on the earlier close itself,
  // not as CANNOT EVALUATE.
  assert.deepStrictEqual({ ...r.verdicts.DDD }, { engine: 'EDGE', price: 11, priceFetchFailed: false });
  assert.strictEqual(r.verdicts.FFF.priceFetchFailed, true, 'an unavailable price is still CANNOT EVALUATE (calcUnifiedRecommendation decides it), unchanged');
  // A registered engine's position on an earlier close: evaluated too, and marked.
  const w = await renderIn(ctx, 'TIME_LIMIT', fx => { fx.portfolio.find(p => p.ticker === 'DDD').engineSource = 'WARRIOR'; });
  const wddd = w.list.split('<div class="portfolio-card">').find(c => c.includes('<div class="pf-ticker">DDD '));
  assert.deepStrictEqual({ ...w.verdicts.DDD }, { engine: 'WARRIOR', price: 11 }, 'evaluateExit called on the earlier close');
  assert.ok(wddd.includes('data-status="HOLDING"'), 'its verdict is shown, not CANNOT_EVALUATE');
  assert.strictEqual(decodeURIComponent(wddd.match(/data-tag="([^"]*)"/)[1]), DDD_TAG);
  // Mark as Sold: withheld (null) with the close named; a current price pre-fills.
  assert.ok(card('DDD').includes(`openMarkSoldModal('1003', null, '2026-10-30')`), card('DDD'));
  assert.ok(card('AAA').includes(`openMarkSoldModal('1000', 10.5, null)`));
  assert.ok(card('FFF').includes(`openMarkSoldModal('0999', null, null)`), 'unavailable: null, no close to name');
  // The badge's cache carries the card's own state.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state.portfolioPrices.DDD)), { price: 11, quoteAge: { state: 'EARLIER_SESSION_CLOSE', asOf: '2026-10-30' } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state.portfolioPrices.AAA)), { price: 10.5, quoteAge: { state: 'CURRENT' } });
  assert.ok(!('FFF' in ctx.state.portfolioPrices), 'no price, no cache entry (unchanged)');
});

run('exit side, the real banner builders: every branch carries the tag when given, none when not', () => {
  const ctx = { console, Math };
  vm.createContext(ctx);
  const src = ['getUnifiedBannerClass', 'unifiedFactorLine', 'buildUnifiedPortfolioBanner', 'buildRegisteredEngineExitBanner'].map(grabFn).join('\n');
  vm.runInContext(grabLine('const priceBasisLine = ') + src + '\nglobalThis.__u = buildUnifiedPortfolioBanner; globalThis.__w = buildRegisteredEngineExitBanner;', ctx);
  const TAG = '<span class="pf-earlier-close-tag">2026-10-30 close</span>';
  const f = [{ name: 'x', points: -5 }];
  const results = {
    'hard floor': { label: 'SELL NOW', hardFloor: true },
    'cannot evaluate': { label: 'CANNOT EVALUATE', cannotEvaluate: true },
    'lock in profits': { label: 'LOCK IN PROFITS', pnlPct: 31, peakRisk: { topFactors: f } },
    'composite': { label: 'HOLD', composite: 12, topFactors: f },
  };
  for (const [name, res] of Object.entries(results)) {
    assert.ok(ctx.__u(res, TAG).includes(`Computed on the ${TAG}`), `EDGE banner, ${name}`);
    assert.ok(!ctx.__u(res).includes('Computed on the'), `EDGE banner, ${name}, no tag`);
  }
  for (const status of ['SELL_NOW', 'SELL_SOON', 'HOLDING', 'CANNOT_EVALUATE']) {
    assert.ok(ctx.__w({ status, reasons: ['r'] }, TAG).includes(`Computed on the ${TAG}`), `engine banner, ${status}`);
    assert.ok(!ctx.__w({ status, reasons: ['r'] }).includes('Computed on the'), `engine banner, ${status}, no tag`);
  }
});

run('exit side, nav badge: an earlier-close warning is COUNTED (never dropped) and the badge is marked', () => {
  const badge = { textContent: '', title: '', classList: { s: new Set(), toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); }, has(c) { return this.s.has(c); } } };
  // CHANGED 2026-11-13, declared: the badge counts the cards' captured verdicts (state.displayedVerdicts) and
  // computes none. Same assertions; the verdicts are now handed in as the card captured them.
  const shownSell = { verdict: { label: 'SELL NOW' } };
  const run1 = (prices) => {
    const ctx = { console, Math, document: { getElementById: () => badge }, isAfternoonMode: () => true,
      getHoldings: () => [{ id: 'a', ticker: 'AAA', engineSource: 'EDGE' }, { id: 'd', ticker: 'DDD', engineSource: 'EDGE' }, { id: 'z', ticker: 'ZZZ', engineSource: 'EDGE' }],
      getPendingOrders: () => [], isStalePendingOrder: () => false,
      state: { portfolioPrices: prices, portfolioPriceFetchFailed: false, displayedVerdicts: { a: shownSell, d: shownSell, z: shownSell } } };
    vm.createContext(ctx);
    vm.runInContext(grabFn('updateNavBadges') + '\nupdateNavBadges();', ctx);
    return badge;
  };
  const b = run1({ AAA: { price: 10, quoteAge: { state: 'CURRENT' } }, DDD: { price: 11, quoteAge: { state: 'EARLIER_SESSION_CLOSE', asOf: '2026-10-30' } } });
  assert.strictEqual(String(b.textContent), '2', 'both warnings counted; ZZZ (no cached price) adds none');
  assert.ok(b.classList.has('badge-earlier-close'), 'marked');
  assert.strictEqual(b.title, "1 of 2 computed on an earlier session's close (no trade on the feed yet today)");
  const c = run1({ AAA: { price: 10, quoteAge: { state: 'CURRENT' } }, DDD: { price: 11, quoteAge: { state: 'UNJUDGED' } } });
  assert.strictEqual(String(c.textContent), '2');
  assert.ok(!c.classList.has('badge-earlier-close') && c.title === '', 'not marked when nothing counted is on an earlier close');
});

// 2026-11-13: the RSI is measured, or it is not. Until this change, a holding with fewer than 15 daily closes was
// handed p.rsiAtBuy as its current RSI, and that went into ownedPrevRSI and, through Math.max, ownedPeakRSI. A failed
// daily-bar fetch did it to every holding at once. The fixture never had an rsiAtBuy, so the fallback wrote
// undefined, which the `rsi != null` guard dropped: the old suite could not see the defect. Every holding here
// carries one, set ABOVE anything the bars would give, so a substitute would raise the peak.
const withBuyRsi = fx => { for (const p of fx.portfolio) p.rsiAtBuy = 97; };
run('the RSI is measured or not: a failed daily-bar fetch writes no prev or peak RSI, and the card is told why', async () => {
  const ctx = renderCtx();
  const ok = await renderIn(ctx, 'TIME_LIMIT', withBuyRsi);
  // Positive control: with bars, the real calcRSI is measured, written, and is not the buy RSI.
  const measured = Object.entries(ok.rsiSeen).filter(([, s]) => s.rsi != null);
  assert.ok(measured.length >= 5, `measured with bars: ${JSON.stringify(ok.rsiSeen)}`);
  for (const [t, s] of measured) {
    assert.ok(s.rsi !== 97 && s.why == null, `${t}: measured, not the buy RSI`);
    assert.strictEqual(ok.peak[t], s.rsi, `${t}: peak written from the measurement`);
  }
  const down = await renderIn(ctx, 'TIME_LIMIT', fx => { withBuyRsi(fx); fx.barsFail = true; });
  assert.deepStrictEqual(down.peak, {}, 'no peak RSI written from an unmeasured RSI');
  assert.deepStrictEqual(down.prev, { AAA: 55, GGG: 61 }, 'the previous RSI is left as it was, not overwritten');
  assert.ok(!down.persists.includes('ownedPeakRSI') && !down.persists.includes('ownedPrevRSI'), 'nothing persisted for it');
  const edge = Object.entries(down.rsiSeen);
  assert.ok(edge.length >= 5);
  for (const [t, s] of edge) assert.deepStrictEqual({ ...s }, { rsi: null, why: 'the price and daily-bar fetch failed' }, `${t}: not measured, and why`);
  for (const c of down.captures) assert.ok(c.rsi === null && c.rsi_not_measured === 'the price and daily-bar fetch failed', 'the captured card says so too');
});

run('one symbol short of 15 closes: only it is unmeasured; the rest are measured as usual', async () => {
  const ctx = renderCtx();
  const r = await renderIn(ctx, 'TIME_LIMIT', fx => { withBuyRsi(fx); fx.bars = { AAA: dailyBars(10.5).slice(-5) }; });
  assert.deepStrictEqual({ ...r.rsiSeen.AAA }, { rsi: null, why: '5 daily closes came back, 15 needed' });
  assert.ok(!('AAA' in r.peak), 'no peak for AAA');
  assert.strictEqual(r.prev.AAA, 55, "AAA's previous RSI is kept, not replaced by its buy RSI");
  assert.ok(typeof r.rsiSeen.BBB.rsi === 'number' && r.rsiSeen.BBB.rsi !== 97 && r.peak.BBB === r.rsiSeen.BBB.rsi, 'BBB measured and written');
});

// 2026-11-13 (the reviewer: "a count and the thing it counts must come from one computation"). The badge computed
// its own EDGE verdict with the buy's RSI as the current RSI, so it could count a warning no card showed, or miss
// one a card did show. It now counts exactly what the cards show, and nothing a card has not shown.
run('nav badge: it counts what the cards show, never a verdict of its own', () => {
  const badge = { textContent: '', title: '', classList: { toggle() {}, has() { return false; } } };
  const holdings = [
    { id: 'h', ticker: 'HOLD', engineSource: 'EDGE', rsiAtBuy: 80 },   // card: HOLD. The buy RSI would have scored it lower.
    { id: 's', ticker: 'SELL', engineSource: 'EDGE', rsiAtBuy: 45 },   // card: SELL SOON
    { id: 'f', ticker: 'FLOOR', engineSource: 'EDGE', rsiAtBuy: 50 },  // card: a hard floor
    { id: 'w', ticker: 'WAR', engineSource: 'WARRIOR' },              // card: SELL_NOW from the engine
    { id: 'u', ticker: 'UNSEEN', engineSource: 'EDGE', rsiAtBuy: 90 }, // priced, but no card has shown it
  ];
  const prices = Object.fromEntries(holdings.map(p => [p.ticker, { price: 10, quoteAge: { state: 'CURRENT' } }]));
  const computed = [];
  const ctx = { console, Math, document: { getElementById: () => badge }, isAfternoonMode: () => true, getHoldings: () => holdings,
    getPendingOrders: () => [], isStalePendingOrder: () => false,
    // Present so that a badge computing its own verdict is caught doing it, not crashing.
    calcUnifiedRecommendation: p => { computed.push(p.ticker); return { label: p.rsi >= 75 ? 'SELL NOW' : 'HOLD' }; },
    currentSignalForHolding: () => null, getEngine: () => null, neutralEngineExitFallback: () => ({ status: 'HOLDING' }),
    state: { portfolioPrices: prices, portfolioPriceFetchFailed: false, macroContext: null, displayedVerdicts: {
      h: { verdict: { label: 'HOLD' } }, s: { verdict: { label: 'SELL SOON' } }, f: { verdict: { label: 'HOLD', hardFloor: true } },
      w: { verdict: { status: 'SELL_NOW' } } } } };
  vm.createContext(ctx);
  vm.runInContext(grabFn('updateNavBadges') + '\nupdateNavBadges();', ctx);
  assert.deepStrictEqual(computed, [], 'the badge computes no verdict of its own');
  assert.strictEqual(String(badge.textContent), '3', 'SELL SOON, the hard floor and the engine SELL_NOW: what the cards show, and only that');
  assert.ok(!/rsiAtBuy/.test(grabFn('updateNavBadges')), 'the buy RSI is never read as a current one');
});

run('an unknown hold length (start date not a date): unranked in the default sort, said on the card, never "0 closes"', async () => {
  const ctx = renderCtx();
  const r = await renderIn(ctx, 'TIME_LIMIT', fx => {
    const g = fx.portfolio.find(p => p.ticker === 'GGG');
    g.buyDate = 'not-a-date'; g.filledAt = 'also-not-a-date';
  });
  const card = r.list.split('<div class="portfolio-card">').find(c => c.includes('<div class="pf-ticker">GGG '));
  assert.ok(card.includes('Not ranked by “Closest to time limit”: hold window unknown'), card.slice(0, 300));
  assert.ok(card.includes('Hold length unknown'), 'the duration block says so');
  assert.ok(!/Same day ·/.test(card), 'never "Same day"');
  assert.ok(r.list.indexOf('pf-unranked-divider') < r.list.indexOf('<div class="pf-ticker">GGG '), 'below the divider');
});
