// core/market-data.js — owned by neither engine. core/ never imports from engines/.
// Snapshot + daily/minute/hourly bar fetchers. Feed ('iex' | 'sip') is always
// an explicit parameter at each call site — never a default baked in here.
// Moved from app.js verbatim (Phase 0 extraction). fetchMultiBars' pagination
// gap was fixed in Phase 0.6 (Bug 1) — see the comment on that function.
// Every fetcher here still hardcodes feed:'iex'; that's separate known debt,
// not part of Phase 0.6, not touched here.
//
// HISTORICAL_BAR_ADJUSTMENT (2026-09-01, found live): every 1Day-bar call
// in this codebase omitted Alpaca's adjustment param, defaulting to 'raw'
// (unadjusted) -- confirmed via a live run elsewhere in the app that
// ranked a $0.14->$4.54 (+3,140%) "move" that was almost certainly a
// reverse split. Here it corrupts scoreStock's ma20/high52/low52/
// avgVol10 (EDGE's RVOL equivalent)/consecutive-up-days for any symbol
// that split within the fetched window -- silently, no error, just a
// wrong score. Systemic across every daily-bar consumer in this file;
// fixed together, not one call site at a time.
const HISTORICAL_BAR_ADJUSTMENT = 'all';

// Confirmed in production: Alpaca rejects a batch /stocks/snapshots request
// with a 400 ("invalid symbol") the moment it contains one malformed ticker
// (AAC-U did this) — it does NOT silently omit just that symbol as originally
// assumed below. AAC-U has since been removed from FINANCIAL entirely; these
// remaining 6 are unverified hyphen/share-class tickers (SPAC units, one
// dual-class stock) still in FINANCIAL, now caught unconditionally by
// sanitizeTickerBatch() before any request goes out — this list only drives
// checkUnresolvedSymbols()'s console warning so an exclusion is visible
// rather than silent, it doesn't gate what gets sent anymore.
const UNVERIFIED_HYPHEN_SYMBOLS = ['CRD-A', 'DGAC-U', 'FTRA-U', 'MTNE-U', 'OCAC-U', 'SAMO-U', 'VII-U'];

// HOTFIX: latestQuote bid/ask midpoint branch removed — it produced wildly
// wrong after-hours prices (e.g. GTM showing $1.81 vs an actual $4.12),
// likely a bad/zero bp or ap on the free IEX feed for thinly-quoted
// tickers after hours. Reverted to the single dailyBar/latestTrade read
// that was correct before this helper existed, for ALL market conditions,
// pending investigation into the actual latestQuote field shape.
function getLivePrice(snap) {
  if (!snap) return 0;
  return snap.dailyBar?.c || snap.latestTrade?.p || 0;
}

// CLAUDE.md pagination rule, exemption proof: /stocks/snapshots has no
// `limit` or `next_page_token` at all — it returns exactly one snapshot
// object per requested symbol, keyed by symbol, so the only way to lose data
// here is requesting more symbols than the endpoint accepts in one call.
// chunk(clean, 100) is the size proven safe in production (see
// core/universe.js's SNAPSHOT_CHUNK_SIZE comment) — not a limit that could
// silently truncate a batch, since Alpaca either serves the whole batch or
// errors on the request, it doesn't return a partial page.
// client (2026-08-30): defaults to the shared CORE client (core/api-
// client.js) — same pattern as core/universe.js's own helpers. This is
// the function checkPriceAlerts (app.js) uses to get background priority
// without the ambient-flag hazard (see core/api-client.js's
// withBackgroundPriority removal): pass a client built with
// createApiClient(engine, 'background') instead of wrapping the call.
async function fetchSnapshots(tickers, onProgress, client = _coreClient) {
  const clean = sanitizeTickerBatch(tickers);
  const results = {};
  let done = 0;
  for (const batch of chunk(clean, 100)) {
    const data = await client.alpacaGet('/stocks/snapshots', { symbols: batch.join(','), feed:'iex' });
    Object.assign(results, data);
    done += batch.length;
    if (onProgress) onProgress(done, clean.length);
  }
  return results;
}

