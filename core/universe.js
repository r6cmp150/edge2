// core/universe.js — owned by neither engine. core/ never imports from engines/.
// docs/warrior-engine-spec-v2.md Phase 1. getUniverse({session, strategy})
// serves both engines: 'movers'/'premarket-gap' are Warrior's Top Gainer
// scanner primitives, 'full-filtered' is EDGE's eventual replacement for
// STOCK_UNIVERSES (not built or wired up this phase — see the spec).
//
// Decision, from a live diagnostic run (diagnoseUniverseEndpoints, still
// below): movers/most-actives both work on this Basic-plan paper account —
// 200s, real data — and their top-50 results are adequately priced in
// $1-$20 (21/50 and 26/50 respectively on the sample run). Built as the
// primary intraday-strategy source, not a fallback.
//
// /v2/assets lives on paper-api.alpaca.markets, not data.alpaca.markets —
// confirmed against the account's key prefix (PK..., Alpaca's paper-account
// convention). Live count on that run: 14,203 raw active us_equity assets,
// narrowing through the instrument filter to ~5,714 (see
// EXCLUDED_INSTRUMENT_NAME_RE's comment for the full funnel).
//
// premarket-gap cost, recomputed against that real ~5,714 base rather than
// the spec's original ~11k-total estimate — and using PRIOR_CLOSE_CHUNK_SIZE/
// SNAPSHOT_CHUNK_SIZE = 100 (fetchSnapshots' proven chunk size) rather than
// the spec's untested "~200 per request" suggestion, per this phase's own
// rule about not relying on unverified assumptions:
//
//   First scan of a trading day (prior-close cache cold):
//     ~58 requests to fetch prior closes for all ~5,714 eligible symbols
//     (once, cached for the rest of the day) + ~18-29 requests for the live
//     step over whichever survive the $1-$20 prior-close filter (estimated
//     30-50% of 5,714 ≈ 1,700-2,850 symbols — this fraction is a real
//     unknown until a live run reports it) = ~76-87 requests. Exceeds the
//     spec's <30 acceptance bullet.
//   Every subsequent same-day scan (prior-close cache warm):
//     ~18-29 requests — the live step only. Clears <30.
//
// The first-scan overshoot is a real, deliberate tradeoff, not an oversight:
// prior close is stable all day and expensive to (re)fetch; live price
// isn't and must be fetched every scan regardless. A pre-market workflow
// that checks more than once or twice through the ~6:00-6:25am PT window
// (which is the whole point of checking pre-market at all) amortizes the
// one-time ~58-request cost across every scan after the first, and comes
// out cheaper than re-fetching all 5,714 symbols' live data on every single
// scan would. The <30 bullet is met by every scan except literally the
// first one of the day.
//
// The "live step" was originally a snapshot batch; Bug A (found live,
// 2026-08-24) rules that out entirely — see
// _fetchLatestSipMinuteBars/_getPremarketGapUniverse below — and replaces it
// with a SIP minute-bar batch of the same shape and chunk size, so this
// cost estimate is unchanged in magnitude, just sourced from a different
// endpoint.

const ALPACA_TRADING_BASE = 'https://paper-api.alpaca.markets';
const ALPACA_SCREENER_BASE = 'https://data.alpaca.markets/v1beta1';
const ASSET_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // spec: cache the asset list for 24 hours
const ALLOWED_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX']);

function _inPriceRange(price) {
  return typeof price === 'number' && price >= 1 && price <= 20;
}

// Alpaca's asset metadata has no structured instrument-type field — checked
// before relying on anything here. `class` only separates us_equity from
// us_option/crypto/etc. (a SPAC's units/warrants/rights all still come back
// class:"us_equity", same as the common stock). `attributes` is trading
// features (fractionable, options-enabled), not instrument type. The only
// documented signal at all is free text in `name`.
//
// This is deliberately an EXCLUDE-list, not an include-list, and that
// choice is settled — do not reintroduce an include-list here. An earlier
// cut required `name` to contain "Common Stock" and was rejected after
// checking it against the real, live 8,799-name baseline (not fixtures):
// it kept only 2,487 and dropped 6,312, including HUBS, EMN, IEX, NOV,
// KULR, and MESO — major, ordinary, currently-listed common stocks whose
// Alpaca `name` simply doesn't contain that exact phrase, alongside every
// ADR ("American Depositary Shares"), every foreign ordinary-share issuer
// ("Ordinary Shares"), every REIT ("Common Shares of Beneficial Interest"),
// and anything with no instrument phrase in its name at all. All tradeable,
// all Ross-eligible, all silently dropped. That's the same silent-exclusion
// failure mode as Bug 1 (bars pagination) and Bug 4 (news window): a real
// runner excluded looks identical to "nothing here," while a junk
// instrument slipping through an exclude-list is one visible bad card, not
// an invisible loss — asymmetric enough that "the exclude-list might let
// something through" is not a reason to go back. Word-boundary matched
// (`\b`) so "unit" doesn't false-positive on "United Airlines" or similar,
// and "fund" doesn't false-positive on "Fundamental" — verified against
// live data before each keyword was added, not assumed; see
// diagnoseFundKeywordCandidates below for the tooling that's still deciding
// whether "Fund" joins this list.
//
// ETF/ETN added after a live run: ETF excluded 1,250 names off the
// (ADR-carve-out-adjusted) 7,309-name eligible baseline, all 20 sampled
// were genuine funds; ETN excluded 3, same result. Two candidates
// considered and rejected: "Exchange Traded Fund" is a strict subset of
// ETF (every sample also contained "ETF"); "Trust" excluded fewer (1,117)
// than ETF while carrying real REIT risk (KKR Real Estate Finance Trust
// appeared in its own exclusion sample) — strictly worse on both axes, not
// added. Leveraged/inverse pattern (2x/3x/leveraged/inverse/daily
// target/bull/bear) also rejected as redundant: all 201 of its live
// matches, including MSTU, already contained "ETF".
//
// "fund" added after the word-boundary self-check came back clean on live
// data: 315 excluded off the post-ETF/ETN baseline, all 20 sampled genuine
// closed-end funds, and diagnoseFundKeywordCandidates' unbounded-vs-bounded
// diff found zero real names with "fund" embedded in a longer word (the
// "Fundamental Global Inc." risk this was checked against specifically).
//
// Full funnel on the live run that settled this filter: 14,203 raw active
// us_equity -> 8,799 tradable on NASDAQ/NYSE/AMEX -> 6,029 after
// instrument+ETF/ETN -> ~5,714 after adding fund.
const EXCLUDED_INSTRUMENT_NAME_RE = /\b(warrants?|units?|rights?|preferred|notes?|debentures?|etfs?|etns?|funds?)\b/i;

// American Depositary Shares (ADRs) are foreign-issuer common-stock
// equivalents — Ross-eligible. Their name often describes what the ADS
// represents in a parenthetical, e.g. BAK: "Braskem S.A. American
// Depositary Shares (Each representing Two Class A Preferred Shares)" —
// that "Preferred" describes the underlying, not the ADS itself, but would
// otherwise trip EXCLUDED_INSTRUMENT_NAME_RE. Confirmed live: this false
// positive was real, not hypothetical (BAK, ~$3-4, liquid, silently
// dropped). A bare "Depositary Shares" WITHOUT "American" is the genuinely
// different structure — a bank preferred stock sold via depositary shares
// (e.g. "Depositary Shares representing 1/1000th interest in a 6% Preferred
// Stock") — and needs no separate rule: it's correctly caught by the
// "preferred" keyword below on its own, since this carve-out only fires on
// the literal "American Depositary Shares" phrase.
const ADR_RE = /american depositary shares/i;

function _isEligibleInstrument(asset) {
  if (typeof asset.name !== 'string') return true; // no name to judge by — exclude-list philosophy defaults to keep, not drop
  if (ADR_RE.test(asset.name)) return true;
  return !EXCLUDED_INSTRUMENT_NAME_RE.test(asset.name);
}

// ── Asset list — 24h cache, shared by every strategy that needs to know
// whether a symbol is common stock on a major exchange. Fetch is cheap (one
// call) but the response is large (~14k rows) — this is the only strategy
// this phase actually calls it from (movers/most-actives need it purely to
// cross-reference instrument type; they don't return name/class themselves).
// CLAUDE.md pagination rule, exemption proof: /v2/assets takes no `limit`
// and returns no `next_page_token` — confirmed live, the full 14,203-row
// active us_equity list came back in this one call (see file header). Not a
// truncatable list endpoint the way /stocks/bars is.
// client (2026-08-30): defaults to the shared CORE client (core/api-
// client.js) when the caller doesn't have (or doesn't care about) its own
// — every public entry point below accepts and forwards one, so this
// file's own internal alpacaGet calls end up tagged with whichever engine
// actually initiated the request, without core/ ever needing to know
// engine names itself (the client already carries that). See
// core/api-client.js's createApiClient for why this replaced per-file
// shadowing: a majority of both engines' real traffic flows through these
// shared helpers, not direct alpacaGet calls, so a shadow in the calling
// file has nothing to reach.
async function _getAssetIndex(client = _coreClient) {
  const cache = state.universeAssetCache;
  if (cache && cache.fetchedAt && (Date.now() - new Date(cache.fetchedAt).getTime()) < ASSET_CACHE_MAX_AGE_MS) {
    return cache.assets;
  }
  const raw = await client.alpacaGet('/v2/assets', { status: 'active', asset_class: 'us_equity' }, ALPACA_TRADING_BASE);
  const assets = (raw || [])
    .filter(a => a.tradable && ALLOWED_EXCHANGES.has(a.exchange))
    .map(a => ({ symbol: a.symbol, exchange: a.exchange, name: a.name, isEligibleInstrument: _isEligibleInstrument(a) }));
  state.universeAssetCache = { fetchedAt: new Date().toISOString(), assets };
  persist('universeAssetCache');
  console.log(`core/universe.js: refreshed asset list — ${raw.length} total active us_equity, ${assets.length} tradable on ${[...ALLOWED_EXCHANGES].join('/')}`);
  return assets;
}

