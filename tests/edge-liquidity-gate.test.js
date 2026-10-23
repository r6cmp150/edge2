// tests/edge-liquidity-gate.test.js — phase-10 §7.6 step 1f (2026-10-22).
// The EDGE pre-filter's trailing-volume rule, end to end through
// core/universe.js runEdgePrefilter with a mocked Alpaca: 20 COMPLETED SIP
// sessions averaging >= 1M shares, reaching the latest completed session,
// on a listed and tradable asset; the IEX-today fallback when the daily
// bars can't be fetched at all; and the rule each scan records
// (scan_runs.prefilter_rule, db/032).
'use strict';
const assert = require('assert');
const { readSource, run: runNow } = require('./_lib');
// Sequential: every test swaps the mocked Alpaca on global, so they can't overlap.
const queue = [];
const run = (name, fn) => queue.push([name, fn]);

function load(alpacaGet, stateOverrides = {}) {
  global.state = { universeAssetCache: null, edgeLiquidityCache: null, ...stateOverrides };
  global.persist = () => {};
  // eslint-disable-next-line no-eval
  eval(readSource('core/clock.js') + '\nglobal.getPT = getPT; global.ptDateStr = ptDateStr; global.previousTradingDay = previousTradingDay; global.isTradingDay = isTradingDay;');
  global.chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
  global.alpacaGet = alpacaGet;
  global.createApiClient = () => ({ alpacaGet: (...a) => global.alpacaGet(...a) });
  global._coreClient = global.createApiClient('CORE');
  global.assertPageNotSuspiciouslyFull = () => {};
  global.HISTORICAL_BAR_ADJUSTMENT = 'all';
  global.getLivePrice = snap => snap.dailyBar?.c || snap.latestTrade?.p; // core/market-data.js's rule
  // eslint-disable-next-line no-eval
  eval(readSource('core/universe.js') + `
    global.runEdgePrefilter = runEdgePrefilter; global.getEdgeLiquidity = getEdgeLiquidity; global.getAssetListing = getAssetListing;
    global.EDGE_LIQUIDITY_CHUNK_SIZE = EDGE_LIQUIDITY_CHUNK_SIZE; global.EDGE_LIQUIDITY_LOOKBACK_CALENDAR_DAYS = EDGE_LIQUIDITY_LOOKBACK_CALENDAR_DAYS;
    global.EDGE_LIQUIDITY_SESSIONS = EDGE_LIQUIDITY_SESSIONS; global.EDGE_LIQUIDITY_MIN_AVG_SHARES = EDGE_LIQUIDITY_MIN_AVG_SHARES;`);
}

const TODAY = '2026-10-22'; // a Thursday
// n completed sessions ending at `through`, newest last, each `vol` shares.
function sessions(through, n, vol) {
  const out = []; let d = through;
  for (let i = 0; i < n; i++) { out.unshift({ t: d + 'T04:00:00Z', v: typeof vol === 'function' ? vol(i) : vol, c: 5 }); d = global.previousTradingDay(d); }
  return out;
}
// A mocked Alpaca: /v2/assets returns `assets`; /stocks/bars returns each
// requested symbol's bars from `bars` (failing a batch containing a symbol
// in `failBars`).
const FILLER = Array.from({ length: 1000 }, (_, i) => ({ symbol: 'FILL' + i, exchange: 'NYSE', tradable: true, name: 'Filler Corp Common Stock' }));
function alpaca({ assets, bars, failBars = new Set(), failAssets = false, raw = false, log = [] }) {
  return async (path, params) => {
    log.push({ path, params: { ...params } });
    // Padded to a real-sized list: getAssetListing treats a short one as unknown.
    if (path === '/v2/assets') { if (failAssets) throw new Error('assets 503'); return raw ? assets : assets.concat(FILLER); }
    if (path === '/stocks/bars') {
      const syms = params.symbols.split(',');
      if (syms.some(s => failBars.has(s))) throw new Error('bars 503');
      const out = {}; for (const s of syms) if (bars[s]) out[s] = bars[s];
      return { bars: out, next_page_token: null };
    }
    throw new Error('unexpected ' + path);
  };
}
const asset = (symbol, exchange = 'NASDAQ', tradable = true) => ({ symbol, exchange, tradable, name: symbol + ' Inc. Common Stock' });
const snapAt = (price, iexVol = 50000) => ({ dailyBar: { c: price, v: iexVol } });

