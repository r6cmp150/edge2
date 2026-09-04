// core/edgar.js — owned by neither engine. core/ never imports from engines/.
// docs/warrior-engine-spec-v2.md Phase 6 (float, completing Pillar 5) —
// written against FMP originally; FMP's 402s on exactly the microcap
// population this gate targets (confirmed live during the backtest:
// DAIC/SPCE/HUBC/QH/HCWC all blocked — a symbol-coverage gate on the
// available tier, not a documented "paid tier" nuance). SEC EDGAR
// (data.sec.gov) is the substitute: no key, no auth, confirmed live
// during the backtest to return real, filing-dated shares-outstanding
// data for exactly the symbols FMP couldn't serve. This file adapts that
// already-proven backtest logic (scripts/lib/edgar.mjs) for the live app.
//
// Deliberately shares-outstanding ONLY, not EntityPublicFloat, for this
// gate pillar specifically -- the backtest measured both as two
// INDEPENDENT buckets, never blended into a fallback (a pillar whose
// `value` sometimes means "$X public float" and sometimes "Y shares
// outstanding" is exactly the ambiguous-slot problem the pre-market RVOL
// pillar was built to avoid). Shares outstanding has fuller EDGAR
// coverage (real backtest measurement: ~88% vs EntityPublicFloat's
// ~65%) and is the ALREADY-established primary proxy this session
// settled on, labeled honestly as shares outstanding, no haircut.
//
// No key, no rate-limit queue to route through (core/api-client.js's
// queue is Alpaca-specific -- wrong auth shape, wrong base URL, wrong
// budget entirely for an unauthenticated, differently-rate-limited
// government API). SEC's fair-use policy: a descriptive User-Agent,
// ~10 req/s -- self-paced here at ~8/s (120ms between requests), same
// margin the backtest's own scripts/lib/edgar.mjs already proved safe
// live.
const EDGAR_UA = 'EDGE2-Warrior-Live rtcmp150@gmail.com';
const EDGAR_PACE_MS = 120;
const _edgarSleep = (ms) => new Promise(r => setTimeout(r, ms));

// CIK map (ticker -> CIK): one large, mostly-static file (~10K entries).
// Cached the same 24h duration core/universe.js's own asset-index cache
// uses -- reference data that changes rarely, not worth re-fetching on
// every scan.
const EDGAR_CIK_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Per-symbol share data: spec's own explicit guidance (Phase 6, "Cache
// hard"), adapted from FMP to EDGAR -- "Float changes on offerings, not
// daily. Cache per-ticker for 7-30 days." 14 days: the midpoint of that
// range, not picked to optimize anything specific.
const EDGAR_FLOAT_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

async function _edgarGet(url) {
  const res = await fetch(url, { headers: { 'User-Agent': EDGAR_UA } });
  if (res.status === 404) return null; // no data for this CIK/concept -- expected, not an error
  if (!res.ok) throw new Error(`EDGAR ${url}: HTTP ${res.status}`);
  return res.json();
}

async function _getEdgarCikMap() {
  const cache = state.warriorEdgarCikMapCache;
  if (cache && cache.fetchedAt && (Date.now() - new Date(cache.fetchedAt).getTime()) < EDGAR_CIK_CACHE_MAX_AGE_MS) {
    return cache.cikBySymbol;
  }
  const data = await _edgarGet('https://www.sec.gov/files/company_tickers.json');
  const cikBySymbol = {};
  for (const entry of Object.values(data || {})) cikBySymbol[entry.ticker] = entry.cik_str;
  state.warriorEdgarCikMapCache = { fetchedAt: new Date().toISOString(), cikBySymbol };
  persist('warriorEdgarCikMapCache');
  return cikBySymbol;
}

