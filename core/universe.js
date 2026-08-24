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
// convention). Live count on that run: 14,203 tradable us_equity assets —
// meaningfully above the spec's ~11k estimate; see getUniverse's header
// comment for what that changes about the premarket-gap cost estimate
// (not yet built).

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

// getUniverse({session, strategy}) — docs/warrior-engine-spec-v2.md Phase 1.
// strategy: 'movers' | 'premarket-gap' | 'full-filtered'
// → [{ symbol, price, prevClose, changePct, volume, source }]
//
// Only 'movers' is implemented this phase (see file header for why).
// 'premarket-gap' and 'full-filtered' are not yet built — calling either
// throws rather than silently returning an empty/wrong universe.
async function getUniverse({ session, strategy }) {
  if (strategy === 'movers') return _getMoversUniverse(session);
  throw new Error(`getUniverse: strategy '${strategy}' is not implemented yet — only 'movers' this phase.`);
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