function _assetIndexBySymbol(assets) {
  const map = {};
  assets.forEach(a => { map[a.symbol] = a; });
  return map;
}

// ── movers/most-actives (intraday strategy) ─────────────────────────────
// Alpaca docs: movers resets at market open and returns *prior-day* movers
// until then — not meaningful pre-market. Advisory only (getUniverse
// doesn't block the call), since callers choose the strategy for their
// session via the strategy param, but a miscall here would silently return
// stale data with nothing to indicate it.
// CLAUDE.md pagination rule, exemption proof: `top` is the screener
// endpoint's own request size, not a response cap it can silently truncate
// against — it returns exactly `top` rows or fewer, no next_page_token
// exists for this endpoint. top:50 is Alpaca's documented ceiling for this
// endpoint (not ours to raise); logged explicitly below so a thin result
// reads as "the cap may be cutting off real candidates," not silently as
// "the market is quiet."
async function _getMoversUniverse(session, client = _coreClient) {
  if (session && session !== 'OPEN' && session !== 'AH') {
    console.warn(`getUniverse('movers'): called during session=${session} — movers returns stale prior-day data before market open; consider 'premarket-gap' instead.`);
  }

  const [moversData, activesData, assetIndex] = await Promise.all([
    client.alpacaGet('/screener/stocks/movers', { top: 50 }, ALPACA_SCREENER_BASE),
    client.alpacaGet('/screener/stocks/most-actives', { top: 50 }, ALPACA_SCREENER_BASE),
    _getAssetIndex(client),
  ]);
  const assetsBySymbol = _assetIndexBySymbol(assetIndex);

  const gainers = (moversData.gainers || []).map(g => ({
    symbol: g.symbol,
    price: g.price,
    // prevClose isn't returned directly, but is recoverable exactly from
    // price/change (Alpaca gives both) — no extra request.
    prevClose: (typeof g.price === 'number' && typeof g.change === 'number') ? g.price - g.change : null,
    changePct: typeof g.percent_change === 'number' ? g.percent_change : null,
    volume: null, // movers doesn't provide volume
    source: 'movers',
  }));

  const activeRows = activesData.most_actives || [];
  const activeSymbols = activeRows.map(a => a.symbol);
  const activeSnaps = activeSymbols.length ? await fetchSnapshots(activeSymbols, undefined, client) : {};
  const actives = activeRows.map(a => {
    const snap = activeSnaps[a.symbol];
    const price = getLivePrice(snap) || null;
    const prevClose = snap?.prevDailyBar?.c || null;
    return {
      symbol: a.symbol,
      price,
      prevClose,
      changePct: (prevClose && price) ? ((price - prevClose) / prevClose) * 100 : null,
      volume: typeof a.volume === 'number' ? a.volume : null,
      source: 'actives',
    };
  });

  const rawGainersCount = gainers.length;
  const rawActivesCount = actives.length;

  // Union + dedupe by symbol. movers wins on overlap — it already carries a
  // real percent_change; actives' price/prevClose/changePct were all
  // derived from a snapshot rather than given directly.
  const merged = {};
  actives.forEach(a => { merged[a.symbol] = a; });
  gainers.forEach(g => { merged[g.symbol] = g; });
  const combined = Object.values(merged);

  const priceFiltered = combined.filter(c => _inPriceRange(c.price));
  const instrumentFiltered = priceFiltered.filter(c => {
    const asset = assetsBySymbol[c.symbol];
    // A symbol missing from the asset index (wrong exchange, not tradable,
    // not in the us_equity active list) is excluded here — absence from the
    // index is itself informative, unlike a missing `name` on a present
    // asset (see _isEligibleInstrument).
    return !!(asset && asset.isEligibleInstrument);
  });

  // `top=50` is a hard cap Alpaca imposes on each endpoint, not "everything
  // meeting criteria" the way Ross Cameron's own scanner works — logged
  // explicitly so a thin count here is visibly "the cap may be cutting off
  // real candidates," not indistinguishable from "the market is quiet."
  // There is no way to tell those two apart from this endpoint alone.
  console.log(`getUniverse('movers'): ${rawGainersCount} movers + ${rawActivesCount} actives (top=50 cap each) -> ${combined.length} after dedupe -> ${priceFiltered.length} in $1-$20 -> ${instrumentFiltered.length} eligible instrument`);

  return instrumentFiltered.map(c => ({
    symbol: c.symbol, price: c.price, prevClose: c.prevClose, changePct: c.changePct, volume: c.volume, source: c.source,
  }));
}

// ── premarket-gap ────────────────────────────────────────────────────────
// movers/most-actives return stale prior-day data before market open, so
// this is the one the pre-market workflow — and Gap and Go — actually
// depends on.
//
// Deliberately NOT the "~200 symbols per request" the spec suggested for
// the snapshot batch: that number was never verified against this account,
// and this phase's own discipline (movers/most-actives, the instrument
// filter) has twice found that unverified assumptions here fail silently.
// 100 is what fetchSnapshots already uses successfully in production —
// proven, not guessed. A larger chunk size is a real future optimization,
// but it needs its own live check before being relied on, same as
// movers/most-actives did.
const PRIOR_CLOSE_CHUNK_SIZE = 100;
const SNAPSHOT_CHUNK_SIZE = 100;

// Prior closes are stable within a trading day (spec: cache daily) — this
// is genuinely new fetching work, not free infrastructure that already
// existed. Cost is real and one-time per calendar day: at ~5,714
// instrument-eligible symbols / 100 per request, ~58 requests on the first
// call of a new day, ~0 on every later same-day call (cache hit). See
// getUniverse's premarket-gap comment for why that one-time cost is still
// the right tradeoff for a workflow that scans repeatedly through the
// pre-market window.
async function _getPriorCloses(symbols, client = _coreClient) {
  const today = ptDateStr(getPT());
  let cache = state.universePriorCloseCache;
  if (!cache || cache.date !== today) cache = { date: today, closes: {} };

  const missing = symbols.filter(sym => !(sym in cache.closes));
  if (missing.length) {
    const start = (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().split('T')[0]; })();
    for (const batch of chunk(missing, PRIOR_CLOSE_CHUNK_SIZE)) {
      try {
        const barsBySymbol = {};
        let pageToken;
        do {
          // adjustment:'all' (2026-09-01, found live — see
          // _getSip30DayAvgVolume below for the full family): omitting
          // this defaults to Alpaca's 'raw' (unadjusted). A reverse
          // split lands a spurious price jump on the split date with
          // nothing in the data to distinguish it from a real move —
          // here that means a prior close read across a split boundary
          // is silently wrong, corrupting the gap% this function exists
          // to feed.
          const params = { symbols: batch.join(','), timeframe: '1Day', start, limit: batch.length * 3, sort: 'desc', feed: 'iex', adjustment: HISTORICAL_BAR_ADJUSTMENT };
          if (pageToken) params.page_token = pageToken;
          const data = await client.alpacaGet('/stocks/bars', params);
          let pageRowCount = 0;
          if (data.bars) {
            for (const sym of Object.keys(data.bars)) {
              pageRowCount += data.bars[sym].length;
              (barsBySymbol[sym] = barsBySymbol[sym] || []).push(...data.bars[sym]);
            }
          }
          pageToken = data.next_page_token || null;
          assertPageNotSuspiciouslyFull('_getPriorCloses', pageRowCount, params.limit, pageToken);
        } while (pageToken);
        // sort:'desc' -> each symbol's first bar is its most recent close.
        batch.forEach(sym => {
          const bars = barsBySymbol[sym];
          if (bars && bars.length) cache.closes[sym] = bars[0].c;
        });
      } catch (e) {
        console.warn(`_getPriorCloses: batch error for ${batch.length} symbols: ${e.message}`);
      }
    }
  }
  state.universePriorCloseCache = cache;
  persist('universePriorCloseCache');
  return cache.closes;
}

// Bug A (found live, 2026-08-24): snapshots 403 on feed:'sip' — "subscription
// does not permit querying recent SIP data". Basic permits SIP only for data
// >= 15 minutes old; snapshots are inherently recent, no exceptions. Falling
// back to feed:'iex' for snapshots isn't a fix either — pre-market IEX
// volume is negligible, so gap%/price from it would be unreliable or absent
// for most symbols, the same problem SIP was chosen to avoid in the first
// place. Rebuilt on 15-minute-delayed SIP MINUTE BARS instead: a 6:00am PT
// scan sees data through ~5:45am, which is entirely adequate for detecting
// a gap. `end` is set explicitly to now-16min (15min delay + 1min buffer) —
// omitting `end` and letting it default to "now" risks the same "recent
// data" rejection bars get when a caller doesn't account for the delay.
const PREMARKET_BAR_DELAY_MIN = 16;

