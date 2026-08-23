// core/market-data.js — owned by neither engine. core/ never imports from engines/.
// Snapshot + daily/minute/hourly bar fetchers. Feed ('iex' | 'sip') is always
// an explicit parameter at each call site — never a default baked in here.
// Moved from app.js verbatim (Phase 0 extraction) — this includes the known,
// not-yet-fixed next_page_token gap in fetchMultiBars (see Phase 0.6 in
// docs/warrior-engine-spec-v2.md). Every fetcher here still hardcodes
// feed:'iex'; that's the same known debt, not touched by this move.

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

async function fetchMultiBars(tickers, limit = 100) {
  const clean = sanitizeTickerBatch(tickers);
  if (!clean.length) return {};
  const results = {};
  const start = (() => {
    const d = new Date(); d.setDate(d.getDate() - 180); return d.toISOString().split('T')[0];
  })();
  for (const batch of chunk(clean, 30)) {
    try {
      const data = await alpacaGet('/stocks/bars', {
        symbols: batch.join(','), timeframe:'1Day', start, limit, sort:'asc', feed:'iex'
      });
      if (data.bars) Object.assign(results, data.bars);
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
