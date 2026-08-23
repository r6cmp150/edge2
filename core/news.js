// core/news.js — owned by neither engine. core/ never imports from engines/.
// Alpaca news fetch.
//
// Phase 0.6 fix: Alpaca serves news from '/v1beta1', not '/v2' — every call
// via the default ALPACA_BASE 404'd (confirmed live). ALPACA_NEWS_BASE is
// passed explicitly to alpacaGet's base-override parameter (core/api-client.js).
//
// state.newsUnavailable distinguishes "fetch failed" from "fetched fine, zero
// results" for the UI (app.js's card/modal renderers check it before falling
// back to "No recent news") — a 404 on a scoring input must not silently look
// identical to a quiet news day. Reset on every call so a later successful
// scan clears a stale failure flag from an earlier one.
const ALPACA_NEWS_BASE = 'https://data.alpaca.markets/v1beta1';

async function fetchNewsForTickers(tickers) {
  const clean = sanitizeTickerBatch(tickers);
  if (!clean.length) { state.newsUnavailable = false; return []; }
  try {
    const syms = clean.slice(0, 50).join(',');
    const data = await alpacaGet('/news', { symbols: syms, limit: 50, sort:'desc' }, ALPACA_NEWS_BASE);
    state.newsUnavailable = false;
    return data.news || [];
  } catch(e) {
    console.error('News fetch failed:', e.message);
    state.newsUnavailable = true;
    return [];
  }
}