// Nearest PRECEDING filing's shares-outstanding value as of `asOfDateStr`
// (today, for a live gate check) -- never a FUTURE filing, which would be
// lookahead on a live decision. Same "most recent value strictly before
// the date in question" pattern _getPriorCloses/fetchPrevCloseAsOf
// already use for prices.
function _mostRecentSharesOutstanding(sharesPoints, asOfDateStr) {
  const preceding = (sharesPoints || [])
    .filter(p => p.filed && p.filed <= asOfDateStr)
    .sort((a, b) => b.filed.localeCompare(a.filed));
  if (!preceding.length) return null;
  const matched = preceding[0];
  const stalenessDays = Math.round((new Date(asOfDateStr) - new Date(matched.filed)) / 86400000);
  return { sharesOutstanding: matched.val, asOfDate: matched.filed, stalenessDays };
}

// Returns { sharesOutstandingBySymbol, requests, failedSymbols, unmappedSymbols }.
// sharesOutstandingBySymbol[sym] = { sharesOutstanding, asOfDate, stalenessDays } | undefined.
// unmappedSymbols: real, distinct from failedSymbols -- a symbol with no
// CIK mapping was never going to have EDGAR data (not a request that
// failed), same "structural absence vs failed measurement" distinction
// classifyGate's not-checked/fetch-failed split already depends on.
// Diagnostic only, not classification-critical: only reflects symbols
// resolved as unmapped THIS call, not ones already cached as unmapped
// from an earlier call (those simply won't appear in
// sharesOutstandingBySymbol either, which is what the caller actually
// needs -- gate.js's own not-checked branch covers both cases
// identically without needing this list to be cache-complete).
async function getFloatDataForSymbols(symbols) {
  const today = ptDateStr(getPT());
  let cache = state.warriorFloatCache;
  if (!cache) cache = { bySymbol: {} };

  const missing = symbols.filter(sym => {
    const entry = cache.bySymbol[sym];
    return !entry || !entry.fetchedAt || (Date.now() - new Date(entry.fetchedAt).getTime()) >= EDGAR_FLOAT_CACHE_MAX_AGE_MS;
  });

  let requests = 0;
  const failedSymbols = [];
  const unmappedSymbols = [];
  if (missing.length) {
    let cikBySymbol;
    try {
      cikBySymbol = await _getEdgarCikMap();
      requests++;
    } catch (e) {
      console.warn(`getFloatDataForSymbols: CIK map fetch failed: ${e.message}`);
      // Every missing symbol is unattributable without the map -- a real
      // fetch failure (we don't know), not "unmapped" (which means the
      // map itself said no CIK exists for this symbol).
      failedSymbols.push(...missing);
      cikBySymbol = null;
    }
    if (cikBySymbol) {
      for (const sym of missing) {
        const cik = cikBySymbol[sym];
        if (cik == null) {
          unmappedSymbols.push(sym);
          cache.bySymbol[sym] = { fetchedAt: new Date().toISOString(), sharesOutstanding: null, asOfDate: null, stalenessDays: null, unmapped: true };
          continue;
        }
        try {
          const cikPadded = String(cik).padStart(10, '0');
          const data = await _edgarGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/dei/EntityCommonStockSharesOutstanding.json`);
          requests++;
          const sharesPoints = (data?.units?.shares || []).map(p => ({ filed: p.filed, val: p.val }));
          const matched = _mostRecentSharesOutstanding(sharesPoints, today);
          cache.bySymbol[sym] = {
            fetchedAt: new Date().toISOString(),
            sharesOutstanding: matched ? matched.sharesOutstanding : null,
            asOfDate: matched ? matched.asOfDate : null,
            stalenessDays: matched ? matched.stalenessDays : null,
            unmapped: false,
          };
        } catch (e) {
          console.warn(`getFloatDataForSymbols: batch error for ${sym}: ${e.message}`);
          failedSymbols.push(sym);
        }
        await _edgarSleep(EDGAR_PACE_MS);
      }
    }
  }

  state.warriorFloatCache = cache;
  persist('warriorFloatCache');

  const sharesOutstandingBySymbol = {};
  for (const sym of symbols) {
    const entry = cache.bySymbol[sym];
    if (entry && entry.sharesOutstanding != null) {
      sharesOutstandingBySymbol[sym] = { sharesOutstanding: entry.sharesOutstanding, asOfDate: entry.asOfDate, stalenessDays: entry.stalenessDays };
    }
  }
  return { sharesOutstandingBySymbol, requests, failedSymbols, unmappedSymbols };
}