// Live-measured, not estimated: the old single 3h/limit:batch.length*5
// design took ~1,329 requests / 5.7min for a ~3,854-symbol run (confirmed
// against that run's own numbers — 39 chunks * ~34 avg pages/chunk, right
// where 18,000 worst-case bars against a 500-bar page predicts). A
// 45-minute window at a 100-symbol chunk has a worst-case bar count of
// 100*45=4,500 — always under Alpaca's 10,000 platform ceiling, so pass 1
// is provably single-page per chunk (CLAUDE.md pagination rule: proof, not
// an estimate). PREMARKET_BAR_WINDOW_WIDE_MIN is the old 3h window, used
// only as pass 2's fallback for the (expected: small) set of symbols pass 1
// found nothing for.
const PREMARKET_BAR_WINDOW_MIN = 45;
const PREMARKET_BAR_WINDOW_WIDE_MIN = 3 * 60;

// Chunked/paginated/concurrent SIP minute-bar fetch, returning EVERY bar in
// [start, end] per symbol (not reduced to latest-or-summed) — the shared
// primitive _fetchMinuteBarsWindow (latest bar, below) and
// _fetchCumulativeMinuteVolume (Phase 3 RVOL, summed) both build on, so the
// chunking/pagination/error-handling logic lives in exactly one place
// rather than drifting apart across two call sites that need different
// reductions of the same underlying fetch. Chunks submitted concurrently
// (Promise.all), not sequentially awaited — see the comment this block
// used to carry: a sequential loop here means at most 1 item is ever in
// core/api-client.js's shared queue from this call site, making the
// queue's own concurrency inert regardless of how parallel it's capable
// of being. Safe to parallelize freely — chunk() partitions symbols into
// disjoint sets, so each iteration writes to different result keys, and
// each chunk's error handling is already independent.
// hardFailOnIncomplete (2026-09-02, default false — LIVE callers unchanged):
// when true, a chunk that fails all of core/api-client.js's own retries
// throws an aggregate error naming every affected symbol, instead of the
// default silent catch-and-continue below. Default stays false because
// this function backs live-app paths (premarket-gap, RVOL) where a
// transient chunk failure degrading gracefully for a few symbols is the
// right behavior for an interactive scan a trader is actively watching.
// The offline replay path (fetchReplayBars, "the replay half") opts in —
// see that function's own comment: a partial minute-bar fetch there
// doesn't just affect a few symbols' RVOL number, it silently gets
// relabeled "notEvaluated: no bars," indistinguishable from a symbol that
// legitimately had no trades that day. Found live 2026-09-02: this
// function's old unconditional swallow-and-continue is the reason the
// widened scan's OWN replay step could have absorbed a 429 exactly the
// way its universe-reconstruction step did (see _fetchHistoricalDailyBars's
// parallel fix) — same defect, one layer up, just never actually observed
// firing because it hides identically either way.
async function _fetchRawMinuteBars(symbols, start, end, chunkSize, windowLabel, client = _coreClient, { hardFailOnIncomplete = false } = {}) {
  const barsBySymbolAll = {};
  let requests = 0;
  const failedBatches = [];
  await Promise.all(chunk(symbols, chunkSize).map(async batch => {
    try {
      const barsBySymbol = {};
      let pageToken;
      do {
        const params = {
          symbols: batch.join(','), timeframe: '1Min',
          start: start.toISOString(), end: end.toISOString(),
          limit: 10000, sort: 'desc', feed: 'sip',
        };
        if (pageToken) params.page_token = pageToken;
        const data = await client.alpacaGet('/stocks/bars', params);
        requests++;
        let pageRowCount = 0;
        if (data.bars) {
          for (const sym of Object.keys(data.bars)) {
            pageRowCount += data.bars[sym].length;
            (barsBySymbol[sym] = barsBySymbol[sym] || []).push(...data.bars[sym]);
          }
        }
        pageToken = data.next_page_token || null;
        assertPageNotSuspiciouslyFull(`_fetchRawMinuteBars (${windowLabel})`, pageRowCount, params.limit, pageToken);
      } while (pageToken);
      Object.assign(barsBySymbolAll, barsBySymbol);
    } catch (e) {
      console.warn(`_fetchRawMinuteBars: batch error for ${batch.length} symbols (${windowLabel}): ${e.message}`);
      failedBatches.push({ batch, error: e });
    }
  }));
  const failedSymbols = failedBatches.flatMap(f => f.batch);
  if (hardFailOnIncomplete && failedSymbols.length) {
    const err = new Error(`_fetchRawMinuteBars (${windowLabel}): ${failedBatches.length} chunk(s) failed after all retries, ${failedSymbols.length} symbols with NO data (request never completed, not "confirmed no bars"): ${failedSymbols.slice(0, 30).join(', ')}${failedSymbols.length > 30 ? ', …' : ''}. Aborting rather than silently reporting these as "no bars."`);
    err.failedSymbols = failedSymbols;
    throw err;
  }
  // failedSymbols returned even in default (soft) mode (2026-09-04, found
  // live during the gate-honesty pass): this used to be computed and then
  // thrown away after the console.warn, leaving every caller with no way
  // to tell "this symbol has zero bars because the request failed" from
  // "this symbol genuinely has no bars this window" — the same distinction
  // gate.js's pillars need to render honestly instead of folding a fetch
  // failure into the generic not-checked/fail bucket.
  return { barsBySymbolAll, requests, failedSymbols };
}

// Single-window fetch, latest bar per symbol. Unchanged contract (existing
// callers/tests depend on {latestBySymbol, requests}) — now a thin
// reduction over _fetchRawMinuteBars rather than its own fetch loop.
async function _fetchMinuteBarsWindow(symbols, end, windowMin, client = _coreClient) {
  const start = new Date(end.getTime() - windowMin * 60 * 1000);
  const { barsBySymbolAll, requests } = await _fetchRawMinuteBars(symbols, start, end, SNAPSHOT_CHUNK_SIZE, `${windowMin}min window`, client);
  const latestBySymbol = {};
  // sort:'desc' -> each symbol's first bar is its most recent within [start, end].
  for (const sym of Object.keys(barsBySymbolAll)) {
    const bars = barsBySymbolAll[sym];
    if (bars && bars.length) latestBySymbol[sym] = bars[0];
  }
  return { latestBySymbol, requests };
}

// Phase 3 Pillar 3 (RVOL): sum of every minute bar's volume in [start, end]
// per symbol, not just the latest. Chunk size is much smaller than
// SNAPSHOT_CHUNK_SIZE (100) because this window can span a whole regular
// session (390 min), not premarket-gap's fixed 45 minutes — at 100 symbols/
// chunk, 390min*100=39,000 worst-case bars would blow the single-page
// proof badly. 25 keeps worst case at 390*25=9,750, under Alpaca's 10,000
// ceiling — the same "proof, not estimate" requirement as
// PREMARKET_BAR_WINDOW_MIN's chunk size, just for a wider window.
const RVOL_VOLUME_CHUNK_SIZE = 25;

async function _fetchCumulativeMinuteVolume(symbols, start, end, client = _coreClient) {
  const { barsBySymbolAll, requests, failedSymbols } = await _fetchRawMinuteBars(symbols, start, end, RVOL_VOLUME_CHUNK_SIZE, 'cumulative-volume window', client);
  const volumeBySymbol = {};
  for (const sym of Object.keys(barsBySymbolAll)) {
    volumeBySymbol[sym] = barsBySymbolAll[sym].reduce((sum, b) => sum + (b.v || 0), 0);
  }
  return { volumeBySymbol, requests, failedSymbols };
}

// Phase 3 Pillar 3: 30-day SIP daily-volume average, cached per trading day
// (same pattern as _getPriorCloses) — a genuinely new fetch, nothing else
// pulls 30-day SIP daily history. Must be SIP, matching
// _fetchCumulativeMinuteVolume's feed: mixing an IEX-based historical
// average against a SIP-based today's-volume numerator would reintroduce
// the exact "ratio of two different things" problem the Feed section
// opens with. 30 days * 30-symbol chunks = 900 bars, comfortably under the
// 10,000 single-page ceiling — proof, plus next_page_token followed
// regardless as the safety net.
const RVOL_DAILY_AVG_LOOKBACK_DAYS = 30;
const RVOL_DAILY_AVG_CHUNK_SIZE = 30;