// Malformed tickers (anything sanitizeTickerBatch() strips, e.g. the
// UNVERIFIED_HYPHEN_SYMBOLS) never reach Alpaca at all now, so they can never
// appear in `snapshots` — this flags that exclusion loudly (once per scan)
// instead of the ticker just silently vanishing with no signal and no trace.
function checkUnresolvedSymbols(requestedTickers, snapshots) {
  const requested = new Set(requestedTickers);
  const missing = UNVERIFIED_HYPHEN_SYMBOLS.filter(sym => requested.has(sym) && !snapshots[sym]);
  if (missing.length) {
    console.warn(`Unresolved symbol(s) — no Alpaca snapshot returned, likely a format/listing mismatch: ${missing.join(', ')}`);
  }
}

// Same exemption proof as fetchSnapshots above — snapshots has no
// limit/next_page_token to lose data against, only a proven batch size.
async function fetchAHSnapshots(tickers) {
  const clean = sanitizeTickerBatch(tickers);
  const results = {};
  for (const batch of chunk(clean, 100)) {
    try {
      const data = await alpacaGet('/stocks/snapshots', { symbols: batch.join(','), feed:'iex' });
      Object.assign(results, data);
    } catch(e) { console.warn('AH snapshot error', e.message); }
  }
  return results;
}

// Phase 0.6 Bug 1 fix. Alpaca's multi-symbol bars endpoint caps `limit` at
// the TOTAL bar count across the whole response, not per symbol — sorted by
// symbol first, then timestamp. At the old limit:100 default, a 30-symbol
// chunk needing ~3,000 daily bars returned exactly one symbol's worth
// (confirmed live: a 30-symbol request came back with only `ABSI`, the
// alphabetically-first symbol, plus an ignored next_page_token) and every
// other symbol in the chunk silently vanished.
//
// Fix (option D from the spec's cost table): raise `limit` to Alpaca's
// platform ceiling (10000) so a realistic chunk's total bar need fits in one
// page — AND follow next_page_token to exhaustion as a safety net, so
// correctness doesn't rest on trusting the ceiling is never exceeded. The
// pagination loop should essentially never iterate more than once under the
// current 180-day lookback / 30-symbol chunk size; it exists so a future
// change to either doesn't silently reintroduce this bug.
// Phase 0.6 Bug 3 fix. A transient failure on one chunk's request (network
// blip, 429, timeout) hits the catch below and drops ~30 symbols from the
// scan with nothing but a console.warn — the same disappearing-stock
// symptom as Bug 1, from a stochastic cause instead of a deterministic one.
// Scoped narrowly per the spec: surface it, don't fix it — retry/backoff is
// Phase 0.5's job. `droppedSymbols` lets the caller show a count in the scan
// header rather than silently presenting a partial scan as a complete one.
async function fetchMultiBars(tickers, limit = 10000) {
  const clean = sanitizeTickerBatch(tickers);
  if (!clean.length) return { results: {}, droppedSymbols: [] };
  const results = {};
  const droppedSymbols = [];
  const start = (() => {
    const d = new Date(); d.setDate(d.getDate() - 180); return d.toISOString().split('T')[0];
  })();
  for (const batch of chunk(clean, 30)) {
    try {
      let pageToken;
      do {
        const params = { symbols: batch.join(','), timeframe:'1Day', start, limit, sort:'asc', feed:'iex', adjustment: HISTORICAL_BAR_ADJUSTMENT };
        if (pageToken) params.page_token = pageToken;
        const data = await alpacaGet('/stocks/bars', params);
        let pageRowCount = 0;
        if (data.bars) {
          for (const sym of Object.keys(data.bars)) {
            pageRowCount += data.bars[sym].length;
            results[sym] = (results[sym] || []).concat(data.bars[sym]);
          }
        }
        pageToken = data.next_page_token || null;
        assertPageNotSuspiciouslyFull('fetchMultiBars', pageRowCount, params.limit, pageToken);
      } while (pageToken);

      // Completeness assertion: every symbol in `batch` already cleared the
      // Stage 1 price/volume snapshot filter upstream, meaning Alpaca has
      // confirmed trade data for it — so a symbol with zero bars back here
      // after exhausting pagination is an anomaly, not "too new to have
      // history." Log it explicitly rather than letting it fall through
      // scoreStock's `bars.length < 15` gate indistinguishable from "failed
      // the score threshold" (that gate still correctly excludes genuinely
      // short-history symbols; this only flags the zero-bars case).
      const missing = batch.filter(sym => !results[sym] || !results[sym].length);
      if (missing.length) {
        console.warn(`fetchMultiBars: no bars returned for ${missing.length} requested symbol(s) after full pagination: ${missing.join(', ')}`);
      }
    } catch(e) {
      console.warn('bars batch error', e.message);
      droppedSymbols.push(...batch);
    }
  }
  return { results, droppedSymbols };
}

