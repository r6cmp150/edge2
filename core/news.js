// core/news.js — owned by neither engine. core/ never imports from engines/.
// Alpaca news fetch.
//
// Phase 0.6 Bug 2 fix: Alpaca serves news from '/v1beta1', not '/v2' — every
// call via the default ALPACA_BASE 404'd (confirmed live). ALPACA_NEWS_BASE
// is passed explicitly to alpacaGet's base-override parameter
// (core/api-client.js).
//
// Phase 0.6 Bug 4 fix: no `start` was ever passed (confirmed pre-existing on
// main, not introduced by Bug 2's fix) — Alpaca defaults it to the beginning
// of the current day, which is empty on a Sunday and covers only since
// midnight on a Monday-morning scan, missing the Friday-evening/weekend
// catalysts that scan exists to find, and undersizing the 4-12hr scoring
// bucket (retired from scoring itself, but still true of the fetch gap).
//
// Widening the window reintroduces Bug 1's shape in news form: `limit` maxes
// at 50 (a hard cap — unlike bars' limit, Alpaca does not allow raising it)
// and results are sorted desc ACROSS THE WHOLE BATCH of requested symbols,
// not per symbol. A wider window makes a batch's combined item count more
// likely to exceed 50, silently starving whichever symbols' news happens to
// sort older within that batch. Mitigated by chunking candidates into small
// batches (fewer symbols competing for the same 50-item budget) and
// following page_token up to a bounded number of pages per batch as a safety
// net — see the cost analysis in docs/warrior-engine-spec-v2.md Phase 0.6.
// Deliberately NOT unbounded pagination: unlike bars, news volume per batch
// has no predictable ceiling, so "follow until exhausted" has no natural
// stopping point and risks an open-ended request count on a single newsy
// batch.
//
// Bug 4 follow-up: a flat 72h base still under-covers a 3-day holiday
// weekend (Friday close -> Tuesday open is ~85-90h — see
// core/clock.js:hoursSincePreviousClose). The actual lookback used is
// max(BASE, hours since the previous trading day's close), capped at MAX so
// a long-idle app doesn't balloon the window indefinitely — a week-old
// article isn't a fresh catalyst anymore, it's history. state.newsLookbackHours
// records whatever value was actually used so the card-render visibility
// gate (app.js:buildCardNewsSnippet) can match it exactly rather than
// duplicating a number that may not be this scan's actual window.
const ALPACA_NEWS_BASE = 'https://data.alpaca.markets/v1beta1';
const NEWS_LOOKBACK_HOURS_BASE = 72;   // covers a normal weekend
const NEWS_LOOKBACK_HOURS_MAX  = 120;  // caps a long holiday weekend at 5 days
const NEWS_CHUNK_SIZE = 10;       // symbols per news request
const NEWS_MAX_PAGES_PER_CHUNK = 3; // bounds worst case at NEWS_MAX_PAGES_PER_CHUNK * 50 items per chunk

async function fetchNewsForTickers(tickers) {
  const clean = sanitizeTickerBatch(tickers);

  const sincePrevClose = hoursSincePreviousClose();
  const lookbackHours = sincePrevClose == null
    ? NEWS_LOOKBACK_HOURS_BASE
    : Math.min(Math.max(NEWS_LOOKBACK_HOURS_BASE, sincePrevClose), NEWS_LOOKBACK_HOURS_MAX);
  state.newsLookbackHours = lookbackHours;

  if (!clean.length) {
    state.newsUnavailable = false;
    state.newsTruncatedSymbols = [];
    return [];
  }

  const start = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  const allNews = [];
  const truncatedSymbols = [];
  const failedSymbols = [];

  // Per-batch try/catch (2026-09-04, gate-honesty pass) -- this used to be
  // ONE try/catch around the whole loop, so a single batch's request
  // failure aborted every remaining batch and marked newsUnavailable=true
  // for candidates whose news had already fetched successfully, not just
  // the batch that actually failed. Same shape as the bars fetchers'
  // per-chunk isolation (core/universe.js's _fetchRawMinuteBars etc) --
  // one bad batch shouldn't cost every OTHER batch's real data.
  for (const batch of chunk(clean, NEWS_CHUNK_SIZE)) {
    try {
      const seenInBatch = new Set();
      let pageToken;
      let pages = 0;
      let hitPageCap = false;
      do {
        const params = { symbols: batch.join(','), start, limit: 50, sort: 'desc' };
        if (pageToken) params.page_token = pageToken;
        const data = await alpacaGet('/news', params, ALPACA_NEWS_BASE);
        const items = data.news || [];
        allNews.push(...items);
        items.forEach(n => (n.symbols || []).forEach(sym => seenInBatch.add(sym)));
        pageToken = data.next_page_token || null;
        pages++;
        if (pageToken && pages >= NEWS_MAX_PAGES_PER_CHUNK) { hitPageCap = true; break; }
      } while (pageToken);

      if (hitPageCap) {
        // Stopped before exhausting the window (bounded-cost tradeoff, see
        // header comment) — a symbol in this batch that hasn't appeared yet
        // might just not have surfaced in what we fetched, not "no news."
        // Flag it as possibly-truncated rather than asserting no news.
        const stillMissing = batch.filter(sym => !seenInBatch.has(sym));
        truncatedSymbols.push(...stillMissing);
        console.warn(`fetchNewsForTickers: batch-limit page cap reached before exhausting window for a ${batch.length}-symbol batch; ${stillMissing.length} symbol(s) may have unretrieved news: ${stillMissing.join(', ')}`);
      }
    } catch (e) {
      console.error(`fetchNewsForTickers: batch error for ${batch.length} symbols: ${e.message}`);
      failedSymbols.push(...batch);
    }
  }
  // newsUnavailable now means "every batch failed" (a real, total outage),
  // not "at least one batch failed" -- a partial failure is fully captured
  // by failedSymbols/truncatedSymbols instead, per-symbol, honestly.
  state.newsUnavailable = clean.length > 0 && failedSymbols.length === clean.length;
  state.newsTruncatedSymbols = truncatedSymbols;
  state.newsFailedSymbols = failedSymbols;
  return allNews;
}