// adjustment: HISTORICAL_BAR_ADJUSTMENT (2026-09-01, found live) --
// core/market-data.js's own const, referenced here as an ordinary global
// (that file loads before this one — see index.html's script order),
// NOT redeclared: classic scripts share one global lexical scope, and a
// second top-level `const` with the same name would throw at load time
// (same hazard core/store.js's own header already documents for
// supabaseClient vs `const supabase`). Every 1Day-bar call in this
// codebase omitted an adjustment param, defaulting to Alpaca's 'raw'
// (unadjusted) -- confirmed via a live run of a later, separate
// historical-reconstruction tool that ranked a $0.14->$4.54 (+3,140%)
// "move" that was almost certainly a reverse split. THIS function is the
// worst-affected: it IS Warrior's RVOL denominator (Pillar 3), read
// fresh every trading day, so a symbol that split within the trailing 30
// days silently corrupts its own RVOL threshold check -- not a one-off
// bad row in an offline analysis, a wrong live gate decision. See
// market-data.js's header comment for the full family this fixes.
// client = _coreClient (2026-08-30, request-accounting fix) -- accepts a
// caller's tagged client (see core/api-client.js's createApiClient)
// instead of always routing through the untagged bare global, same
// pattern this file's other fetchers already accept.
async function _getSip30DayAvgVolume(symbols, client = _coreClient) {
  const today = ptDateStr(getPT());
  let cache = state.warrior30DayVolumeCache;
  if (!cache || cache.date !== today) cache = { date: today, avgVolumes: {} };

  const missing = symbols.filter(sym => !(sym in cache.avgVolumes));
  let requests = 0;
  const failedBatches = [];
  if (missing.length) {
    const start = (() => { const d = new Date(); d.setDate(d.getDate() - RVOL_DAILY_AVG_LOOKBACK_DAYS); return d.toISOString().split('T')[0]; })();
    await Promise.all(chunk(missing, RVOL_DAILY_AVG_CHUNK_SIZE).map(async batch => {
      try {
        const barsBySymbol = {};
        let pageToken;
        do {
          const params = { symbols: batch.join(','), timeframe: '1Day', start, limit: 10000, sort: 'asc', feed: 'sip', adjustment: HISTORICAL_BAR_ADJUSTMENT };
          if (pageToken) params.page_token = pageToken;
          const data = await client.alpacaGet('/stocks/bars', params);
          requests++;
          let pageRowCount = 0;
          if (data.bars) {
            for (const sym of Object.keys(data.bars)) {
              pageRowCount += data.bars[sym].length;
              (barsBySymbol[sym] = barsBySymbol[sym] || []).push(...data.bars[sym]);
            }
          }
          pageToken = data.next_page_token || null;
          assertPageNotSuspiciouslyFull('_getSip30DayAvgVolume', pageRowCount, params.limit, pageToken);
        } while (pageToken);
        batch.forEach(sym => {
          const bars = barsBySymbol[sym];
          if (bars && bars.length) {
            const totalVol = bars.reduce((s, b) => s + (b.v || 0), 0);
            cache.avgVolumes[sym] = totalVol / bars.length;
          }
        });
      } catch (e) {
        console.warn(`_getSip30DayAvgVolume: batch error for ${batch.length} symbols: ${e.message}`);
        failedBatches.push(batch);
      }
    }));
  }
  state.warrior30DayVolumeCache = cache;
  persist('warrior30DayVolumeCache');
  // failedSymbols (2026-09-04, gate-honesty pass): a symbol whose fetch
  // failed is simply absent from cache.avgVolumes, same as a symbol that
  // genuinely has no 30-day history -- indistinguishable to gate.js's RVOL
  // pillar without this. Not persisted (a real fetch failure should retry
  // next call, same as it already silently does today via the "missing"
  // filter above); this call's own failures only.
  return { avgVolumes: cache.avgVolumes, requests, failedSymbols: failedBatches.flat() };
}

// ── Pre-market-specific RVOL baseline (2026-09-04, found live) ───────────
// evaluatePillar3 (gate.js) has always read 'not-checked' for RVOL outside
// the regular session -- correct as far as it went, but Warrior is a
// pre-open method: Roman looks at these cards at 6:00-6:30am PT, when
// RVOL's "most selective pillar" claim (gate.js's own header) has never
// actually been evaluated. Backtest gate-pass rate was 6.6%; live it was
// 43% (12/28) -- a materially looser filter than the one the backtest
// measured, because its heaviest pillar wasn't running.
//
// _getSip30DayAvgVolume's daily-bar average CANNOT be reused as the
// pre-market denominator -- dividing pre-market cumulative volume by a
// full-day average is a ratio of two different things (live check,
// 2026-09-04: AAPL's pre-market window summed to ~1.6M shares against a
// ~34M full-day bar, roughly 4-5% of the day for a LIQUID name; Warrior's
// actual thin/low-float universe would read smaller and noisier still).
// Same error class this session has already caught three times: the
// sparsity-sensitive RVOL denominator, close-horizon non-comparability,
// shares-outstanding-vs-float conflation.
//
// No daily-bar shortcut exists for "pre-market portion only" -- Alpaca's
// 1Day bars aggregate the whole session. Built from minute bars instead,
// one request per TRADING day per chunk (not one contiguous multi-week
// fetch): a single day's pre-market window is cheap and provably
// single-page; a 30-CALENDAR-day contiguous minute-bar fetch would pull
// every regular-session/after-hours minute in between too, ~3x the data
// this needs, for no benefit. PRE_MARKET_RVOL_CHUNK_SIZE proof: 330
// minutes (1:00am-6:30am PT, same premarket boundary fetchReplayBars/
// _getPreMarketGapUniverse already use) * 25 symbols = 8,250, under
// Alpaca's 10,000 single-page ceiling for one day's window -- same margin
// RVOL_VOLUME_CHUNK_SIZE=25 already uses for the regular session's larger
// 390-minute window -- plus next_page_token followed regardless as the
// safety net, same as every other fetcher in this file.
//
// Cached per calendar day, same "expensive once, free the rest of the
// day" shape as _getPriorCloses/_getSip30DayAvgVolume -- ~30 requests for
// a NEW symbol's first appearance that day (bounded by pillar12Survivors,
// never the full eligible universe), ~0 on every later same-day call.
const PRE_MARKET_RVOL_LOOKBACK_TRADING_DAYS = 30;
const PRE_MARKET_RVOL_CHUNK_SIZE = 25;

// Last N trading days strictly BEFORE beforeDateStr (never including it —
// mixing "today" into the baseline would be circular against the live
// numerator computed separately). Same safe getPT(ptWallClockToInstant(...))
// idiom setups.js's _tradingDaysBetween/_previousTradingDayStr already use
// for exactly this reason: a raw UTC-constructed Date's own .getDay() reads
// back in the RUNTIME's local timezone, not a real PT calendar day -- the
// same class of hazard CLAUDE.md's .setHours()/.setDate() rule documents.
function _lastNTradingDayStrs(n, beforeDateStr) {
  const days = [];
  let cur = beforeDateStr;
  while (days.length < n) {
    const [y, m, d] = cur.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    cur = dt.toISOString().split('T')[0];
    if (isTradingDay(getPT(ptWallClockToInstant(cur, 12, 0)))) days.push(cur);
  }
  return days.reverse(); // oldest -> newest
}

// Returns { avgVolumes, historyBySymbol, requests, failedSymbols }.
// historyBySymbol[sym] = [{date, volume}, ...] -- the raw per-day values,
// not just the average, so a caller can capture the real distribution
// (this session's own "capture the distribution, don't assume the
// threshold" discipline, same as the backtest's onRawDistribution) rather
// than only ever seeing the collapsed mean.
//
// failedSymbols here means "zero usable days, no average at all" -- NOT
// "any single day's request failed." A symbol that succeeded on 25 of 30
// days has a real, if smaller-sample, average; that's meaningfully
// different from _fetchRawMinuteBars' all-or-nothing single request, and
// collapsing the two would either discard usable data or misreport a
// partial result as a total one. historyBySymbol[sym].length is the real
// sample size for anyone who wants to judge confidence in a given average.
async function _getPreMarketVolumeHistory(symbols, client = _coreClient) {
  const today = ptDateStr(getPT());
  let cache = state.warriorPreMarketVolumeCache;
  if (!cache || cache.date !== today) cache = { date: today, historyBySymbol: {} };

  const missing = symbols.filter(sym => !(sym in cache.historyBySymbol));
  let requests = 0;
  const failedBatches = [];
  if (missing.length) {
    const days = _lastNTradingDayStrs(PRE_MARKET_RVOL_LOOKBACK_TRADING_DAYS, today);
    for (const sym of missing) cache.historyBySymbol[sym] = [];
    for (const dateStr of days) {
      const start = ptWallClockToInstant(dateStr, 1, 0);  // 4:00am ET
      const end = ptWallClockToInstant(dateStr, 6, 30);   // 9:30am ET, regular open
      await Promise.all(chunk(missing, PRE_MARKET_RVOL_CHUNK_SIZE).map(async batch => {
        try {
          const barsBySymbol = {};
          let pageToken;
          do {
            const params = { symbols: batch.join(','), timeframe: '1Min', start: start.toISOString(), end: end.toISOString(), limit: 10000, feed: 'sip' };
            if (pageToken) params.page_token = pageToken;
            const data = await client.alpacaGet('/stocks/bars', params);
            requests++;
            let pageRowCount = 0;
            if (data.bars) {
              for (const sym of Object.keys(data.bars)) {
                pageRowCount += data.bars[sym].length;
                (barsBySymbol[sym] = barsBySymbol[sym] || []).push(...data.bars[sym]);
              }
            }
            pageToken = data.next_page_token || null;
            assertPageNotSuspiciouslyFull(`_getPreMarketVolumeHistory (${dateStr})`, pageRowCount, params.limit, pageToken);
          } while (pageToken);
          batch.forEach(sym => {
            const bars = barsBySymbol[sym];
            if (bars && bars.length) {
              const volume = bars.reduce((s, b) => s + (b.v || 0), 0);
              cache.historyBySymbol[sym].push({ date: dateStr, volume });
            }
            // no bars this specific day: genuinely didn't trade pre-market
            // that day (thin/quiet), not a fetch failure -- skipped, not
            // recorded as a zero (a zero would silently pull the average
            // down as if "no volume" were a measured fact rather than an
            // absent one).
          });
        } catch (e) {
          console.warn(`_getPreMarketVolumeHistory: batch error for ${batch.length} symbols on ${dateStr}: ${e.message}`);
          failedBatches.push(...batch);
        }
      }));
    }
  }

  state.warriorPreMarketVolumeCache = cache;
  persist('warriorPreMarketVolumeCache');

  const avgVolumes = {};
  for (const sym of symbols) {
    const hist = cache.historyBySymbol[sym] || [];
    if (hist.length) avgVolumes[sym] = hist.reduce((s, h) => s + h.volume, 0) / hist.length;
  }
  const failedSymbols = [...new Set(failedBatches)].filter(sym => avgVolumes[sym] == null);
  return { avgVolumes, historyBySymbol: cache.historyBySymbol, requests, failedSymbols };
}