// Had the identical defect to Bug 1 above, unaudited for two days: limit:300,
// sort:'asc', no next_page_token follow. 450 calendar days holds ~310-320
// NYSE trading days (450*5/7 minus ~9-10 annual holidays) — always more than
// 300 — so this silently returned only the OLDEST 300 bars in the window and
// dropped the most recent ~2-4 weeks every single call, with next_page_token
// sitting unread in the response. Confirmed live: a ticker bought days ago
// came back with zero bars since its buy date. Same option D fix as Bug 1:
// limit raised to Alpaca's platform ceiling, next_page_token followed to
// exhaustion so correctness doesn't depend on the ceiling never being hit.
async function fetchSingleBars(ticker, limit = 10000) {
  const start = (() => {
    const d = new Date(); d.setDate(d.getDate() - 450); return d.toISOString().split('T')[0];
  })();
  try {
    let bars = [];
    let pageToken;
    do {
      const params = { timeframe:'1Day', start, limit, sort:'asc', feed:'iex', adjustment: HISTORICAL_BAR_ADJUSTMENT };
      if (pageToken) params.page_token = pageToken;
      const data = await alpacaGet(`/stocks/${ticker}/bars`, params);
      bars = bars.concat(data.bars || []);
      pageToken = data.next_page_token || null;
      assertPageNotSuspiciouslyFull(`fetchSingleBars(${ticker})`, (data.bars || []).length, params.limit, pageToken);
    } while (pageToken);
    return bars;
  } catch(e) { return []; }
}

// Next trading day's close after a given sell date — feeds the "what-if held
// 1 more day" metric in the Winner Exit Timing Analysis report section
// (URE v2, Change 5). limit:3 gives slack for the day after a Friday/holiday
// sale to land on the next actual trading session.
// CLAUDE.md pagination rule, exemption proof: this call can never need more
// than 1 bar (the next trading day's close) — limit:3 is slack for a
// Friday/holiday sale, not headroom the response could actually fill. The
// window is bounded by construction, not by an assumption about how much
// data exists in it, so no next_page_token follow is needed.
async function fetchNextDayClose(ticker, sellDateStr) {
  try {
    const d = new Date(sellDateStr);
    d.setDate(d.getDate() + 1);
    const start = d.toISOString().split('T')[0];
    const data = await alpacaGet(`/stocks/${ticker}/bars`, {
      timeframe: '1Day', start, limit: 3, sort: 'asc', feed: 'iex', adjustment: HISTORICAL_BAR_ADJUSTMENT
    });
    const bars = data.bars || [];
    return bars.length ? bars[0].c : null;
  } catch(e) { return null; }
}

// 1-minute bars for the "1 Day" chart range — closer in resolution to
// Robinhood's intraday chart than the old hourly bars (still IEX-only, so
// absolute price levels can still differ; see feed note on fetchSnapshots).
// 4-day lookback window (same as before) so the pre-market/holiday fallback
// in renderChartRange still has a prior session to fall back to.
// limit:2000 was arithmetically plausible-safe (regular hours: ~4 trading
// days * 390min ~= 1560, under 2000) but never verified live, and IEX may
// include extended-hours bars that push the real count higher — exactly the
// "the arithmetic looks fine" reasoning that was wrong for fetchSingleBars
// above. Paginating costs less than proving the arithmetic and is strictly
// safer either way, so fixed the same way regardless: limit raised to
// Alpaca's platform ceiling, next_page_token followed to exhaustion.
async function fetchMinuteBars(ticker) {
  const d = new Date(); d.setDate(d.getDate() - 4);
  const start = d.toISOString().split('T')[0];
  try {
    let bars = [];
    let pageToken;
    do {
      const params = { timeframe: '1Min', start, limit: 10000, sort: 'asc', feed: 'iex' };
      if (pageToken) params.page_token = pageToken;
      const data = await alpacaGet(`/stocks/${ticker}/bars`, params);
      bars = bars.concat(data.bars || []);
      pageToken = data.next_page_token || null;
      assertPageNotSuspiciouslyFull(`fetchMinuteBars(${ticker})`, (data.bars || []).length, params.limit, pageToken);
    } while (pageToken);
    return bars;
  } catch(e) { return []; }
}

