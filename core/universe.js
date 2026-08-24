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
// documented signal at all is free text in `name` — Alpaca's own schema
// example is literally "Apple Inc. Common Stock" — so this requires that
// substring rather than trying to enumerate every non-common-stock suffix
// (unit/warrant/right/preferred/depositary share/...), which risks missing
// one. RFAIU ($51.76, a SPAC unit) in the movers diagnostic sample next to
// RFAI (the underlying common stock) is exactly the contamination this
// exists to catch.
function _isCommonStock(asset) {
  return typeof asset.name === 'string' && /common stock/i.test(asset.name);
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
    .map(a => ({ symbol: a.symbol, exchange: a.exchange, name: a.name, isCommonStock: _isCommonStock(a) }));
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
    return !!(asset && asset.isCommonStock);
  });

  // `top=50` is a hard cap Alpaca imposes on each endpoint, not "everything
  // meeting criteria" the way Ross Cameron's own scanner works — logged
  // explicitly so a thin count here is visibly "the cap may be cutting off
  // real candidates," not indistinguishable from "the market is quiet."
  // There is no way to tell those two apart from this endpoint alone.
  console.log(`getUniverse('movers'): ${rawGainersCount} movers + ${rawActivesCount} actives (top=50 cap each) -> ${combined.length} after dedupe -> ${priceFiltered.length} in $1-$20 -> ${instrumentFiltered.length} common stock`);

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