// Two-tier fetch. Pass 1 (45min, provably single-page) covers the vast
// majority of symbols cheaply. Pass 2 re-requests ONLY the symbols pass 1
// found nothing for, with the wider 3h window — thin/stale premarket
// trading, not necessarily junk, so worth a second look rather than an
// immediate drop. Anything still empty after both passes is a real gap:
// returned as missingSymbols and logged, same "surface it, don't fix it,
// never silently drop it" pattern as fetchMultiBars' Bug 3 droppedSymbols —
// this is not a substitute for narrowing the window, it's what makes
// narrowing the window safe to do at all.
async function _fetchLatestSipMinuteBars(symbols, client = _coreClient) {
  const end = new Date(Date.now() - PREMARKET_BAR_DELAY_MIN * 60 * 1000);

  const pass1 = await _fetchMinuteBarsWindow(symbols, end, PREMARKET_BAR_WINDOW_MIN, client);
  const missingAfterPass1 = symbols.filter(sym => !(sym in pass1.latestBySymbol));

  let pass2 = { latestBySymbol: {}, requests: 0 };
  if (missingAfterPass1.length) {
    pass2 = await _fetchMinuteBarsWindow(missingAfterPass1, end, PREMARKET_BAR_WINDOW_WIDE_MIN, client);
  }

  const latestBySymbol = { ...pass1.latestBySymbol, ...pass2.latestBySymbol };
  const missingSymbols = symbols.filter(sym => !(sym in latestBySymbol));
  if (missingSymbols.length) {
    console.warn(`_fetchLatestSipMinuteBars: no SIP minute bar for ${missingSymbols.length} of ${symbols.length} symbol(s) even after the ${PREMARKET_BAR_WINDOW_WIDE_MIN}min fallback pass: ${missingSymbols.slice(0, 20).join(', ')}${missingSymbols.length > 20 ? '…' : ''}`);
  }

  return { latestBySymbol, missingSymbols, pass1Requests: pass1.requests, pass2Requests: pass2.requests };
}

// Shared by _getPremarketGapUniverse and diagnosePremarketGap so the ranking
// logic can't drift between the real path and the diagnostic measuring it.
function _buildGapResults(priceFilteredSymbols, latestBySymbol, priorCloses) {
  const withGap = priceFilteredSymbols.map(sym => {
    const bar = latestBySymbol[sym];
    const premarketPrice = bar ? bar.c : null;
    const prevClose = priorCloses[sym];
    if (!premarketPrice || !prevClose) return null;
    return {
      symbol: sym,
      price: premarketPrice,
      prevClose,
      changePct: ((premarketPrice - prevClose) / prevClose) * 100,
      volume: bar ? bar.v : null,
      source: 'premarket-gap',
    };
  }).filter(Boolean);

  withGap.sort((a, b) => b.changePct - a.changePct);
  const top50 = withGap.slice(0, 50);
  const top50Symbols = new Set(top50.map(w => w.symbol));
  const above10pct = withGap.filter(w => w.changePct >= 10 && !top50Symbols.has(w.symbol));
  return { withGap, top50, above10pct };
}

async function _getPremarketGapUniverse(client = _coreClient) {
  const assetIndex = await _getAssetIndex(client);
  // Bug (found live, 2026-08-24): this used to be assetIndex.map(a =>
  // a.symbol) — every tradable/exchange-filtered symbol, ignoring
  // isEligibleInstrument entirely. _getMoversUniverse always applied that
  // filter; this path never did, so warrants/units/leveraged ETFs (HQWWW,
  // FVNNU, BTDL — the GraniteShares 2x Long BTDR ETF, one of the exact
  // names from the ETF exclusion sample) reached the ranked output.
  const eligibleSymbols = assetIndex.filter(a => a.isEligibleInstrument).map(a => a.symbol);

  const priorCloses = await _getPriorCloses(eligibleSymbols, client);
  const priceFilteredSymbols = eligibleSymbols.filter(sym => _inPriceRange(priorCloses[sym]));

  console.log(`getUniverse('premarket-gap'): ${assetIndex.length} tradable -> ${eligibleSymbols.length} instrument-eligible -> ${priceFilteredSymbols.length} with prior close in $1-$20`);
  if (!priceFilteredSymbols.length) return [];

  const { latestBySymbol, missingSymbols } = await _fetchLatestSipMinuteBars(priceFilteredSymbols, client);
  if (missingSymbols.length) {
    console.warn(`getUniverse('premarket-gap'): ${missingSymbols.length} of ${priceFilteredSymbols.length} symbols had no SIP minute bar in either window pass — excluded from gap ranking, not silently absent.`);
  }

  const { withGap, top50, above10pct } = _buildGapResults(priceFilteredSymbols, latestBySymbol, priorCloses);

  console.log(`getUniverse('premarket-gap'): ${withGap.length} priced -> top 50 by gap% + ${above10pct.length} additional >=10% gap = ${top50.length + above10pct.length} returned`);

  return [...top50, ...above10pct];
}

// getUniverse({session, strategy}, client) — docs/warrior-engine-spec-v2.md
// Phase 1. strategy: 'movers' | 'premarket-gap' | 'full-filtered'
// → [{ symbol, price, prevClose, changePct, volume, source }]
//
// client (2026-08-30): the caller's own tagged client (createApiClient,
// core/api-client.js) — Warrior passes its WARRIOR client, EDGE its own,
// either or neither. Defaults to the shared CORE client when omitted, so
// an unattributed call degrades to honestly-unattributed rather than
// misattributed to whichever engine happened to be hardcoded before. This
// is the boundary where an engine hands core/ its identity for the
// duration of one call — core/ itself never learns engine names, stays
// "owned by neither engine" per this file's own header.
//
// 'full-filtered' is not yet built — calling it throws rather than
// silently returning an empty/wrong universe.
async function getUniverse({ session, strategy }, client = _coreClient) {
  if (strategy === 'movers') return _getMoversUniverse(session, client);
  if (strategy === 'premarket-gap') return _getPremarketGapUniverse(client);
  throw new Error(`getUniverse: strategy '${strategy}' is not implemented yet.`);
}

// ── Historical universe reconstruction ("top daily movers, reconstructed") ─
// 2026-09-01: Alpaca's live movers/most-actives screener endpoints are
// snapshot-only -- verified directly against the real endpoints that
// neither accepts a date parameter, and 'movers' itself resets to
// *today's* data at market open with nothing recoverable for a past
// date. So the live universe-selection pipeline (getUniverse above)
// itself can never be backtested. This function does NOT reconstruct
// what that pipeline would have shown -- it computes a DIFFERENT, must-
// stay-labeled-as-different proxy from data that IS historically
// queryable (settled daily bars):
//   - ranks on SETTLED daily moves (close vs. the symbol's own prior
//     close) and volume relative to the symbol's own trailing average,
//     not premarket gap or live intraday activity -- a name that moved
//     hard between 10am and 2pm looks identical here to one that gapped
//     at the open and went nowhere all day.
//   - inherits this file's existing survivorship gap: "eligible" means
//     eligible TODAY (_getAssetIndex/_isEligibleInstrument have no
//     point-in-time query), not on the historical date being ranked.
// Never call this "what the engine would have seen" -- it isn't. Call it
// "top daily movers, reconstructed."
//
// HISTORICAL_UNIVERSE_LOOKBACK_PAD_CALENDAR_DAYS: the relative-volume
// metric needs HISTORICAL_UNIVERSE_LOOKBACK_TRADING_DAYS of bars BEFORE
// the earliest ranked day, so the raw fetch window starts this many
// calendar days before startDateStr -- verified live (2026-09-01) that
// 60 calendar days of padding gives 40 real trading days before
// 2026-06-01 for a real symbol (comfortable margin over the 30 needed).
//
// HISTORICAL_UNIVERSE_CHUNK_SIZE (2026-09-01): originally sized to keep
// each chunk provably single-page (90*103=9,270 < 10,000) for the
// original ~103-trading-day padded window. That proof does NOT generalize
// to arbitrary date ranges -- a widened, multi-hundred-trading-day window
// blows past 10,000 rows per chunk at this size. Rather than re-deriving
// and re-proving a chunk-size bound every time the scan range changes,
// _fetchHistoricalDailyBars below now follows next_page_token to
// exhaustion for real (CLAUDE.md's other permitted option), the same
// pattern already used by _getPriorCloses/_getSip30DayAvgVolume in this
// file. 90 is kept as a reasonable concurrency width, not a page-size proof.
const HISTORICAL_UNIVERSE_LOOKBACK_TRADING_DAYS = 30;
const HISTORICAL_UNIVERSE_LOOKBACK_PAD_CALENDAR_DAYS = 60;
const HISTORICAL_UNIVERSE_CHUNK_SIZE = 90;