run('the rule: 20 completed sessions, average >= 1M, reaching the latest session, listed and tradable', async () => {
  load(() => {}); // previousTradingDay for the fixtures
  const Y = global.previousTradingDay(TODAY);
  const bars = {
    LIQ: [...sessions(Y, 25, 1200000), { t: TODAY + 'T04:00:00Z', v: 5000, c: 5 }], // today's partial bar: must not count
    THIN: sessions(Y, 25, 400000),
    EDGE1M: sessions(Y, 20, 1000000),                                   // exactly the floor passes (>=)
    NEW: sessions(Y, 12, 5000000),                                      // a recent listing: fewer than 20 sessions
    AREN: [],                                                           // stopped trading 08-28: nothing in the window
    FROZE: sessions('2026-10-14', 20, 3000000),                         // last session 10-14 (CCO's shape)
    HALT: sessions(Y, 25, 2000000),
    ETF: sessions(Y, 25, 2000000),
    PRICEY: sessions(Y, 25, 2000000),
  };
  const assets = [asset('LIQ'), asset('THIN'), asset('EDGE1M'), asset('NEW'), asset('FROZE'), asset('PRICEY'),
    asset('HALT', 'NASDAQ', false), asset('ETF', 'ARCA')]; // AREN absent: not on the active list
  load(alpaca({ assets, bars }));
  const tickers = Object.keys(bars).concat('NOSNAP');
  const snapshots = {}; for (const t of Object.keys(bars)) snapshots[t] = snapAt(t === 'PRICEY' ? 25 : 5);
  const { candidates, rejections, rule } = await global.runEdgePrefilter(tickers, snapshots, { today: TODAY, minIexVolume: 100000 });
  const failedOf = Object.fromEntries(rejections.map(r => [r.symbol, r.failed]));
  console.log('candidates:', candidates.map(([t]) => t).join(','), '| rejected:', JSON.stringify(failedOf));
  assert.deepStrictEqual(candidates.map(([t]) => t).sort(), ['EDGE1M', 'ETF', 'LIQ'],
    'an ETF on ARCA is listed even though Warrior\'s exchange-filtered index leaves it out');
  assert.deepStrictEqual(failedOf, {
    THIN: ['avg_volume_below_min'],
    NEW: ['no_volume_history'],
    AREN: ['asset_inactive', 'no_volume_history'],
    FROZE: ['volume_history_stale'],
    HALT: ['asset_not_tradable'],
    PRICEY: ['price_above_max'],
    NOSNAP: ['no_snapshot'],
  });
  assert.strictEqual(rejections.length + candidates.length, tickers.length, 'every universe symbol is a candidate or a logged rejection');
  const liq = rejections.find(r => r.symbol === 'THIN');
  assert.deepStrictEqual({ avg: liq.avg_volume_20d, through: liq.volume_history_through, iex: liq.iex_volume }, { avg: 400000, through: Y, iex: 50000 });
  assert.strictEqual(rejections.find(r => r.symbol === 'NEW').avg_volume_20d, null, 'fewer than 20 sessions: no average stored (not computed is not 0)');
  assert.deepStrictEqual(rule, {
    rule: 'trailing_sip_avg', lookback_sessions: 20, min_avg_shares: 1000000, price_min: 1, price_max: 20,
    requires_listed_tradable: true, requires_through: Y, calendar_previous_trading_day: Y,
  });
});

