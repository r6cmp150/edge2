// core/market-data.js — owned by neither engine. core/ never imports from engines/.
// Snapshot + daily/minute/hourly bar fetchers. Feed ('iex' | 'sip') is always
// an explicit parameter at each call site — never a default baked in here.
// Moved from app.js verbatim (Phase 0 extraction). fetchMultiBars' pagination
// gap was fixed in Phase 0.6 (Bug 1) — see the comment on that function.
// Every fetcher here still hardcodes feed:'iex'; that's separate known debt,
// not part of Phase 0.6, not touched here.

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
async function fetchSnapshots(tickers, onProgress) {
  const clean = sanitizeTickerBatch(tickers);
  const results = {};
  let done = 0;
  for (const batch of chunk(clean, 100)) {
    const data = await alpacaGet('/stocks/snapshots', { symbols: batch.join(','), feed:'iex' });
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
        const params = { symbols: batch.join(','), timeframe:'1Day', start, limit, sort:'asc', feed:'iex' };
        if (pageToken) params.page_token = pageToken;
        const data = await alpacaGet('/stocks/bars', params);
        if (data.bars) {
          for (const sym of Object.keys(data.bars)) {
            results[sym] = (results[sym] || []).concat(data.bars[sym]);
          }
        }
        pageToken = data.next_page_token || null;
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
      const params = { timeframe:'1Day', start, limit, sort:'asc', feed:'iex' };
      if (pageToken) params.page_token = pageToken;
      const data = await alpacaGet(`/stocks/${ticker}/bars`, params);
      bars = bars.concat(data.bars || []);
      pageToken = data.next_page_token || null;
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
      timeframe: '1Day', start, limit: 3, sort: 'asc', feed: 'iex'
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
    } while (pageToken);
    return bars;
  } catch(e) { return []; }
}