function _shiftDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Chunked daily-bar range fetch across the WHOLE window in one pass per
// chunk (not once per day — this is the ~80x-cheaper batching this
// function exists to use). feed:'sip' per CLAUDE.md's Warrior bar
// invariant. Concurrent (Promise.all), same reasoning as
// _fetchRawMinuteBars: chunk() partitions symbols into disjoint sets, so
// parallelizing is safe.
// Unconditionally hard-fails on any chunk that exhausts core/api-client.js's
// own retries (2026-09-02, found live) — unlike _fetchRawMinuteBars, this
// function has exactly one caller (reconstructTopMoversUniverse) and it is
// offline-only; there is no live-app interactive scan whose graceful
// degradation this would break. A partial universe reconstruction is not a
// smaller universe, it's a wrong one -- the topN ranking for every trading
// day in range would be computed against however many symbols happened to
// survive rate-limiting, silently. Found live: the first widened-window
// (~378-trading-day) scan reached only 92.2% symbol coverage this way and
// produced an artifact anyway, with nothing short of manually diffing
// eligibleSymbolCount against symbolsWithBars to reveal it.
async function _fetchHistoricalDailyBars(symbols, fetchStartDateStr, endDateStr, client = _coreClient, adjustment = 'all') {
  let requests = 0;
  const barsBySymbol = {};
  const failedBatches = [];
  const chunks = chunk(symbols, HISTORICAL_UNIVERSE_CHUNK_SIZE);
  const results = await Promise.all(chunks.map(async (batch) => {
    const chunkBars = {};
    let chunkRequests = 0;
    try {
      let pageToken;
      do {
        const params = {
          symbols: batch.join(','),
          timeframe: '1Day',
          start: `${fetchStartDateStr}T00:00:00Z`,
          end: `${endDateStr}T23:59:59Z`,
          limit: 10000,
          feed: 'sip',
          // adjustment:'all' (2026-09-01, found live): Alpaca's daily-bar
          // endpoint defaults to 'raw' (unadjusted) when this is omitted —
          // exactly what this file's other 1Day call sites also do (see the
          // 2026-09-01 audit note on _getSip30DayAvgVolume below: this is a
          // FAMILY defect, not unique to this function). A reverse split
          // produces a spurious ~(split ratio)x price jump between the last
          // pre-split bar and the first post-split one with NOTHING in the
          // data to distinguish it from a genuine move — confirmed live:
          // the first real run of this function ranked a $0.14->$4.54
          // (+3,140%) "mover" that was almost certainly exactly this.
          // 'all' (not just 'split') also normalizes dividend adjustments,
          // which this file had no reason to leave out for a historical
          // ranking use case. Overridable (core/edgar.js's float derivation
          // also wants 'all', passed explicitly rather than relying on this
          // default — dividing EntityPublicFloat's dollar value by a
          // split-ADJUSTED historical close lands the result in TODAY's
          // share-count basis, the same basis the 10M threshold and
          // shares-outstanding comparison are in; the raw price would
          // return a share count in that HISTORICAL date's basis instead,
          // wrong by exactly the split ratio if one occurred since —
          // confirmed live via DAIC, see core/edgar.js's own header).
          adjustment,
        };
        if (pageToken) params.page_token = pageToken;
        const data = await client.alpacaGet('/stocks/bars', params);
        chunkRequests++;
        let pageRowCount = 0;
        if (data.bars) {
          for (const sym of Object.keys(data.bars)) {
            pageRowCount += data.bars[sym].length;
            (chunkBars[sym] = chunkBars[sym] || []).push(...data.bars[sym]);
          }
        }
        pageToken = data.next_page_token || null;
        assertPageNotSuspiciouslyFull('_fetchHistoricalDailyBars', pageRowCount, params.limit, pageToken);
      } while (pageToken);
    } catch (e) {
      console.warn(`_fetchHistoricalDailyBars: batch error for ${batch.length} symbols: ${e.message}`);
      failedBatches.push({ batch, error: e });
    }
    return { bars: chunkBars, requests: chunkRequests };
  }));
  for (const r of results) {
    requests += r.requests;
    Object.assign(barsBySymbol, r.bars);
  }
  if (failedBatches.length) {
    const failedSymbols = failedBatches.flatMap(f => f.batch);
    const err = new Error(`_fetchHistoricalDailyBars: ${failedBatches.length}/${chunks.length} chunk(s) failed after all retries, ${failedSymbols.length} symbols with NO data (request never completed, not "confirmed zero bars"): ${failedSymbols.slice(0, 30).join(', ')}${failedSymbols.length > 30 ? ', …' : ''}. A partial universe is not a universe — aborting rather than silently ranking against incomplete data.`);
    err.failedSymbols = failedSymbols;
    throw err;
  }
  return { barsBySymbol, requests };
}

// Pure ranking over already-fetched bars — separated from the fetch step
// the same way _buildGapResults is separated from _getPremarketGapUniverse
// above ("so the ranking logic can't drift between the real path and the
// diagnostic measuring it"), and independently unit-testable against
// hand-built fixture bars without a network call.
//
// Two metrics, unioned per day (mirrors the live pipeline's own actual
// shape: getUniverse('movers') unions gainers from /screener/movers with
// /screener/most-actives, two separately-ranked lists deduped by
// symbol — this is the closest available analog, not an arbitrary
// choice):
//   - dayOverDayPct: (close - priorClose) / priorClose — the settled-move
//     proxy for 'movers'.
//   - relVol: volume / (mean volume over the trailing
//     HISTORICAL_UNIVERSE_LOOKBACK_TRADING_DAYS) — the proxy for
//     'most-actives', but relative to the symbol's OWN history (unusual
//     activity) rather than raw volume (which would just always surface
//     the same mega-caps).
// $1-$20 filtered on the day's own close BEFORE ranking, same order
// _getPremarketGapUniverse's own filter-then-rank applies.
// dataQualityFlag (2026-09-01): FLAG, never discard — Warrior exists to
// trade explosive days, so a flat cutoff on |dayOverDayPct| would throw
// out exactly the strategy's best cases and bias the sample against it.
// adjustment:'all' on the fetch (see _fetchHistoricalDailyBars) already
// removes the split/dividend artifacts that produced the one extreme row
// found live (a $0.14->$4.54, +3,140% "move"); this is a second-line
// check for whatever slips through anyway (bad prints, symbols this
// account's feed doesn't have clean adjustment data for, etc.), not a
// substitute for fixing adjustment. The distinguishing signal isn't the
// size of the move, it's whether VOLUME supports it: an extreme price
// move on ordinary volume has nothing behind it and is more likely a
// data artifact than a trade; an extreme move on genuinely elevated
// volume is real activity, not noise, and is exactly the shape a
// momentum strategy is built to find. Only flags when BOTH conditions
// hold — the underlying numbers ride along on every row (flagged or
// not) so this is checkable/excludable in analysis, not an opaque bit.
const DATA_QUALITY_EXTREME_MOVE_PCT = 0.75; // 75%+ single-day move
const DATA_QUALITY_MIN_RELVOL_FOR_EXTREME_MOVE = 3; // 3x+ relative volume "explains" an extreme move; below that, unsupported

function _dataQualityFlag(dayOverDayPct, relVol) {
  if (dayOverDayPct == null || Math.abs(dayOverDayPct) < DATA_QUALITY_EXTREME_MOVE_PCT) return null;
  if (relVol != null && relVol >= DATA_QUALITY_MIN_RELVOL_FOR_EXTREME_MOVE) return null; // extreme move WITH volume support -- not flagged
  return { reason: 'extreme-move-without-volume-support', dayOverDayPct, relVol };
}