run("today's partial bar is excluded from the average (completed sessions only)", async () => {
  load(() => {});
  const Y = global.previousTradingDay(TODAY);
  // 20 completed sessions at 990k: below the floor. A huge partial bar for
  // today would lift a 20-bar average over 1M if it were counted.
  const bars = { A: [...sessions(Y, 20, 990000), { t: TODAY + 'T04:00:00Z', v: 50000000, c: 5 }] };
  load(alpaca({ assets: [asset('A')], bars }));
  const { rejections } = await global.runEdgePrefilter(['A'], { A: snapAt(5) }, { today: TODAY, minIexVolume: 100000 });
  assert.deepStrictEqual(rejections[0].failed, ['avg_volume_below_min']);
  assert.strictEqual(rejections[0].avg_volume_20d, 990000);
  assert.strictEqual(rejections[0].volume_history_through, Y);
});

run('recency comes from the tape, so a gap in HOLIDAYS cannot reject every symbol', async () => {
  load(() => {});
  // The calendar thinks the previous trading day is Y; the market was in
  // fact closed then (a holiday missing from the table), so every live
  // stock's newest session is the day before.
  const Y = global.previousTradingDay(TODAY), Y2 = global.previousTradingDay(Y);
  const bars = { A: sessions(Y2, 25, 2000000), B: sessions(Y2, 25, 3000000), OLD: sessions('2026-10-01', 25, 3000000) };
  load(alpaca({ assets: [asset('A'), asset('B'), asset('OLD')], bars }));
  const warned = []; const warn = console.warn; console.warn = m => warned.push(m);
  try {
    const { candidates, rejections, rule } = await global.runEdgePrefilter(['A', 'B', 'OLD'], { A: snapAt(5), B: snapAt(5), OLD: snapAt(5) }, { today: TODAY, minIexVolume: 100000 });
    assert.deepStrictEqual(candidates.map(([t]) => t), ['A', 'B'], 'the live stocks pass on the session the tape actually has');
    assert.deepStrictEqual(rejections.map(r => [r.symbol, r.failed]), [['OLD', ['volume_history_stale']]], 'a dead stock is still caught');
    assert.strictEqual(rule.requires_through, Y2);
    assert.strictEqual(rule.calendar_previous_trading_day, Y);
    assert.ok(warned.some(m => /Check core\/clock\.js HOLIDAYS/.test(m)), 'the disagreement is reported');
  } finally { console.warn = warn; }
});

run('no daily bars at all: the scan still runs, on the old IEX-today rule, and says why', async () => {
  load(() => {});
  const bars = { A: sessions(global.previousTradingDay(TODAY), 25, 2000000) };
  load(alpaca({ assets: [asset('A'), asset('B'), asset('DEAD', 'NYSE', false)], bars, failBars: new Set(['A', 'B', 'DEAD']) }));
  const { candidates, rejections, rule } = await global.runEdgePrefilter(['A', 'B', 'DEAD'],
    { A: snapAt(5, 150000), B: snapAt(5, 50000), DEAD: snapAt(5, 500000) }, { today: TODAY, minIexVolume: 100000 });
  assert.deepStrictEqual(candidates.map(([t]) => t), ['A']);
  assert.deepStrictEqual(rejections.map(r => [r.symbol, r.failed]), [['B', ['volume_below_min']], ['DEAD', ['asset_not_tradable']]]);
  assert.strictEqual(rule.rule, 'iex_today_fallback');
  assert.strictEqual(rule.min_volume, 100000);
  assert.strictEqual(rule.requires_listed_tradable, true);
  assert.ok(/every daily-bar batch failed/.test(rule.reason), rule.reason);
});

run('a partly failed fetch rejects only the symbols it lost, never passes them on a guess', async () => {
  load(() => {});
  const Y = global.previousTradingDay(TODAY);
  const many = Array.from({ length: 150 }, (_, i) => 'S' + i); // two chunks of 100 / 50
  const bars = {}; many.forEach(s => { bars[s] = sessions(Y, 25, 2000000); });
  load(alpaca({ assets: many.map(s => asset(s)), bars, failBars: new Set(['S120']) }));
  const snapshots = {}; many.forEach(s => { snapshots[s] = snapAt(5); });
  const { candidates, rejections, rule } = await global.runEdgePrefilter(many, snapshots, { today: TODAY, minIexVolume: 100000 });
  assert.strictEqual(candidates.length, 100);
  assert.strictEqual(rejections.length, 50);
  assert.ok(rejections.every(r => r.failed.join() === 'volume_history_unavailable'));
  assert.strictEqual(rule.rule, 'trailing_sip_avg');
  assert.strictEqual(rule.volume_history_failed_symbols, 50);
});

