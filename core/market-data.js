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
async function fetchMultiBars(tickers, limit = 10000) {
  const clean = sanitizeTickerBatch(tickers);
  if (!clean.length) return {};
  const results = {};
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
    } catch(e) { console.warn('bars batch error', e.message); }
  }
  return results;
}

async function fetchSingleBars(ticker, limit = 300) {
  const start = (() => {
    const d = new Date(); d.setDate(d.getDate() - 450); return d.toISOString().split('T')[0];
  })();
  try {
    const data = await alpacaGet(`/stocks/${ticker}/bars`, {
      timeframe:'1Day', start, limit, sort:'asc', feed:'iex'
    });
    return data.bars || [];
  } catch(e) { return []; }
}

// Next trading day's close after a given sell date — feeds the "what-if held
// 1 more day" metric in the Winner Exit Timing Analysis report section
// (URE v2, Change 5). limit:3 gives slack for the day after a Friday/holiday
// sale to land on the next actual trading session.
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
async function fetchMinuteBars(ticker) {
  const d = new Date(); d.setDate(d.getDate() - 4);
  const start = d.toISOString().split('T')[0];
  try {
    const data = await alpacaGet(`/stocks/${ticker}/bars`, {
      timeframe: '1Min', start, limit: 2000, sort: 'asc', feed: 'iex'
    });
    return data.bars || [];
  } catch(e) { return []; }
}

// 1-hour bars for the "1 Week"/"1 Month" chart ranges — same idea as
// fetchMinuteBars, one level coarser. 45-day lookback comfortably covers a
// 30-day range plus weekend/holiday slack; renderChartRange filters this
// single fetch down to the 7-day or 30-day window as needed.
async function fetchHourlyBars(ticker) {
  const d = new Date(); d.setDate(d.getDate() - 45);
  const start = d.toISOString().split('T')[0];
  try {
    const data = await alpacaGet(`/stocks/${ticker}/bars`, {
      timeframe: '1Hour', start, limit: 500, sort: 'asc', feed: 'iex'
    });
    return data.bars || [];
  } catch(e) { return []; }
}