// lagSelectionByOneDay (2026-09-01, found live): the default (false) mode
// ranks day D using day D's OWN close/volume -- meaning a symbol is
// selected into the sample BECAUSE it moved on day D, and the replay
// then measures whether price rose after a same-day trigger, with day
// D's close already known to the selection step by construction. That's
// selection lookahead, and it's also a universe that cannot exist live
// (nobody knows at 09:30 which names will top the day's movers by
// 16:00). When true, day D's selection metrics (dayOverDayPct/relVol)
// are computed from day D-1 instead -- fully known before D opens.
// Everything else stays anchored to day D's own bar regardless of mode:
// the $1-$20 filter, the row's reported close/volume, and (by construction,
// since this function only affects which symbol-days get selected, not
// what gets replayed) every downstream classifier/replay call. This is a
// controlled, single-variable change specifically so a before/after diff
// isolates the lookahead effect and nothing else.
function _rankTopMovers(barsBySymbol, startDateStr, endDateStr, topN = 10, { lagSelectionByOneDay = false } = {}) {
  const rowsByDate = {};
  for (const sym of Object.keys(barsBySymbol)) {
    const bars = [...barsBySymbol[sym]].sort((a, b) => new Date(a.t) - new Date(b.t));
    const minIndex = lagSelectionByOneDay ? 2 : 1; // lagged mode needs i-2 too, for day D-1's own prior close
    for (let i = minIndex; i < bars.length; i++) {
      const bar = bars[i]; // day D -- always this row's own identity (date/close/volume) and the $1-$20 filter's subject, in EITHER mode
      const dateStr = bar.t.slice(0, 10);
      if (dateStr < startDateStr || dateStr > endDateStr) continue; // fetched wider than ranked, for lookback
      if (!_inPriceRange(bar.c)) continue;

      // Selection metrics: day D's own bar (index i, the lookahead this
      // mode exists to remove) or day D-1's (index i-1, fully known
      // before D opens) -- the ONLY thing lagSelectionByOneDay changes.
      const selectionIndex = lagSelectionByOneDay ? i - 1 : i;
      const selectionBar = bars[selectionIndex];
      const selectionPriorClose = bars[selectionIndex - 1].c;
      const dayOverDayPct = selectionPriorClose > 0 ? (selectionBar.c - selectionPriorClose) / selectionPriorClose : null;
      const lookback = bars.slice(Math.max(0, selectionIndex - HISTORICAL_UNIVERSE_LOOKBACK_TRADING_DAYS), selectionIndex);
      const avgVol = lookback.length ? lookback.reduce((s, b) => s + b.v, 0) / lookback.length : null;
      const relVol = avgVol > 0 ? selectionBar.v / avgVol : null;
      (rowsByDate[dateStr] = rowsByDate[dateStr] || []).push({
        date: dateStr, symbol: sym, close: bar.c, volume: bar.v,
        dayOverDayPct, relVol, lookbackTradingDays: lookback.length,
        dataQualityFlag: _dataQualityFlag(dayOverDayPct, relVol),
      });
    }
  }

  const symbolDays = [];
  for (const date of Object.keys(rowsByDate).sort()) {
    const rows = rowsByDate[date];
    const byMove = [...rows].filter(r => r.dayOverDayPct != null).sort((a, b) => b.dayOverDayPct - a.dayOverDayPct).slice(0, topN);
    const byRelVol = [...rows].filter(r => r.relVol != null).sort((a, b) => b.relVol - a.relVol).slice(0, topN);
    const byMoveSymbols = new Set(byMove.map(r => r.symbol));
    const byRelVolSymbols = new Set(byRelVol.map(r => r.symbol));
    const union = new Map();
    for (const r of [...byMove, ...byRelVol]) union.set(r.symbol, r);
    for (const r of union.values()) {
      const source = [byMoveSymbols.has(r.symbol) ? 'move' : null, byRelVolSymbols.has(r.symbol) ? 'relVol' : null].filter(Boolean);
      symbolDays.push({ ...r, source });
    }
  }
  return symbolDays;
}

// Orchestrates fetch + rank. Returns the resulting symbol-day list PLUS
// the request count — the caller (a replay scan, not this file) is
// expected to report the list size before spending anything on the much
// larger replay-half cost, same "measure before committing" discipline
// this whole file's premarket-gap cost comments already follow.
async function reconstructTopMoversUniverse({ startDateStr, endDateStr, topN = 10, client = _coreClient, lagSelectionByOneDay = false }) {
  const fetchStartDateStr = _shiftDateStr(startDateStr, -HISTORICAL_UNIVERSE_LOOKBACK_PAD_CALENDAR_DAYS);
  const assetIndex = await _getAssetIndex(client);
  const eligibleSymbols = assetIndex.filter(a => a.isEligibleInstrument).map(a => a.symbol);

  const { barsBySymbol, requests } = await _fetchHistoricalDailyBars(eligibleSymbols, fetchStartDateStr, endDateStr, client);
  const symbolDays = _rankTopMovers(barsBySymbol, startDateStr, endDateStr, topN, { lagSelectionByOneDay });

  return {
    symbolDays,
    requests,
    eligibleSymbolCount: eligibleSymbols.length,
    symbolsWithBars: Object.keys(barsBySymbol).length,
    // never "what the engine would have seen" — see header comment above.
    // Labeled distinctly per mode so an artifact never has to be traced
    // back to a run command to know which selection rule produced it.
    label: lagSelectionByOneDay ? 'top daily movers, reconstructed (lagged selection, no lookahead)' : 'top daily movers, reconstructed',
  };
}

async function _checkAssetsHost() {
  try {
    const data = await alpacaGet('/v2/assets', { status: 'active', asset_class: 'us_equity' }, ALPACA_TRADING_BASE);
    return { host: ALPACA_TRADING_BASE, status: 200, count: Array.isArray(data) ? data.length : null };
  } catch (e) {
    return { host: ALPACA_TRADING_BASE, status: 'error', error: e.message };
  }
}

