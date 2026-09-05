// core/edgar.js — Node-only now (2026-09-04, see below), owned by neither
// engine. docs/warrior-engine-spec-v2.md Phase 6 (float, completing Pillar
// 5) — written against FMP originally; FMP's 402s on exactly the microcap
// population this gate targets (confirmed live during the backtest:
// DAIC/SPCE/HUBC/QH/HCWC all blocked — a symbol-coverage gate on the
// available tier, not a documented "paid tier" nuance). SEC EDGAR
// (data.sec.gov) is the substitute: no key, no auth.
//
// REMOVED FROM THE BROWSER, 2026-09-04: this file is no longer loaded by
// index.html and getFloatDataForSymbols is no longer called live from
// gate.js. A real boot check found the live float pillar failing for
// every candidate that reached it (MARA, a large NASDAQ filer with a
// certain EntityPublicFloat on file, still read "float fetch failed") —
// confirmed as CORS: data.sec.gov and www.sec.gov send no
// Access-Control-Allow-Origin on a real GET, and flatly 403 any CORS
// preflight OPTIONS request (Akamai WAF). SEC's API was never reachable
// from a browser; every EDGAR verification this session that looked clean
// ran from Node, where CORS doesn't apply. This file's derivation logic
// (below) is correct and stays in use — but now ONLY from
// scripts/build-float-table.mjs (a weekly GitHub Action, see
// .github/workflows/build-float-table.yml), which calls
// getFloatDataForSymbols the same way this file always worked and writes
// the settled verdicts to data/float-table.json. The live app reads that
// file same-origin via core/float-table.js — no CORS, no forbidden
// headers, no runtime rate limit. See that file's own header and
// docs/warrior-engine-spec-v2.md Phase 6 for the full architecture.
//
// REVISED 2026-09-03 (superseding this file's original shares-outstanding-
// only design): shares outstanding was the WRONG QUANTITY, not just a
// looser proxy — confirmed live via DAIC (EntityCommonStockSharesOutstanding
// 30,259,579 vs EntityPublicFloat $7,171,964, an order-of-magnitude gap
// that's exactly insiders/restricted stock, not measurement noise). Ross's
// rule is about the FREE-TRADABLE float, and EntityPublicFloat is the SEC's
// own float measurement, so it's now the pillar's gating value.
//
// EntityPublicFloat is DOLLAR-denominated, priced as of its OWN reference
// date (the `end` field — last business day of the registrant's most
// recently completed second fiscal quarter, annual-only, 10-K cover page).
// To get a SHARE count (the right unit for Ross's <10M rule), divide by the
// historical closing price on that SAME reference date.
//
// CORRECTED AGAIN 2026-09-03, same day: the price used for that division
// must be the SPLIT-ADJUSTED close (adjustment:'all'), not the raw one —
// an earlier version of this file got this backwards. The reasoning that
// led to 'raw' ("EntityPublicFloat was priced against the actual
// unadjusted trade") is true but answers the wrong question: dividing by
// the raw historical price returns the share count AS IT EXISTED ON THAT
// HISTORICAL DATE, in THAT DATE's share-count basis. The 10M threshold
// (and `sharesOutstanding`, fetched below for exactly this comparison)
// is in TODAY's share-count basis. Those two bases are IDENTICAL only if
// no split has happened in between — routinely false in this population.
// Alpaca's adjusted series exists precisely to re-express historical
// prices in today's-equivalent terms (a reverse split scales pre-split
// prices UP by the split ratio), so float$ ÷ adjustedPrice lands in
// today's share-count basis, which is what's actually comparable to the
// threshold and to sharesOutstanding.
//
// Confirmed live, not just reasoned: DAIC's raw vs. adjusted close on its
// float's own reference date (2026-03-10) were $0.2454 vs. $6.135 — a
// 25.0x ratio, matching the ~25:1 reverse split this project already knew
// DAIC underwent. Raw-derived implied float: 29.2M shares (in the OLD,
// pre-split basis) — coincidentally still numerically below DAIC's
// CURRENT (post-split) shares outstanding of 30.26M, which would pass a
// naive "float <= shares outstanding" check despite comparing two
// different unit systems. Adjusted-derived implied float: 1.17M shares,
// in the SAME basis as sharesOutstanding, ~3.9% of it — the number that
// actually means something. HCWC showed the same pattern (~35x factor).
// This is why the invariant guard below (impliedFloatShares must not
// exceed sharesOutstanding) is necessary but NOT sufficient on its own to
// catch a unit mismatch — it catches the cases where the wrong-basis
// number happens to overshoot, not every case where it doesn't.
//
// _fetchHistoricalDailyBars (core/universe.js) already does chunked/paged
// daily-bar fetches; reused here with its default adjustment ('all',
// passed explicitly for this file's own reviewability, not because the
// default alone would suffice as documentation).
//
// EntityCommonStockSharesOutstanding is fetched alongside EntityPublicFloat
// now purely as a VALIDATION guard (2026-09-03), not as a gating value or
// fallback — a derived quantity built by multiplying two independently
// stale SEC facts together (a dollar figure and, indirectly, a price) has
// no other structural check on it. Float is a subset of shares outstanding
// by definition; if the derived value exceeds it, the derivation is
// provably wrong for that symbol this scan, and the pillar reads
// not-checked with the reason logged, rather than a fabricated number.
//
// A measured dispersion check (2026-09-03, scripts/measure-float-ratio-
// dispersion.mjs, re-run under the adjusted-price correction, n=204 of 209
// backtest symbols with a resolvable price) ruled out a calibrated
// shares-outstanding fallback for the ~35% of symbols with no
// EntityPublicFloat filing at all: (implied float shares ÷ shares
// outstanding) — median 0.58, p10 0.02, p90 1.00, range 0.00–27.6, with
// 22/204 (10.8%) still physically impossible (float exceeding shares
// outstanding) even under the corrected adjusted-price basis — real
// staleness/mismatch between the two filings' own dates, not a units bug
// this time (that's exactly what the invariant guard below exists to
// catch per-symbol, live). Meaningfully tighter than the pre-correction
// measurement (which spanned 0.00–331, 18% impossible, most of that width
// being the raw-price units error itself) but still nowhere near the
// "mostly 0.4–0.6" bar this session set for a defensible calibration.
// Those ~35% symbols read not-checked, same as before Phase 6 existed for
// them — no regression, no fallback (a slot that sometimes means
// dollars-derived shares and sometimes raw shares outstanding is exactly
// the ambiguity pre-market RVOL was built to avoid).
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