run('no asset list: the listing test is skipped and the rule says so (requires_listed_tradable false)', async () => {
  load(() => {});
  const bars = { A: sessions(global.previousTradingDay(TODAY), 25, 2000000) };
  load(alpaca({ assets: [], bars, failAssets: true }));
  const { candidates, rule } = await global.runEdgePrefilter(['A'], { A: snapAt(5) }, { today: TODAY, minIexVolume: 100000 });
  assert.deepStrictEqual(candidates.map(([t]) => t), ['A']);
  assert.strictEqual(rule.requires_listed_tradable, false);
  assert.strictEqual(rule.asset_check_unavailable, 'assets 503');
});

run('every rule shape satisfies db/032 (an object whose rule is a string)', async () => {
  const sql = readSource('db/032_scan_runs_prefilter_rule.sql');
  assert.ok(/jsonb_typeof\(prefilter_rule\) = 'object' and jsonb_typeof\(prefilter_rule -> 'rule'\) = 'string'/.test(sql));
  const src = readSource('core/universe.js');
  const runner = src.match(/async function runEdgePrefilter\([^)]*\) \{[\s\S]*?\n\}/)[0];
  assert.deepStrictEqual([...runner.matchAll(/\{ rule: '([a-z_]+)'/g)].map(m => m[1]), ['trailing_sip_avg', 'iex_today_fallback'],
    'exactly the two rule names db/032 documents');
});

run('the day cache: a second scan the same day makes no daily-bar requests; a failed day is not cached', async () => {
  load(() => {});
  const bars = { A: sessions(global.previousTradingDay(TODAY), 25, 2000000) };
  const log = [];
  load(alpaca({ assets: [asset('A')], bars, log }));
  await global.getEdgeLiquidity(['A'], TODAY);
  const r2 = await global.getEdgeLiquidity(['A'], TODAY);
  assert.strictEqual(r2.requests, 0);
  assert.strictEqual(log.filter(l => l.path === '/stocks/bars').length, 1);
  const r3 = await global.getEdgeLiquidity(['A'], '2026-10-23');
  assert.strictEqual(r3.requests, 1, 'a new PT day refetches');

  load(alpaca({ assets: [asset('A')], bars, failBars: new Set(['A']) }));
  await global.getEdgeLiquidity(['A'], TODAY);
  assert.strictEqual(global.state.edgeLiquidityCache, null, 'a day with a failed batch is not cached');
});

run('the bars request: SIP, adjusted, from 45 days back, single-page by proof, paginated anyway', async () => {
  const log = [];
  load(alpaca({ assets: [], bars: {}, log }));
  await global.getEdgeLiquidity(['A'], TODAY);
  const p = log[0].params;
  assert.deepStrictEqual({ feed: p.feed, timeframe: p.timeframe, adjustment: p.adjustment, start: p.start, limit: p.limit },
    { feed: 'sip', timeframe: '1Day', adjustment: 'all', start: '2026-09-07', limit: 10000 });
  // 45 calendar days hold at most 33 weekdays; the chunk must stay single-page.
  assert.ok(global.EDGE_LIQUIDITY_CHUNK_SIZE * 33 < 10000);
  // ...and always hold 20 completed sessions: every date 2024-2026 against the real HOLIDAYS.
  for (let d = new Date('2024-02-15T12:00:00Z'); d < new Date('2027-01-01T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    const start = new Date(d); start.setUTCDate(start.getUTCDate() - global.EDGE_LIQUIDITY_LOOKBACK_CALENDAR_DAYS);
    let n = 0, x = global.previousTradingDay(day);
    while (x >= start.toISOString().slice(0, 10)) { n++; x = global.previousTradingDay(x); }
    assert.ok(n >= global.EDGE_LIQUIDITY_SESSIONS, `${day}: only ${n} sessions in the window`);
  }
  assert.ok(/next_page_token/.test(readSource('core/universe.js').match(/async function _fetchSipDailyBars[\s\S]*?\n\}/)[0]));
});