async function _checkMovers() {
  try {
    const data = await alpacaGet('/screener/stocks/movers', { top: 50 }, ALPACA_SCREENER_BASE);
    const gainers = data.gainers || [];
    const in1to20 = gainers.filter(g => _inPriceRange(g.price)).length;
    return {
      status: 200,
      count: gainers.length,
      priceCoverage: { in1to20, total: gainers.length },
      sample: gainers.slice(0, 3),
    };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

async function _checkMostActives() {
  try {
    const data = await alpacaGet('/screener/stocks/most-actives', { top: 50 }, ALPACA_SCREENER_BASE);
    const actives = data.most_actives || [];
    // most-actives carries no price field (symbol/volume/trade_count only —
    // confirmed against Alpaca's docs) — a follow-up snapshot batch is the
    // only way to answer the $1-$20 coverage question for this endpoint.
    const symbols = actives.map(a => a.symbol);
    let snaps = {};
    if (symbols.length) snaps = await fetchSnapshots(symbols);
    const priced = actives.map(a => ({ ...a, price: getLivePrice(snaps[a.symbol]) || null }));
    const in1to20 = priced.filter(a => _inPriceRange(a.price)).length;
    return {
      status: 200,
      count: actives.length,
      priceCoverage: { in1to20, total: actives.length },
      sample: priced.slice(0, 3),
    };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

// Run all three checks and return a single report. Read-only, side-effect
// free (no caching, no state writes) — this is a diagnostic, not part of
// getUniverse()'s request path. Kept after the real implementation landed:
// still useful to re-run if Alpaca's behavior or the account's plan changes.
async function diagnoseUniverseEndpoints() {
  const [assets, movers, mostActives] = await Promise.all([
    _checkAssetsHost(),
    _checkMovers(),
    _checkMostActives(),
  ]);
  return { assets, movers, mostActives };
}

// The OLD include-list rule, kept here ONLY for side-by-side comparison
// against the exclude-list actually in use (_isEligibleInstrument above).
// Not called from getUniverse() or anywhere else in the request path.
function _wasCommonStockIncludeList(asset) {
  return typeof asset.name === 'string' && /common stock/i.test(asset.name);
}

// Fetches the real, live /v2/assets list (bypassing the 24h cache — this
// needs a fresh read to answer "what does the filter do against reality
// right now"), applies the tradable+exchange baseline both strategies use,
// then runs BOTH the old include-list and the current exclude-list against
// that same baseline. Reports how many each keeps and a sample of what each
// would additionally exclude relative to the other, so a false-exclusion
// (a real, tradeable, Ross-eligible instrument the include-list drops) or a
// false-inclusion (genuine junk the exclude-list misses) is visible before
// this filter feeds a live strategy.
async function diagnoseInstrumentFilter() {
  const raw = await alpacaGet('/v2/assets', { status: 'active', asset_class: 'us_equity' }, ALPACA_TRADING_BASE);
  const baseline = (raw || []).filter(a => a.tradable && ALLOWED_EXCHANGES.has(a.exchange));

  const includeListKept = [];
  const includeListExcluded = [];
  const excludeListKept = [];
  const excludeListExcluded = [];

  baseline.forEach(a => {
    if (_wasCommonStockIncludeList(a)) includeListKept.push(a); else includeListExcluded.push(a);
    if (_isEligibleInstrument(a)) excludeListKept.push(a); else excludeListExcluded.push(a);
  });

  return {
    rawTotal: raw.length,
    baselineTotal: baseline.length, // tradable + NASDAQ/NYSE/AMEX, before either instrument filter
    includeList: {
      keptCount: includeListKept.length,
      excludedCount: includeListExcluded.length,
      // Names the OLD filter would have dropped — the loss this change
      // exists to fix. Includes anything without "Common Stock" verbatim:
      // ADRs, ordinary shares, REIT common shares, and unlabeled entries,
      // NOT just genuine junk.
      excludedSample: includeListExcluded.slice(0, 20).map(a => `${a.symbol}: ${a.name}`),
    },
    excludeList: {
      keptCount: excludeListKept.length,
      excludedCount: excludeListExcluded.length,
      // Names the NEW filter drops — should be warrants/units/rights/
      // preferred/notes/debentures and little else. Worth checking for
      // over-reach (a legitimate common-stock name that happens to contain
      // one of these words).
      excludedSample: excludeListExcluded.slice(0, 20).map(a => `${a.symbol}: ${a.name}`),
    },
  };
}

// ETF/ETN/fund are all settled and live in EXCLUDED_INSTRUMENT_NAME_RE above
// (see that comment for the numbers each was added on). "Exchange Traded
// Fund", "Trust", and the leveraged/inverse pattern were tested and
// rejected — same comment. Nothing left pending as of this filter's
// settlement. FUND_KEYWORD_CANDIDATES and diagnoseFundKeywordCandidates
// below are kept as a live regression check, not an open decision — re-run
// if Alpaca's naming conventions or the exclude-list itself ever change.
const FUND_KEYWORD_CANDIDATES = {
  '"Fund"': /\bfunds?\b/i,
};

// A raw, unbounded substring check for "fund" — deliberately NOT used
// anywhere in filtering, only to compare against the word-bounded pattern
// above. Any name matching this but NOT the word-bounded pattern is a name
// where "fund" is embedded in a longer word (e.g. "Fundamental") — exactly
// the case being checked for. If that list is empty, the boundary isn't
// just assumed correct, it's shown to have nothing to catch in real data
// either way.
const FUND_SUBSTRING_RE_UNBOUNDED = /fund/i;

// Tests each FUND_KEYWORD_CANDIDATES pattern independently against the
// currently-eligible pool (baseline minus what _isEligibleInstrument already
// excludes) — i.e., what's left for a fund/ETF filter to still catch.
// Read-only: does not modify state or the production filter. Report counts
// + a 20-name sample per candidate so each can be judged against what it
// actually excludes, not guessed at. For "Fund" specifically, also reports
// wordBoundaryFalsePositivesAvoided: real names containing "fund" as a
// substring inside a longer word, which the word-bounded pattern correctly
// left alone.
async function diagnoseFundKeywordCandidates() {
  const raw = await alpacaGet('/v2/assets', { status: 'active', asset_class: 'us_equity' }, ALPACA_TRADING_BASE);
  const baseline = (raw || []).filter(a => a.tradable && ALLOWED_EXCHANGES.has(a.exchange));
  const eligible = baseline.filter(a => _isEligibleInstrument(a));

  const candidates = {};
  for (const [label, re] of Object.entries(FUND_KEYWORD_CANDIDATES)) {
    const excluded = eligible.filter(a => typeof a.name === 'string' && re.test(a.name));
    candidates[label] = {
      excludedCount: excluded.length,
      excludedSample: excluded.slice(0, 20).map(a => `${a.symbol}: ${a.name}`),
    };
  }

  const wordBoundedMatches = new Set(
    eligible.filter(a => typeof a.name === 'string' && FUND_KEYWORD_CANDIDATES['"Fund"'].test(a.name)).map(a => a.symbol)
  );
  const wordBoundaryFalsePositivesAvoided = eligible
    .filter(a => typeof a.name === 'string' && FUND_SUBSTRING_RE_UNBOUNDED.test(a.name) && !wordBoundedMatches.has(a.symbol))
    .map(a => `${a.symbol}: ${a.name}`);

  return { eligibleTotal: eligible.length, candidates, wordBoundaryFalsePositivesAvoided };
}

// ORIGINAL PURPOSE MOOT, KEPT AS A DIFFERENT CHECK: this existed to decide
// whether _getPremarketGapUniverse could snapshot the eligible universe once
// and take both prevClose and live price from the same response. That
// question is closed by Bug A instead — snapshots can't be used pre-market
// at all (feed:'sip' 403s, "subscription does not permit querying recent
// SIP data"; feed:'iex' is allowed but its pre-market volume is negligible,
// unreliable for gap detection), independent of whether prevDailyBar itself
// is populated. _getPremarketGapUniverse now uses SIP minute bars, not
// snapshots, and keeps its own prior-close cache regardless of this result.
//
// Still worth running, for a different reason: _getMoversUniverse's `actives`
// path (movers/most-actives strategy, not premarket-gap) reads
// snap.prevDailyBar?.c from a feed:'iex' snapshot (core/market-data.js's
// fetchSnapshots — audited, confirmed iex, never affected by Bug A). This
// checks that specific reliance is sound. Feed corrected to 'iex' below —
// 'sip' would just 403 here the same way it did in _getPremarketGapUniverse.
async function diagnosePrevDailyBarCoverage() {
  const session = getMarketStatus().status;
  const assetIndex = await _getAssetIndex();
  const sampleSymbols = assetIndex.slice(0, 200).map(a => a.symbol);

  const snaps = {};
  for (const batch of chunk(sampleSymbols, SNAPSHOT_CHUNK_SIZE)) {
    const data = await alpacaGet('/stocks/snapshots', { symbols: batch.join(','), feed: 'iex' });
    Object.assign(snaps, data);
  }

  const present = [];
  const missing = [];
  sampleSymbols.forEach(sym => {
    const snap = snaps[sym];
    const prevClose = snap?.prevDailyBar?.c;
    if (typeof prevClose === 'number' && prevClose > 0) {
      present.push(`${sym}: prevDailyBar.c=${prevClose}`);
    } else {
      missing.push(`${sym}: ${snap ? (snap.prevDailyBar ? 'prevDailyBar present but no valid c' : 'no prevDailyBar field') : 'no snapshot returned at all'}`);
    }
  });

  return {
    session, // interpret pre-market reliability against this — same check run at OPEN doesn't answer the pre-market question
    sampledCount: sampleSymbols.length,
    presentCount: present.length,
    missingCount: missing.length,
    presentSample: present.slice(0, 10),
    missingSample: missing.slice(0, 10),
  };
}

// Runs the real premarket-gap strategy stage by stage — NOT via
// getUniverse(), which would hide per-stage cost behind one total and (with
// no cache for minute bars) double the actual SIP request cost if this then
// called getUniverse separately for the real result. Reports each stage's
// request count on its own: a single combined total is exactly what let the
// fetchLatestSipMinuteBars fix look like the whole story last time —
// _getPriorCloses alone is ~58 chunks with its own pagination on a cold
// cache and was entirely absent from that analysis. Also reports wall-clock
// time and coverage rate (symbols that got a bar, after both minute-bar
// passes, divided by symbols requested) so the two-tier fetch's tradeoff
// (see _fetchLatestSipMinuteBars) is measured, not assumed away.
//
// Per-stage counts come from core/api-client.js's getRequestStats/
// diffRequestStats (2026-08-30 fix) — a snapshot of the shared, issue-time
// tally before and after each stage, not the old per-function _countRequests
// monkey-patch (retired: no concurrency protection, see the commit that
// removed it). Labeled requestsObserved, not requests, for the same reason
// every consumer of this mechanism is: it's a diff over a shared counter,
// exact only if nothing else hits the queue during the window, never an
// undercount the way the old per-function threading was.
async function diagnosePremarketGap() {
  const session = getMarketStatus().status;
  const t0 = Date.now();
  // Own EDGE client (2026-08-30) — this diagnostic is triggered from
  // app.js's own Settings/dev-tools screen, genuinely EDGE's own call, not
  // shared. Passing it through to every stage below is what makes the
  // getRequestStats('EDGE') snapshots below actually measure something:
  // before this fix these calls went through the CORE-default client, so
  // the EDGE-scoped diffs were silently reading zero regardless of real
  // activity — a latent gap in this session's own earlier Q1 fix, closed
  // here as a direct consequence of giving this function a real client.
  const client = createApiClient('EDGE');

  const beforeAssetIndex = getRequestStats('EDGE');
  const assetIndex = await _getAssetIndex(client);
  const assetIndexRequestsObserved = diffRequestStats(beforeAssetIndex, getRequestStats('EDGE')).issued;
  const eligibleSymbols = assetIndex.filter(a => a.isEligibleInstrument).map(a => a.symbol);

  const beforePriorCloses = getRequestStats('EDGE');
  const priorCloses = await _getPriorCloses(eligibleSymbols, client);
  const priorClosesRequestsObserved = diffRequestStats(beforePriorCloses, getRequestStats('EDGE')).issued;
  const priceFilteredSymbols = eligibleSymbols.filter(sym => _inPriceRange(priorCloses[sym]));

  const beforeMinuteBars = getRequestStats('EDGE');
  const barsResult = priceFilteredSymbols.length
    ? await _fetchLatestSipMinuteBars(priceFilteredSymbols, client)
    : { latestBySymbol: {}, missingSymbols: [] };
  const minuteBarsRequestsObserved = diffRequestStats(beforeMinuteBars, getRequestStats('EDGE')).issued;
  const { latestBySymbol, missingSymbols } = barsResult;

  const { withGap, top50, above10pct } = _buildGapResults(priceFilteredSymbols, latestBySymbol, priorCloses);
  const wallClockMs = Date.now() - t0;
  const coverageRate = priceFilteredSymbols.length
    ? (priceFilteredSymbols.length - missingSymbols.length) / priceFilteredSymbols.length
    : null;

  // Phase 1 acceptance #2 ("no alphabetical bias"): the original v1 bias
  // came from fetchMultiBars' pagination truncation plus a stable-sort
  // tie-break, both absent from this path (this sorts by changePct, not
  // symbol, and the Bug 1 fix means no truncation feeds it) — but that's a
  // reason to expect no bias, not proof of it. Measured every run instead
  // of asserted once, so it's live evidence on an ongoing basis rather than
  // a one-time manual check that goes stale.
  const resultSymbols = [...top50, ...above10pct].map(w => w.symbol);
  const letterDistribution = {};
  resultSymbols.forEach(sym => {
    const letter = (sym[0] || '?').toUpperCase();
    letterDistribution[letter] = (letterDistribution[letter] || 0) + 1;
  });

  return {
    session,
    tradableCount: assetIndex.length,
    eligibleCount: eligibleSymbols.length,
    priceFilteredCount: priceFilteredSymbols.length,
    resultCount: top50.length + above10pct.length,
    sample: [...top50, ...above10pct].slice(0, 10),
    letterDistribution,
    requestsObserved: {
      assetIndex: assetIndexRequestsObserved,
      priorCloses: priorClosesRequestsObserved,
      minuteBars: minuteBarsRequestsObserved,
      total: assetIndexRequestsObserved + priorClosesRequestsObserved + minuteBarsRequestsObserved,
    },
    wallClockMs,
    coverageRate,
    missingAfterBothPasses: missingSymbols.length,
  };
}
