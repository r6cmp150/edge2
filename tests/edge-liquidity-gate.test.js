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

run('a missing, malformed or non-list asset list is unknown too, and never stops the scan', async () => {
  load(() => {});
  const bars = { A: sessions(global.previousTradingDay(TODAY), 25, 2000000) };
  const fresh = new Date().toISOString();
  // What localStorage can hand back: nothing, or a shape no version wrote on purpose.
  const caches = [
    ['absent (empty localStorage)', null],
    ['assets missing', { fetchedAt: fresh, outsideIndex: {} }],
    ['assets not an array', { fetchedAt: fresh, assets: {}, outsideIndex: {} }],
    ['outsideIndex an array', { fetchedAt: fresh, assets: [], outsideIndex: [] }],
    ['outsideIndex null', { fetchedAt: fresh, assets: [], outsideIndex: null }],
  ];
  for (const [label, cache] of caches) {
    // A bad cache is refetched; the fetch here returns a real list, so it must end "listed".
    load(alpaca({ assets: [asset('A')], bars }), { universeAssetCache: cache });
    assert.deepStrictEqual(await global.getAssetListing(['A']), { A: 'listed' }, label + ': refetched, not read');
  }
  // And when the refetch itself returns no list: unknown, the scan still runs.
  for (const [label, body] of [['null', null], ['an object', { message: 'forbidden' }], ['an empty list', []]]) {
    load(async (path, params) => path === '/v2/assets' ? body : { bars: { A: bars.A }, next_page_token: null },
      { universeAssetCache: null });
    const { candidates, rule } = await global.runEdgePrefilter(['A'], { A: snapAt(5) }, { today: TODAY, minIexVolume: 100000 });
    assert.deepStrictEqual(candidates.map(([x]) => x), ['A'], `/v2/assets returning ${label}: nothing is marked delisted`);
    assert.strictEqual(rule.requires_listed_tradable, false, label);
    assert.ok(rule.asset_check_unavailable, label);
    assert.strictEqual(global.state.universeAssetCache, null, `${label}: a non-list or short list is not kept as the cache`);
  }
});

run('a dead holding takes the priceUnavailable path: no P&L, CANNOT EVALUATE, no sale pre-fill', () => {
  const app = readSource('app.js');
  const start = app.indexOf('async function renderPortfolioTab() {');
  const tab = app.slice(start, app.indexOf('\n}\n', start));
  const has = s => tab.includes(s);
  assert.ok(has("const notTradingNow = !!listing && listing !== 'listed';"));
  assert.ok(has('const priceUnavailable = priceFetchFailed || !getLivePrice(snap) || notTradingNow;'),
    'the existing flag, not new logic: P&L "—", summary excludes it, recommendation CANNOT EVALUATE, Mark as sold not pre-filled');
  assert.ok(tab.indexOf('const listing = heldListing') < tab.indexOf('const priceUnavailable ='), 'listing is known before the flag is set');
  assert.ok(has("let intradayPanel = notTradingNow ? { state: 'INACTIVE' }"), "the intraday line says it stopped trading, not 'connection issue'");
  // The consumers the flag already drives (unchanged; asserted so a refactor can't drop one).
  assert.ok(has('priceFetchFailed: priceUnavailable }'), 'recommendation: CANNOT EVALUATE');
  assert.ok(has("openMarkSoldModal('${p.id}', ${priceUnavailable ? 'null' : currentPrice})"), 'Mark as sold: no pre-filled price');
  assert.ok(has('if (priceUnavailable) {\n        summaryUnpricedTickers.push(p.ticker);'), 'summary: named, never summed');
  // A registered engine (Warrior) is not asked for exit advice on a price
  // that isn't live: its evaluateExit would answer HOLDING, still a verdict.
  assert.ok(has("const exitResult = priceUnavailable\n        ? { status: 'CANNOT_EVALUATE',"), 'engine exit advice gated on priceUnavailable');
  const bStart = app.indexOf('function buildRegisteredEngineExitBanner(');
  // eslint-disable-next-line no-eval
  eval(app.slice(bStart, app.indexOf('\n}\n', bStart) + 2) + '\nglobal.__banner = buildRegisteredEngineExitBanner;');
  const html = global.__banner({ status: 'CANNOT_EVALUATE', reasons: ['Live price unavailable this render — cannot evaluate exit'] });
  assert.ok(html.includes('<strong>CANNOT EVALUATE</strong>') && html.includes('ur-hold-mixed') && !/HOLDING|SELL/.test(html),
    "renders as EDGE's CANNOT EVALUATE does (same class), with no verdict");
  // The nav badge's own engine call is safe through the same flag: the card
  // drops the cached price, and the badge skips a holding without one.
  assert.ok(has('if (priceUnavailable) delete state.portfolioPrices[p.ticker];'));
  const nStart = app.indexOf('function updateNavBadges() {');
  assert.ok(app.slice(nStart, app.indexOf('\n}\n', nStart)).includes('if (price == null || state.portfolioPriceFetchFailed) return;'));
});

