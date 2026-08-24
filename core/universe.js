// core/universe.js — owned by neither engine. core/ never imports from engines/.
// docs/warrior-engine-spec-v2.md Phase 1. getUniverse({session, strategy})
// serves both engines: 'movers'/'premarket-gap' are Warrior's Top Gainer
// scanner primitives, 'full-filtered' is EDGE's eventual replacement for
// STOCK_UNIVERSES (built and functional this phase, not wired to anything —
// migrating EDGE onto it is a later, separate decision).
//
// This file currently holds only the pre-flight connectivity/coverage check
// (diagnoseUniverseEndpoints) — deliberately built and run FIRST, before any
// strategy logic, because movers/most-actives' actual price coverage can't
// be confirmed from documentation alone and materially changes the design
// if it turns out unfavorable: they cap at `top=50` and apply no price
// filter, so if a typical day's top 50 are mostly outside $1-$20, the
// endpoint is too coarse for a Warrior-scale ($1-$20 microcap) scan, and
// deriving gainers from full-filtered's own snapshots becomes the primary
// mechanism instead.
//
// /v2/assets (the trading-account host premarket-gap and full-filtered both
// need for the asset list) lives on paper-api.alpaca.markets, not
// data.alpaca.markets — confirmed against the account's key prefix (PK...,
// Alpaca's paper-account convention) rather than a live probe of both hosts.

const ALPACA_TRADING_BASE = 'https://paper-api.alpaca.markets';
const ALPACA_SCREENER_BASE = 'https://data.alpaca.markets/v1beta1';

function _inPriceRange(price) {
  return typeof price === 'number' && price >= 1 && price <= 20;
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
// getUniverse()'s eventual request path.
async function diagnoseUniverseEndpoints() {
  const [assets, movers, mostActives] = await Promise.all([
    _checkAssetsHost(),
    _checkMovers(),
    _checkMostActives(),
  ]);
  return { assets, movers, mostActives };
}