// Per-symbol float data: spec's own explicit guidance (Phase 6, "Cache
// hard"), adapted from FMP to EDGAR -- "Float changes on offerings, not
// daily. Cache per-ticker for 7-30 days." 14 days: the midpoint of that
// range, not picked to optimize anything specific.
const EDGAR_FLOAT_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// How far back to pad a historical-price lookup from the float's own
// reference date, to absorb weekends/holidays around it. SEC defines the
// reference date as "the last business day," so it should itself be a
// trading day -- this pad is a safety margin against bar-availability
// gaps, not an expected normal case.
const EDGAR_PRICE_LOOKUP_PAD_DAYS = 10;

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

// Nearest PRECEDING EntityPublicFloat filing's fact as of `asOfDateStr`
// (today, for a live gate check) -- never a FUTURE filing, which would be
// lookahead on a live decision. Matched by FILED date (when the filing
// became public), not `end` (the fact's own price-reference date) -- we
// can only use a fact once it's actually been disclosed.
function _mostRecentPublicFloatFact(floatPoints, asOfDateStr) {
  const preceding = (floatPoints || [])
    .filter(p => p.filed && p.filed <= asOfDateStr)
    .sort((a, b) => b.filed.localeCompare(a.filed));
  return preceding.length ? preceding[0] : null; // { end, filed, val } | null
}