run('getAssetListing: listed, listed on another exchange, not tradable, not listed; a pre-outsideIndex cache refetches', async () => {
  const log = [];
  load(alpaca({ assets: [asset('A'), asset('ETF', 'ARCA'), asset('NT', 'NYSE', false), asset('OTCX', 'OTC', false)], bars: {}, log }),
    { universeAssetCache: { fetchedAt: new Date().toISOString(), assets: [{ symbol: 'A', exchange: 'NASDAQ', name: 'A', isEligibleInstrument: true }] } });
  const r = await global.getAssetListing(['A', 'ETF', 'NT', 'OTCX', 'GONE']);
  assert.deepStrictEqual(r, { A: 'listed', ETF: 'listed', NT: 'asset_not_tradable', OTCX: 'asset_not_tradable', GONE: 'asset_inactive' });
  assert.strictEqual(log.length, 1, 'a fresh cache without outsideIndex is refetched once');
  await global.getAssetListing(['A']);
  assert.strictEqual(log.length, 1, 'then served from the cache');
  assert.deepStrictEqual(global.state.universeAssetCache.assets.map(a => a.symbol).filter(s => !s.startsWith('FILL')), ['A'], "Warrior's index is unchanged: tradable on NASDAQ/NYSE/AMEX only");
});

run('a short asset list is unknown, not "everything delisted"', async () => {
  load(() => {});
  const bars = { A: sessions(global.previousTradingDay(TODAY), 25, 2000000) };
  load(alpaca({ assets: [], bars, raw: true })); // an empty list that didn't error
  await assert.rejects(global.getAssetListing(['A']), /implausibly short/);
  const { candidates, rule } = await global.runEdgePrefilter(['A'], { A: snapAt(5) }, { today: TODAY, minIexVolume: 100000 });
  assert.deepStrictEqual(candidates.map(([x]) => x), ['A'], 'the pool is not emptied by a non-answer');
  assert.strictEqual(rule.requires_listed_tradable, false);
  assert.ok(/implausibly short/.test(rule.asset_check_unavailable));
});

run('previousTradingDay: weekends and holidays', () => {
  load(() => {});
  assert.strictEqual(global.previousTradingDay('2026-10-22'), '2026-10-21');
  assert.strictEqual(global.previousTradingDay('2026-10-19'), '2026-10-16', 'Monday -> Friday');
  assert.strictEqual(global.previousTradingDay('2026-11-27'), '2026-11-25', 'the day after Thanksgiving -> Wednesday');
  assert.strictEqual(global.previousTradingDay('2026-09-08'), '2026-09-04', 'after Labor Day -> the Friday before');
});

run('held positions and the add confirm: list-based, every holding, warn never block', () => {
  const app = readSource('app.js');
  const tab = app.match(/async function renderPortfolioTab\(\) \{[\s\S]*?\n\}/)[0];
  assert.ok(/const heldListing = await fetchHeldListing\(tickers\);/.test(tab), 'one listing lookup over every holding');
  assert.ok(/\$\{listingBanner\}/.test(tab), 'surfaced on the card');
  assert.ok(/if \(!priceFetchFailed && !heldListing\)/.test(tab), 'the per-ticker /v2/assets check is the fallback only');
  const confirm = app.match(/async function confirmAddPortfolio\([^)]*\) \{[\s\S]*?\n\}/)[0];
  assert.ok(/await fetchHeldListing\(\[ticker\]\)/.test(confirm));
  assert.ok(/showConfirm\(warnings\.join\('\\n\\n'\), \(\) => finalizeAddPortfolio\(ticker, shares, price, date, btn, order\), 'Add anyway'\)/.test(confirm),
    'a listing warning offers "Add anyway": it never blocks the add');
  const fetchHeld = app.match(/async function fetchHeldListing\([^)]*\) \{[\s\S]*?\n\}/)[0];
  assert.ok(/return null;/.test(fetchHeld) && !/'listed'/.test(fetchHeld), 'unknown is null, never "listed"');
});

(async () => { for (const [name, fn] of queue) await runNow(name, fn); })();