run('the scan line always names the rule, from its own parameters (normal case included)', () => {
  const app = readSource('app.js');
  const grab = name => { const i = app.indexOf(`function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i) + 2); };
  global.state = {};
  // eslint-disable-next-line no-eval
  eval(grab('describePrefilterRule') + grab('buildPrefilterRuleSuffixHtml') + '\nglobal.__suffix = buildPrefilterRuleSuffixHtml;');
  // The rule object scan 5420325f stored on 2026-10-26, verbatim.
  global.state.lastPrefilterRule = { rule: 'trailing_sip_avg', price_max: 20, price_min: 1, min_avg_shares: 1000000, requires_through: '2026-10-23', lookback_sessions: 20, requires_listed_tradable: true, calendar_previous_trading_day: '2026-10-23' };
  const normal = global.__suffix();
  console.log('normal:', normal);
  assert.ok(normal.includes('pool: 20-session avg volume ≥ 1,000,000 through 10-23 · $1–$20 · listed &amp; tradable'), normal);
  // A later floor change must show as itself (the reason the parameters live in the value).
  global.state.lastPrefilterRule = { rule: 'trailing_sip_avg', price_min: 2, price_max: 15, min_avg_shares: 2500000, lookback_sessions: 30, requires_through: '2027-02-12', requires_listed_tradable: true };
  assert.ok(global.__suffix().includes('pool: 30-session avg volume ≥ 2,500,000 through 02-12 · $2–$15 · listed &amp; tradable'), global.__suffix());
  global.state.lastPrefilterRule = { rule: 'iex_today_fallback', min_volume: 100000, price_min: 1, price_max: 20, requires_listed_tradable: false, reason: 'x', asset_check_unavailable: 'y' };
  const fb = global.__suffix();
  assert.ok(fb.includes("pool: today's IEX volume ≥ 100,000 · $1–$20</span>"), fb);
  assert.ok(!fb.includes('listed &amp; tradable'), 'the listing test was skipped, so the line must not claim it ran');
  assert.ok(fb.includes('used today') && fb.includes('could not run'), 'degradations still follow it');
  global.state.lastPrefilterRule = { rule: 'something_new' };
  assert.ok(global.__suffix().includes('pool rule: something_new'), 'an unknown shape is named, not guessed at');
  global.state.lastPrefilterRule = null;
  assert.strictEqual(global.__suffix(), '', 'nothing before a scan has run');
});

run('the zero state says the count, the best score and the line it fell short of', () => {
  const app = readSource('app.js');
  const grab = name => { const i = app.indexOf(`function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i) + 2); };
  global.scoreThresholds = () => ({ watch: 20, soft: 65, strong: 110 });
  // eslint-disable-next-line no-eval
  const i0 = app.indexOf('const SCAN_STALE_AFTER_MS');
  // eslint-disable-next-line no-eval
  eval(app.slice(i0, app.indexOf('\n', i0) + 1).replace('const ', 'var ') + grab('scanTimeText') + grab('buildNothingQualifiesHtml') + grab('buildNothingShowingText') + '\nglobal.__nq = buildNothingQualifiesHtml; global.__ns = buildNothingShowingText; global.__st = scanTimeText;');
  const sig = (ticker, score) => ({ ticker, score });
  // Monday 10-26's 09:06 PT scan (16:06Z), in shape: 42 showing, best 55, seen 10 minutes later.
  const T = Date.parse('2026-10-26T16:06:00Z');
  const realNow = Date.now; Date.now = () => T + 10 * 60000;
  try {
    global.state = { lastScanTime: T, signals: [sig('CLF', 35), sig('TROX', 55), ...Array.from({ length: 40 }, (_, i) => sig('S' + i, 20 + (i % 30)))] };
    const html = global.__nq();
    console.log('zero state:', html.replace(/<[^>]+>/g, ''));
    assert.strictEqual(html.replace(/<[^>]+>/g, ''), '42 signals · best score 55 · buy line 65 — nothing qualifies in this scan. Scanned 09:06; tap Refresh for a fresh scan.');
    // More than an hour old: said.
    Date.now = () => T + 135 * 60000;
    assert.ok(global.__nq().includes('Scanned 09:06, 2h 15m ago: more than an hour old'), global.__nq());
    assert.strictEqual(global.__st(T + 60 * 60000), 'Scanned 09:06', 'exactly an hour is not "more than an hour"');
  } finally { Date.now = realNow; }
  // Never an explanation of why: no claim about the market anywhere on the Signals tab.
  assert.ok(!/market is quiet|Market is quiet/.test(app.replace(/^\s*\/\/.*$/gm, '')), 'a "market is quiet" claim is back in app.js');
  // The line is read, not assumed: under a different version's lines it says that line.
  global.scoreThresholds = () => ({ watch: 29, soft: 73, strong: 116 });
  assert.ok(global.__nq().includes('buy line 73'), global.__nq());
  global.scoreThresholds = () => ({ watch: 20, soft: 65, strong: 110 });
  global.state.signals.push(sig('HUN', 65));
  assert.strictEqual(global.__nq(), '', 'one buyable (even an owned one) -> no "nothing qualifies"');
  global.state = { signals: [] };
  assert.strictEqual(global.__nq(), '', 'no signals: the other message covers it');
  // Nothing showing: numbers only when this session scored them.
  global.state = { lastScanTime: null, lastFullScanResults: [{ signal: { score: 15 } }, { signal: { score: 10 } }, { signal: null }], lastDisplayThreshold: 20 };
  assert.strictEqual(global.__ns(), '2 scored · best score 15 · display line 20 — nothing showing in this scan. scan time unknown; tap Refresh for a fresh scan.');
  global.state = { lastScanTime: null, lastFullScanResults: null, lastDisplayThreshold: null }; // after a reload
  assert.ok(global.__ns().startsWith('No signals above the display line in this scan.') && !/\d+ scored/.test(global.__ns()), 'no numbers nobody computed');
  // Wired into the Signals tab.
  assert.ok(app.includes('html += buildNothingQualifiesHtml();') && app.includes('${buildNothingShowingText()}'));
  assert.ok(app.includes('state.lastDisplayThreshold = displayThreshold;'));
});

run('the fallback volume control is shown read-only, with the reason', () => {
  const app = readSource('app.js');
  const i = app.indexOf('Fallback volume threshold (today, IEX)');
  const row = app.slice(i, app.indexOf('.join(', i));
  assert.ok(row.includes('Applies only when the daily volume fetch fails; the live rule is a 1M-share average over the last 20 sessions'));
  assert.ok(row.includes('aria-disabled="true"') && row.includes('pointer-events:none'));
  assert.ok(!row.includes('onclick=') && !app.includes('function setMinVol'), 'nothing can change it');
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
