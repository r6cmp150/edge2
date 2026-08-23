// core/api-client.js — owned by neither engine. core/ never imports from engines/.
// Alpaca auth + transport only (keys, headers, the bare fetch wrapper).
// The shared rate-limit queue is Phase 0.5 — not built here; see
// docs/warrior-engine-spec-v2.md Phase 0.5 before adding an enqueue() layer.
// Moved from app.js's "── 6. ALPACA API ───" section (Phase 0 extraction).

const ALPACA_BASE = 'https://data.alpaca.markets/v2';

// Pre-approved Phase 0 exception to "move-only" (see spec's "Known debt to
// record, not fix" note + explicit sign-off on this one guard): asserts an
// ordering assumption instead of silently trusting it. Today alpacaHeaders()
// is never called before loadState() populates state.settings, because
// init() runs last — but that's implicit, and Warrior will call through this
// same path on a different schedule, which is exactly when an implicit
// ordering assumption becomes a real bug. Throwing here instead of sending
// an empty key turns a confusing 401 into a diagnosable error at the source.
function alpacaHeaders() {
  if (typeof state.settings.alpacaKey !== 'string' || typeof state.settings.alpacaSecret !== 'string') {
    throw new Error('AlpacaSettingsNotLoadedError: alpacaHeaders() called before state.settings was populated by loadState() — caller is running ahead of app init.');
  }
  return {
    'APCA-API-KEY-ID': state.settings.alpacaKey,
    'APCA-API-SECRET-KEY': state.settings.alpacaSecret,
  };
}

// `base` defaults to ALPACA_BASE ('.../v2') — the market-data endpoints all
// live there. News is the one exception: Alpaca serves it from '/v1beta1',
// not '/v2' (see core/news.js), so callers on a different base pass it
// explicitly rather than this function guessing per-path.
async function alpacaGet(path, params = {}, base = ALPACA_BASE) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { headers: alpacaHeaders() });
  if (!r.ok) throw new Error(`Alpaca ${r.status}: ${await r.text()}`);
  return r.json();
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Alpaca rejects an entire batch request with a 400 if ANY symbol in it is
// malformed (confirmed in production via AAC-U) — a hyphen, space, or other
// non-alphanumeric character kills the whole batch, not just that ticker.
// Applied at every batch-request entry point below so a single bad ticker
// in any universe can't take down an entire scan.
function sanitizeTickerBatch(tickers) {
  return tickers.filter(t => /^[A-Z0-9]+$/.test(t));
}

async function testAlpacaConnection() {
  try {
    await alpacaGet('/stocks/snapshots', { symbols: 'AAPL', feed:'iex' });
    return true;
  } catch(e) { return false; }
}