// 1-hour bars for the "1 Week"/"1 Month" chart ranges — same idea as
// fetchMinuteBars, one level coarser. 45-day lookback comfortably covers a
// 30-day range plus weekend/holiday slack; renderChartRange filters this
// single fetch down to the 7-day or 30-day window as needed.
// limit:500 was the least comfortable margin of the three: regular hours
// gives ~30-33 trading days * 7 buckets/day ~= 210-230 (safe), but with
// extended-hours bars included that's ~16 buckets/day * 30-33 days ~=
// 480-528 — potentially over the cap already. Same fix regardless of which
// side of 500 it actually lands on: limit raised to Alpaca's platform
// ceiling, next_page_token followed to exhaustion.
async function fetchHourlyBars(ticker) {
  const d = new Date(); d.setDate(d.getDate() - 45);
  const start = d.toISOString().split('T')[0];
  try {
    let bars = [];
    let pageToken;
    do {
      const params = { timeframe: '1Hour', start, limit: 10000, sort: 'asc', feed: 'iex' };
      if (pageToken) params.page_token = pageToken;
      const data = await alpacaGet(`/stocks/${ticker}/bars`, params);
      bars = bars.concat(data.bars || []);
      pageToken = data.next_page_token || null;
      assertPageNotSuspiciouslyFull(`fetchHourlyBars(${ticker})`, (data.bars || []).length, params.limit, pageToken);
    } while (pageToken);
    return bars;
  } catch(e) { return []; }
}

// Phase 9 §2.0/§7 (2026-09-15): the intraday position panel's data
// primitive — SIP minute bars from a position's buy date through "now",
// per the render-time design (docs/phase-9-entry-exit-spec.md §2.0):
// nothing captures this ahead of time, it's fetched on demand whenever the
// panel renders. feed:'sip' deliberately, unlike every other fetcher in
// this file — §2.0.1 measured IEX understating real session highs on real
// thin $1-$20 names (up to 1.6% over a whole session) and this panel's
// whole purpose is showing Roman a real high, so it can't use this file's
// usual iex default. `end` is deliberately omitted, not computed — §2.0
// verified live that Alpaca applies its own safe recency default rather
// than erroring, for any granularity, so this naturally returns everything
// SIP currently has and stops wherever its recency embargo does (typically
// ~15 min behind live), with nothing here needing to know that boundary.
//
// Returns { bars, failed } rather than swallowing an error into `[]` the
// way this file's other fetchers do: `failed` distinguishes "the request
// itself broke" from "the request succeeded and truly found zero bars" —
// the same failed-vs-confirmed-empty distinction core/universe.js's
// _fetchRawMinuteBars already makes for its own callers, and load-bearing
// here because §2.0.2 requires the panel to say it couldn't load rather
// than silently rendering an empty/truncated path as if it were complete.
async function fetchIntradaySipBars(ticker, sinceDateStr) {
  try {
    let bars = [];
    let pageToken;
    do {
      const params = { timeframe: '1Min', start: sinceDateStr, limit: 10000, sort: 'asc', feed: 'sip', adjustment: HISTORICAL_BAR_ADJUSTMENT };
      if (pageToken) params.page_token = pageToken;
      const data = await alpacaGet(`/stocks/${ticker}/bars`, params);
      bars = bars.concat(data.bars || []);
      pageToken = data.next_page_token || null;
      assertPageNotSuspiciouslyFull(`fetchIntradaySipBars(${ticker})`, (data.bars || []).length, params.limit, pageToken);
    } while (pageToken);
    return { bars, failed: false };
  } catch(e) {
    console.warn(`fetchIntradaySipBars(${ticker}): ${e.message}`);
    return { bars: [], failed: true };
  }
}

