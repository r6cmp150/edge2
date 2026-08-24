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
async function _getAssetIndex() {
  const cache = state.universeAssetCache;
  if (cache && cache.fetchedAt && (Date.now() - new Date(cache.fetchedAt).getTime()) < ASSET_CACHE_MAX_AGE_MS) {
    return cache.assets;
  }
  const raw = await alpacaGet('/v2/assets', { status: 'active', asset_class: 'us_equity' }, ALPACA_TRADING_BASE);
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
async function _getMoversUniverse(session) {
  if (session && session !== 'OPEN' && session !== 'AH') {
    console.warn(`getUniverse('movers'): called during session=${session} — movers returns stale prior-day data before market open; consider 'premarket-gap' instead.`);
  }

  const [moversData, activesData, assetIndex] = await Promise.all([
    alpacaGet('/screener/stocks/movers', { top: 50 }, ALPACA_SCREENER_BASE),
    alpacaGet('/screener/stocks/most-actives', { top: 50 }, ALPACA_SCREENER_BASE),
    _getAssetIndex(),
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
  const activeSnaps = activeSymbols.length ? await fetchSnapshots(activeSymbols) : {};
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
async function _getPriorCloses(symbols) {
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
          const params = { symbols: batch.join(','), timeframe: '1Day', start, limit: batch.length * 3, sort: 'desc', feed: 'iex' };
          if (pageToken) params.page_token = pageToken;
          const data = await alpacaGet('/stocks/bars', params);
          if (data.bars) {
            for (const sym of Object.keys(data.bars)) {
              (barsBySymbol[sym] = barsBySymbol[sym] || []).push(...data.bars[sym]);
            }
          }
          pageToken = data.next_page_token || null;
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

// Single-window fetch, factored out so pass 1 and pass 2 (below) share
// identical chunking/pagination/error-handling instead of drifting apart.
// Returns requests made so callers can report per-pass cost, same
// visibility principle as fetchMultiBars' droppedSymbols.
async function _fetchMinuteBarsWindow(symbols, end, windowMin) {
  const start = new Date(end.getTime() - windowMin * 60 * 1000);
  const latestBySymbol = {};
  let requests = 0;
  for (const batch of chunk(symbols, SNAPSHOT_CHUNK_SIZE)) {
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
        const data = await alpacaGet('/stocks/bars', params);
        requests++;
        if (data.bars) {
          for (const sym of Object.keys(data.bars)) {
            (barsBySymbol[sym] = barsBySymbol[sym] || []).push(...data.bars[sym]);
          }
        }
        pageToken = data.next_page_token || null;
      } while (pageToken);
      // sort:'desc' -> each symbol's first bar is its most recent within [start, end].
      batch.forEach(sym => {
        const bars = barsBySymbol[sym];
        if (bars && bars.length) latestBySymbol[sym] = bars[0];
      });
    } catch (e) {
      console.warn(`_fetchMinuteBarsWindow: batch error for ${batch.length} symbols (${windowMin}min window): ${e.message}`);
    }
  }
  return { latestBySymbol, requests };
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
async function _fetchLatestSipMinuteBars(symbols) {
  const end = new Date(Date.now() - PREMARKET_BAR_DELAY_MIN * 60 * 1000);

  const pass1 = await _fetchMinuteBarsWindow(symbols, end, PREMARKET_BAR_WINDOW_MIN);
  const missingAfterPass1 = symbols.filter(sym => !(sym in pass1.latestBySymbol));

  let pass2 = { latestBySymbol: {}, requests: 0 };
  if (missingAfterPass1.length) {
    pass2 = await _fetchMinuteBarsWindow(missingAfterPass1, end, PREMARKET_BAR_WINDOW_WIDE_MIN);
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

async function _getPremarketGapUniverse() {
  const assetIndex = await _getAssetIndex();
  // Bug (found live, 2026-08-24): this used to be assetIndex.map(a =>
  // a.symbol) — every tradable/exchange-filtered symbol, ignoring
  // isEligibleInstrument entirely. _getMoversUniverse always applied that
  // filter; this path never did, so warrants/units/leveraged ETFs (HQWWW,
  // FVNNU, BTDL — the GraniteShares 2x Long BTDR ETF, one of the exact
  // names from the ETF exclusion sample) reached the ranked output.
  const eligibleSymbols = assetIndex.filter(a => a.isEligibleInstrument).map(a => a.symbol);

  const priorCloses = await _getPriorCloses(eligibleSymbols);
  const priceFilteredSymbols = eligibleSymbols.filter(sym => _inPriceRange(priorCloses[sym]));

  console.log(`getUniverse('premarket-gap'): ${assetIndex.length} tradable -> ${eligibleSymbols.length} instrument-eligible -> ${priceFilteredSymbols.length} with prior close in $1-$20`);
  if (!priceFilteredSymbols.length) return [];

  const { latestBySymbol, missingSymbols } = await _fetchLatestSipMinuteBars(priceFilteredSymbols);
  if (missingSymbols.length) {
    console.warn(`getUniverse('premarket-gap'): ${missingSymbols.length} of ${priceFilteredSymbols.length} symbols had no SIP minute bar in either window pass — excluded from gap ranking, not silently absent.`);
  }

  const { withGap, top50, above10pct } = _buildGapResults(priceFilteredSymbols, latestBySymbol, priorCloses);

  console.log(`getUniverse('premarket-gap'): ${withGap.length} priced -> top 50 by gap% + ${above10pct.length} additional >=10% gap = ${top50.length + above10pct.length} returned`);

  return [...top50, ...above10pct];
}

// getUniverse({session, strategy}) — docs/warrior-engine-spec-v2.md Phase 1.
// strategy: 'movers' | 'premarket-gap' | 'full-filtered'
// → [{ symbol, price, prevClose, changePct, volume, source }]
//
// 'full-filtered' is not yet built — calling it throws rather than
// silently returning an empty/wrong universe.
async function getUniverse({ session, strategy }) {
  if (strategy === 'movers') return _getMoversUniverse(session);
  if (strategy === 'premarket-gap') return _getPremarketGapUniverse();
  throw new Error(`getUniverse: strategy '${strategy}' is not implemented yet.`);
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

// Temporarily wraps the shared alpacaGet to count requests made during fn(),
// without changing alpacaGet's signature or any production caller's
// contract — this is a diagnostic-only need, not a reason to thread a
// counter through _getAssetIndex/_getPriorCloses's real return shapes.
// Restored in a finally so a thrown error never leaves the global wrapped.
async function _countRequests(fn) {
  const real = alpacaGet;
  let count = 0;
  alpacaGet = (...args) => { count++; return real(...args); };
  try {
    const result = await fn();
    return { result, count };
  } finally {
    alpacaGet = real;
  }
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
async function diagnosePremarketGap() {
  const session = getMarketStatus().status;
  const t0 = Date.now();

  const { result: assetIndex, count: assetIndexRequests } = await _countRequests(() => _getAssetIndex());
  const eligibleSymbols = assetIndex.filter(a => a.isEligibleInstrument).map(a => a.symbol);

  const { result: priorCloses, count: priorClosesRequests } = await _countRequests(() => _getPriorCloses(eligibleSymbols));
  const priceFilteredSymbols = eligibleSymbols.filter(sym => _inPriceRange(priorCloses[sym]));

  const barsResult = priceFilteredSymbols.length
    ? await _fetchLatestSipMinuteBars(priceFilteredSymbols)
    : { latestBySymbol: {}, missingSymbols: [], pass1Requests: 0, pass2Requests: 0 };
  const { latestBySymbol, missingSymbols, pass1Requests, pass2Requests } = barsResult;

  const { withGap, top50, above10pct } = _buildGapResults(priceFilteredSymbols, latestBySymbol, priorCloses);
  const wallClockMs = Date.now() - t0;
  const coverageRate = priceFilteredSymbols.length
    ? (priceFilteredSymbols.length - missingSymbols.length) / priceFilteredSymbols.length
    : null;

  return {
    session,
    tradableCount: assetIndex.length,
    eligibleCount: eligibleSymbols.length,
    priceFilteredCount: priceFilteredSymbols.length,
    resultCount: top50.length + above10pct.length,
    sample: [...top50, ...above10pct].slice(0, 10),
    requests: {
      assetIndex: assetIndexRequests,
      priorCloses: priorClosesRequests,
      minuteBarsPass1: pass1Requests,
      minuteBarsPass2: pass2Requests,
      total: assetIndexRequests + priorClosesRequests + pass1Requests + pass2Requests,
    },
    wallClockMs,
    coverageRate,
    missingAfterBothPasses: missingSymbols.length,
  };
}