// Nearest PRECEDING EntityCommonStockSharesOutstanding filing as of
// `asOfDateStr` (today, for a live gate check) -- used as the CORRECTION's
// "shares outstanding today" term and, unchanged, as the invariant guard's
// comparison value (see header).
function _mostRecentSharesOutstanding(sharesPoints, asOfDateStr) {
  const preceding = (sharesPoints || [])
    .filter(p => p.filed && p.filed <= asOfDateStr)
    .sort((a, b) => b.filed.localeCompare(a.filed));
  return preceding.length ? preceding[0].val : null;
}

// Nearest BY DATE (not necessarily preceding) EntityCommonStockShares-
// Outstanding filing to `targetDateStr` -- the dilution correction's "what
// were shares outstanding AROUND the float's own reference date" term.
// Deliberately NOT "nearest preceding" here: this is a retrospective
// reconstruction of history (what the share count actually was near a
// PAST date), not a live no-lookahead decision, so the closest available
// point on either side is the right match -- same reasoning
// scripts/measure-float-ratio-dispersion.mjs used. Matched by `end` (the
// fact's own as-of date) when available, `filed` otherwise.
function _nearestSharesOutstandingToDate(sharesPoints, targetDateStr) {
  let best = null, bestGapMs = Infinity;
  for (const p of (sharesPoints || [])) {
    const pointDateStr = p.end || p.filed;
    if (!pointDateStr) continue;
    const gapMs = Math.abs(new Date(pointDateStr) - new Date(targetDateStr));
    if (gapMs < bestGapMs) { bestGapMs = gapMs; best = p; }
  }
  return best; // { end, filed, val } | null
}