// Multi-symbol variant for the Portfolio card one-liner (§7): one batched
// request for every held ticker's TODAY bars, rather than one request per
// position — the same per-render cost concern §2.0's cost table already
// measured as trivial (a 5-symbol/1-day request: 2,708 bars/183ms). Scoped
// to today only, not full since-entry history: a per-symbol "since you
// bought" fetch needs each position's own start date, which this shared,
// single-start multi-symbol request can't give every ticker at once — the
// modal (one ticker at a time, via fetchIntradaySipBars above) is where
// that richer multi-day view lives. `failed` here is per-symbol: a symbol
// present in the response with zero bars is a confirmed-empty result, and
// a symbol whose whole batch request threw is reported in `failedSymbols`
// so its card can say so instead of silently reading as confirmed-empty.
async function fetchTodaySipBarsMulti(tickers) {
  const clean = sanitizeTickerBatch(tickers);
  // PT calendar date, not a UTC slice (found live 2026-09-15, ~8pm ET):
  // UTC midnight lands at 8pm ET during EDT, squarely inside the evening
  // Roman is most likely to open the app. A bare UTC slice() there reads
  // "tomorrow" while it's still this evening in US market terms, and
  // requesting a future `start` date lands inside SIP's own recency
  // embargo -- confirmed live, a real 403 ("subscription does not permit
  // querying recent SIP data"), not a hypothetical. That 403 then read as
  // this whole function having failed, when the real, still-open trading
  // day's data was sitting right there. ptDateStr(getPT()) matches
  // core/clock.js's own convention (PT midnight is 3am ET) and the same
  // reference frame app.js's computeIntradayPanel now uses for the exact
  // same reason.
  const todayStr = ptDateStr(getPT());
  const barsBySymbol = {};
  const failedSymbols = [];
  if (!clean.length) return { barsBySymbol, failedSymbols };
  for (const batch of chunk(clean, 30)) {
    try {
      let pageToken;
      do {
        const params = { symbols: batch.join(','), timeframe: '1Min', start: todayStr, limit: 10000, sort: 'asc', feed: 'sip', adjustment: HISTORICAL_BAR_ADJUSTMENT };
        if (pageToken) params.page_token = pageToken;
        const data = await alpacaGet('/stocks/bars', params);
        let pageRowCount = 0;
        if (data.bars) {
          for (const sym of Object.keys(data.bars)) {
            pageRowCount += data.bars[sym].length;
            barsBySymbol[sym] = (barsBySymbol[sym] || []).concat(data.bars[sym]);
          }
        }
        pageToken = data.next_page_token || null;
        assertPageNotSuspiciouslyFull('fetchTodaySipBarsMulti', pageRowCount, params.limit, pageToken);
      } while (pageToken);
    } catch(e) {
      console.warn(`fetchTodaySipBarsMulti: batch error for ${batch.length} symbols: ${e.message}`);
      failedSymbols.push(...batch);
    }
  }
  return { barsBySymbol, failedSymbols };
}

// Phase 9 §7 correction (2026-09-15, after the first real intraday-panel
// render): NO_DATA was folding two different facts into one label — "the
// window Alpaca has data for just happens to be empty" and "this symbol
// has stopped trading entirely" — and the second is urgent for a
// position still open, the first routine. Confirmed live the same day:
// TWO (held in the real portfolio) returns zero bars from EVERY bar
// fetch, and separately, GET /v2/assets/TWO reports
// `{status: 'inactive', tradable: false}` — Alpaca has independently
// delisted/deactivated it while it's still sitting in the portfolio.
//
// /v2/assets/{symbol} lives on Alpaca's TRADING api, not the market-data
// api (data.alpaca.markets) every other fetcher in this file hits.
// ALPACA_TRADING_BASE is core/universe.js's global const, NOT redeclared
// here -- this file and universe.js are classic scripts sharing one
// global scope (see index.html's own comment on load order/CLAUDE.md),
// and a second top-level `const` of the same name threw
// "Identifier 'ALPACA_TRADING_BASE' has already been declared" live the
// first time this was tried, aborting the REST of whichever script tag
// evaluated second — found via a real end-to-end run, not a review.
// universe.js's constant has no trailing /v2 (its own call sites pass
// '/v2/assets' as the path); matched here rather than adding a second,
// differently-shaped constant for the same host.
async function fetchAssetStatus(ticker) {
  try {
    const data = await alpacaGet(`/v2/assets/${ticker}`, {}, ALPACA_TRADING_BASE);
    return { status: data.status, tradable: data.tradable, failed: false };
  } catch(e) {
    console.warn(`fetchAssetStatus(${ticker}): ${e.message}`);
    return { status: null, tradable: null, failed: true };
  }
}
