// core/news.js — owned by neither engine. core/ never imports from engines/.
// Alpaca news fetch.
// Moved from app.js verbatim (Phase 0 extraction) — including the known,
// not-yet-fixed wrong path. This calls alpacaGet('/news', ...), which
// resolves against ALPACA_BASE ('.../v2') to '.../v2/news' — Alpaca 404s on
// that; the correct path is '/v1beta1/news'. Confirmed live (Phase 0.6 in
// docs/warrior-engine-spec-v2.md). Not fixed here — Phase 0 is move-only.

async function fetchNewsForTickers(tickers) {
  const clean = sanitizeTickerBatch(tickers);
  if (!clean.length) return [];
  try {
    const syms = clean.slice(0, 50).join(',');
    const data = await alpacaGet('/news', { symbols: syms, limit: 50, sort:'desc' });
    return data.news || [];
  } catch(e) { return []; }
}