// Returns { floatBySymbol, requests, failedSymbols, unmappedSymbols }.
// floatBySymbol[sym] = { impliedFloatShares, referenceDate, stalenessDays } | undefined.
// unmappedSymbols: real, distinct from failedSymbols -- a symbol with no
// CIK mapping was never going to have EDGAR data (not a request that
// failed), same "structural absence vs failed measurement" distinction
// classifyGate's not-checked/fetch-failed split already depends on.
// Diagnostic only, not classification-critical: only reflects symbols
// resolved as unmapped THIS call, not ones already cached as unmapped
// from an earlier call (those simply won't appear in floatBySymbol either,
// which is what the caller actually needs -- gate.js's own not-checked
// branch covers both cases identically without needing this list to be
// cache-complete).
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

    // ── Phase A: fetch each missing symbol's EntityPublicFloat facts
    // (the gating value) AND EntityCommonStockSharesOutstanding (the
    // validation guard only, see header) in parallel, pick the most
    // recent fact of each disclosed as of today. ──
    const matchedFactBySymbol = {}; // sym -> { end, filed, val, sharesOutstanding }
    if (cikBySymbol) {
      for (const sym of missing) {
        const cik = cikBySymbol[sym];
        if (cik == null) {
          unmappedSymbols.push(sym);
          cache.bySymbol[sym] = { fetchedAt: new Date().toISOString(), impliedFloatShares: null, referenceDate: null, unmapped: true, priceFetchFailed: false };
          continue;
        }
        try {
          const cikPadded = String(cik).padStart(10, '0');
          const [floatData, sharesData] = await Promise.all([
            _edgarGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/dei/EntityPublicFloat.json`),
            _edgarGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/dei/EntityCommonStockSharesOutstanding.json`),
          ]);
          requests += 2;
          // Array.isArray guard (2026-09-04, found live building the full
          // float table): SEC's companyconcept endpoint doesn't always omit
          // an empty unit or return an empty array for "no data" -- some
          // filers (confirmed live: BIIB and ~25 others in the first ~700
          // symbols of a full-universe run, not rare edge cases) get back
          // `units: { shares: {} }`, an EMPTY OBJECT, not an empty array.
          // `{} || []` stays `{}` (truthy), so `.map` threw for every one of
          // these -- a real, silent data-loss bug (those symbols fell into
          // "missing," indistinguishable from a genuine build-time failure)
          // until this guard, not a rare malformed-response case.
          const floatRaw = floatData?.units?.USD;
          const sharesRaw = sharesData?.units?.shares;
          const floatPoints = (Array.isArray(floatRaw) ? floatRaw : []).map(p => ({ end: p.end, filed: p.filed, val: p.val }));
          // `end` kept now (2026-09-04, dilution correction) -- needed to
          // find the shares-outstanding point nearest the FLOAT's own
          // reference date, not just "most recent as of today."
          const sharesPoints = (Array.isArray(sharesRaw) ? sharesRaw : []).map(p => ({ end: p.end, filed: p.filed, val: p.val }));
          const matched = _mostRecentPublicFloatFact(floatPoints, today);
          const sharesOutstandingToday = _mostRecentSharesOutstanding(sharesPoints, today);
          if (matched && matched.end > today) {
            // Data-integrity issue, not a missing price (2026-09-04, found
            // live: NATH's matched fact resolved to a reference date in the
            // FUTURE relative to today -- SEC's own filing data, not a bug
            // in the filed-date filter above, which only constrains WHEN a
            // fact was disclosed, not what reference date it claims).
            // Caught and reasoned distinctly BEFORE attempting a price
            // lookup -- there's no legitimate price to find for a future
            // date, so don't spend an Alpaca call finding that out.
            const invalidReferenceDateReason = `float reference date (${matched.end}) is after today (${today}) — a data-integrity issue in the SEC filing, not a missing price`;
            console.warn(`getFloatDataForSymbols: ${sym} ${invalidReferenceDateReason}`);
            cache.bySymbol[sym] = { fetchedAt: new Date().toISOString(), impliedFloatShares: null, referenceDate: null, unmapped: false, priceFetchFailed: false, invalidReferenceDateReason };
          } else if (matched) {
            const sharesNearRef = _nearestSharesOutstandingToDate(sharesPoints, matched.end);
            matchedFactBySymbol[sym] = { ...matched, sharesOutstandingToday, sharesNearRef };
          } else {
            // Real, mapped company, genuinely no EntityPublicFloat filing
            // (or none yet disclosed as of today) -- structural absence,
            // not-checked, never a block. Identical to how this symbol
            // would have read before Phase 6 existed.
            cache.bySymbol[sym] = { fetchedAt: new Date().toISOString(), impliedFloatShares: null, referenceDate: null, unmapped: false, priceFetchFailed: false };
          }
        } catch (e) {
          console.warn(`getFloatDataForSymbols: EntityPublicFloat/SharesOutstanding fetch error for ${sym}: ${e.message}`);
          failedSymbols.push(sym);
        }
        await _edgarSleep(EDGAR_PACE_MS);
      }
    }

    // ── Phase B: batch the historical close lookups by unique reference
    // date (many symbols share common fiscal-quarter-end dates) -- one
    // _fetchHistoricalDailyBars call per unique date instead of one per
    // symbol. BOTH adjustment:'all' (expresses the close in TODAY's
    // share-count basis -- see header) AND adjustment:'raw' now (2026-09-04,
    // dilution correction, see below) are fetched per date. ──
    const symbolsByRefDate = {};
    for (const [sym, fact] of Object.entries(matchedFactBySymbol)) {
      (symbolsByRefDate[fact.end] = symbolsByRefDate[fact.end] || []).push(sym);
    }
    for (const [refDate, syms] of Object.entries(symbolsByRefDate)) {
      const padStart = new Date(`${refDate}T00:00:00Z`);
      padStart.setUTCDate(padStart.getUTCDate() - EDGAR_PRICE_LOOKUP_PAD_DAYS);
      const padStartStr = padStart.toISOString().slice(0, 10);
      try {
        const [{ barsBySymbol: adjBars, requests: adjReq }, { barsBySymbol: rawBars, requests: rawReq }] = await Promise.all([
          _fetchHistoricalDailyBars(syms, padStartStr, refDate, _coreClient, 'all'),
          _fetchHistoricalDailyBars(syms, padStartStr, refDate, _coreClient, 'raw'),
        ]);
        requests += adjReq + rawReq;
        for (const sym of syms) {
          const adjOnOrBefore = (adjBars[sym] || []).filter(b => b.t.slice(0, 10) <= refDate).sort((a, b) => b.t.localeCompare(a.t));
          const rawOnOrBefore = (rawBars[sym] || []).filter(b => b.t.slice(0, 10) <= refDate).sort((a, b) => b.t.localeCompare(a.t));
          const fact = matchedFactBySymbol[sym];
          if (adjOnOrBefore.length && adjOnOrBefore[0].c > 0) {
            const impliedFloatAtRefShares = fact.val / adjOnOrBefore[0].c;

            // Dilution correction (2026-09-04, found live: BIAF and GRI
            // both PASSED the <10M gate on implied floats of 174,868 and
            // 41,528 shares -- both from a filing 431 days old, both wildly
            // inconsistent with real trading volume once checked). The
            // derivation is CORRECT at its own reference date; what makes
            // it wrong today is share issuance in the intervening months,
            // which the split-adjusted price does NOT correct for (it only
            // undoes SPLITS, not dilution). EDGAR already gives the full
            // dated EntityCommonStockSharesOutstanding history (fetched
            // above for the guard anyway), so:
            //   impliedFloatToday = impliedFloatAtRef × (sharesToday ÷ sharesTrueNearRefInTodaysUnits)
            // sharesTrueNearRefInTodaysUnits = sharesNearRef ÷ R, where
            // R = adjustedClose/rawClose at the reference date -- the SAME
            // cumulative split factor the price adjustment already applied.
            // This division matters: naively scaling by RAW
            // sharesNearRef (no ÷R) DOUBLE-APPLIES any split that occurred
            // in the window, since impliedFloatAtRef is already split-
            // adjusted. Verified live: BIAF's naive-formula result (49,772)
            // moved the WRONG direction; R-corrected (22,394,073) correctly
            // flips it to fail the gate, and GRI's R-corrected result
            // (1,011,000, R=28) passes a live volume-consistency check at
            // ~0.43x where the uncorrected 41,528 read as ~10.5x.
            //
            // CAVEAT, stated on the card and here (2026-09-04, explicit):
            // this assumes the FREE-TRADING FRACTION held constant across
            // the correction window -- newly issued shares are often
            // restricted at issuance and become free-trading later. For a
            // heavy diluter that assumption UNDERSTATES today's true float
            // less than doing nothing would, but it can still understate
            // it somewhat -- and understating float is the DANGEROUS
            // direction (a false PASS, not a false fail). The
            // volume-consistency backstop (engines/warrior/gate.js) exists
            // specifically to catch what this approximation still misses.
            //
            // Skipped (falls back to the uncorrected impliedFloatAtRef)
            // when there's no shares-outstanding data to correct WITH at
            // all -- confirmed live for ~16% of usable entries (486/3032),
            // including real, established filers (GPRO/GoPro among them):
            // no dei:EntityCommonStockSharesOutstanding history exists for
            // them under this concept at all (checked GPRO's full company
            // facts directly -- only EntityPublicFloat exists under dei;
            // its us-gaap:CommonStockSharesOutstanding facts are stale,
            // pre-2021, zero-valued legacy entries, not a usable modern
            // fallback). For these, the uncorrected value stands and the
            // volume-consistency backstop is the ONLY protection -- exactly
            // why that check stays regardless of this correction's own
            // coverage.
            let impliedFloatShares = impliedFloatAtRefShares;
            let dilutionCorrected = false;
            let splitFactor = null;
            if (fact.sharesNearRef && fact.sharesOutstandingToday != null && rawOnOrBefore.length && rawOnOrBefore[0].c > 0) {
              const R = adjOnOrBefore[0].c / rawOnOrBefore[0].c;
              if (Number.isFinite(R) && R > 0) {
                const sharesTrueNearRefTodaysUnits = fact.sharesNearRef.val / R;
                if (sharesTrueNearRefTodaysUnits > 0) {
                  impliedFloatShares = impliedFloatAtRefShares * (fact.sharesOutstandingToday / sharesTrueNearRefTodaysUnits);
                  dilutionCorrected = true;
                  splitFactor = R;
                }
              }
            }

            // Invariant guard (2026-09-03, now applied to the
            // dilution-corrected value when available -- see above): float
            // is a subset of shares outstanding by definition. A derived
            // value that exceeds it is provably wrong for this symbol this
            // scan -- discard rather than gate on a number known to be
            // wrong. Only checked when sharesOutstanding itself was
            // available -- its absence isn't grounds to distrust an
            // otherwise-normal derivation.
            if (fact.sharesOutstandingToday != null && impliedFloatShares > fact.sharesOutstandingToday) {
              const invalidReason = `implied float (${Math.round(impliedFloatShares).toLocaleString()}${dilutionCorrected ? ', dilution-corrected' : ''}) exceeds shares outstanding (${fact.sharesOutstandingToday.toLocaleString()}) — value discarded as invalid`;
              console.warn(`getFloatDataForSymbols: ${sym} ${invalidReason}`);
              cache.bySymbol[sym] = { fetchedAt: new Date().toISOString(), impliedFloatShares: null, referenceDate: null, unmapped: false, priceFetchFailed: false, invalidReason, sharesOutstandingAtCheck: fact.sharesOutstandingToday };
            } else {
              cache.bySymbol[sym] = { fetchedAt: new Date().toISOString(), impliedFloatShares, impliedFloatAtRefShares, referenceDate: fact.end, unmapped: false, priceFetchFailed: false, sharesOutstandingAtCheck: fact.sharesOutstandingToday, dilutionCorrected, splitFactor };
            }
          } else {
            // Distinct from a build FAILURE (2026-09-04, reclassified after
            // a full-universe build showed this as ~99% of that run's
            // "failed" bucket — 232/233, confirmed live via a direct Alpaca
            // query for a sample that Alpaca genuinely returns zero bars,
            // not a batch/network fault). A real EntityPublicFloat filing
            // exists, but no historical price is available near its
            // reference date -- most plausibly because the company wasn't
            // yet publicly traded that far back (many were clustered on a
            // single recent reference date, consistent with recent IPOs/
            // SPACs whose float fact predates their listing). This is
            // PERMANENT for that specific filing, not something a retry
            // fixes -- structurally the same kind of thing as "no filing,"
            // not a build defect, so it must not count against the
            // completeness/drift checks the way a real failure does.
            const noPriceDataReason = `no historical price data available near the float's reference date (${refDate}) — the company may not have been publicly traded yet at that time`;
            console.warn(`getFloatDataForSymbols: ${sym} ${noPriceDataReason}`);
            cache.bySymbol[sym] = { fetchedAt: new Date().toISOString(), impliedFloatShares: null, referenceDate: null, unmapped: false, priceFetchFailed: false, noPriceDataReason };
          }
        }
      } catch (e) {
        console.warn(`getFloatDataForSymbols: historical price batch failed for reference date ${refDate} (${syms.length} symbols): ${e.message}`);
        failedSymbols.push(...syms);
      }
    }
  }

  state.warriorFloatCache = cache;
  persist('warriorFloatCache');

  const floatBySymbol = {};
  for (const sym of symbols) {
    const entry = cache.bySymbol[sym];
    if (!entry) continue;
    if (entry.impliedFloatShares != null) {
      const stalenessDays = Math.round((new Date(today) - new Date(entry.referenceDate)) / 86400000);
      floatBySymbol[sym] = { impliedFloatShares: entry.impliedFloatShares, referenceDate: entry.referenceDate, stalenessDays, dilutionCorrected: entry.dilutionCorrected };
    } else if (entry.invalidReason) {
      // Guard-caught case (see the invariant check above): a real filing
      // WAS found, but the derived value failed the float<=shares-
      // outstanding sanity check -- carried through so the card shows the
      // real reason instead of the generic "no filing" one gate.js falls
      // back to when this isn't set.
      floatBySymbol[sym] = { impliedFloatShares: null, invalidReason: entry.invalidReason };
    } else if (entry.noPriceDataReason) {
      floatBySymbol[sym] = { impliedFloatShares: null, invalidReason: entry.noPriceDataReason };
    } else if (entry.invalidReferenceDateReason) {
      floatBySymbol[sym] = { impliedFloatShares: null, invalidReason: entry.invalidReferenceDateReason };
    }
  }
  return { floatBySymbol, requests, failedSymbols, unmappedSymbols };
}
