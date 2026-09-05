// core/float-table.js — client-side static float table lookup (2026-09-04).
// Replaces core/edgar.js's live client-side fetch path, which a real boot
// check proved CAN NEVER WORK from a browser: data.sec.gov/www.sec.gov
// send no Access-Control-Allow-Origin on a real GET, and flatly 403 any
// CORS preflight OPTIONS request (Akamai WAF). Every EDGAR verification
// this session that looked clean ran from Node, where CORS doesn't apply
// — the browser path had never actually been exercised until that check.
//
// The float table is built server-side, WEEKLY, by
// scripts/build-float-table.mjs (GitHub Action,
// .github/workflows/build-float-table.yml) using core/edgar.js's SAME
// derivation + shares-outstanding invariant guard, then committed to the
// repo as data/float-table.json. This file does one same-origin fetch of
// that file and answers lookups from it — no CORS, no forbidden headers,
// no runtime rate limit, no new infrastructure, same pattern as
// data/movers-snapshots/log.jsonl.
//
// Same exported function name and return shape as core/edgar.js's old
// getFloatDataForSymbols (Node-only now, see its own header) so gate.js
// needs no changes to its call site — only one or the other of these two
// files is ever loaded into a given global scope (index.html loads this
// one; scripts/build-float-table.mjs loads core/edgar.js directly), so
// there's no name collision.
//
// THREE STATES, kept distinct (2026-09-04 decision, do not collapse):
//   - in the table with a usable value -> pass/fail (gate.js's existing
//     threshold logic, unchanged)
//   - in the table but discarded by the guard, or no EntityPublicFloat
//     filing on record -> not-checked, by-design, non-blocking — reason
//     carried from the table entry
//   - NOT in the table at all -> its own not-checked reason. A new
//     listing or a build-coverage gap (a symbol the weekly job failed to
//     resolve), NOT the same claim as "checked, confirmed no filing." This
//     is the state that tells us the build is missing coverage — collapsing
//     it into "no filing" would hide that signal.
const FLOAT_TABLE_URL = './data/float-table.json';

// Staleness bound -- ADDED then DROPPED the same day (2026-09-04).
// Added: a real boot check found BIAF and GRI both PASSING the <10M gate
// on implied-float values 174,868 and 41,528 shares, both derived from
// filings 431 days old and both wildly inconsistent with real trading
// volume. The backtest's own primary analysis bounds staleness at 180
// days; the live pillar had none -- a hard 180-day cutoff was added here.
// Dropped: re-measuring the backtest population under that bound
// collapsed usable coverage from 60.9% to 1.2% (4/340) -- EntityPublicFloat
// is annual-only and 74% of filings cluster on one reference date
// (2025-06-30), so a 180-day bound only has real coverage roughly half the
// year. That number was the symptom of the WRONG FIX, not the true cost of
// staleness: BIAF and GRI weren't wrong because they were old, they were
// wrong because the derivation never accounted for share issuance since
// the reference date. core/edgar.js's dilution correction fixes that
// directly (EDGAR's own dated shares-outstanding history rescales the
// implied float for issuance since reference, using the same split factor
// the price adjustment already computes) -- confirmed BIAF's corrected
// value now correctly fails the gate and GRI's now genuinely passes a live
// volume-consistency check (~0.43x). Re-measured post-correction: even
// with correction, 99.7% of usable entries are STILL beyond 180 days by
// reference date (correction rescales the share count, not the filing
// date) -- but the corrected volume-ratio distribution is now tight
// (p99=0.50x, only 0.28% exceed 10x, down from p99=11.3x/1.1% pre-
// correction), meaning the bound would still be discarding legitimately
// corrected, volume-verified values for an error that's now measured and
// fixed directly rather than merely dated around. The volume-consistency
// backstop (engines/warrior/gate.js) is the check that actually replaces
// what this bound was a proxy for -- it's age-blind and tests the
// CURRENT value's plausibility directly, catching what the correction
// itself still misses (see its own header for a live example, ADGM).
// stalenessDays is still computed and shown on every card (2026-09-04,
// explicit requirement: "keep displaying age prominently") -- it's no
// longer a hard gate, just honest provenance.

let _floatTableCache = null; // { table } -- one fetch per page load, not per scan
let _floatTableFetchPromise = null;

async function _loadFloatTable() {
  if (_floatTableCache) return _floatTableCache.table;
  if (_floatTableFetchPromise) return _floatTableFetchPromise;
  _floatTableFetchPromise = (async () => {
    const res = await fetch(FLOAT_TABLE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const table = await res.json();
    _floatTableCache = { table };
    return table;
  })();
  try {
    return await _floatTableFetchPromise;
  } finally {
    _floatTableFetchPromise = null;
  }
}

// Returns { floatBySymbol, requests, failedSymbols, unmappedSymbols,
// tableBuiltAt, tableStalenessDays }. requests is always 0 or 1 (one
// same-origin fetch, cached for the page's lifetime) -- kept only for
// interface compatibility with the old per-request EDGAR call-count
// concept, not a meaningful budget here.
async function getFloatDataForSymbols(symbols) {
  let table;
  try {
    table = await _loadFloatTable();
  } catch (e) {
    console.warn(`core/float-table.js: float table fetch failed: ${e.message}`);
    // A real fetch failure -- not confirmed absent, could not be checked
    // this scan. Every requested symbol reads fetch-failed/BLOCKED, same
    // honesty rule as the old EDGAR path had for a request failure.
    return { floatBySymbol: {}, requests: 1, failedSymbols: [...symbols], unmappedSymbols: [], tableBuiltAt: null, tableStalenessDays: null };
  }

  const today = ptDateStr(getPT());
  // Bug found live in boot check (2026-09-04): table.builtAt is a FULL ISO
  // instant (e.g. "2026-09-04T16:31:47.496Z"), not a date-only string like
  // `today`. `new Date(dateOnlyString)` parses as UTC MIDNIGHT (ECMAScript
  // spec) — comparing that against a real instant with a real time-of-day
  // component goes negative whenever the build ran later in the UTC day
  // than midnight, which is every normal build (this one: built 9:31 AM
  // PT = 16:31 UTC, well after UTC midnight, on the SAME PT calendar day
  // as "today" -- "(today UTC-midnight) - (builtAt real instant)" is
  // negative by construction, not just near a boundary). Fixed by never
  // comparing a date-only pseudo-instant against a real one: convert
  // builtAt to ITS OWN PT calendar date first (getPT accepts an arbitrary
  // date, not just "now" -- see core/clock.js), THEN diff two date-only
  // strings against each other, the same safe pattern this file already
  // uses correctly for referenceDate below.
  const builtAtPtDateStr = table.builtAt ? ptDateStr(getPT(new Date(table.builtAt))) : null;
  const tableStalenessDays = builtAtPtDateStr ? Math.round((new Date(today) - new Date(builtAtPtDateStr)) / 86400000) : null;
  const builtAtDateStr = builtAtPtDateStr || 'unknown'; // display-only fallback, used in the reason strings below

  const floatBySymbol = {};
  for (const sym of symbols) {
    const entry = table.bySymbol ? table.bySymbol[sym] : undefined;
    if (!entry) {
      floatBySymbol[sym] = { impliedFloatShares: null, invalidReason: `not in this week's float table (built ${builtAtDateStr}) — new listing or a build-coverage gap, not confirmed absent` };
      continue;
    }
    if (entry.status === 'value') {
      // No staleness gate here (dropped 2026-09-04, see the header above)
      // -- stalenessDays is still computed and shown on every card, just
      // not a hard bound. dilutionCorrected: carried through so the card
      // can disclose whether this value was rescaled for share issuance
      // since the filing's reference date, or is the raw as-filed
      // derivation (no shares-outstanding history was available to
      // correct with -- see core/edgar.js's header). Either way the
      // residual-bias caveat applies (it assumes the free-trading fraction
      // held constant) -- see engines/warrior/index.js's card renderer.
      const stalenessDays = Math.round((new Date(today) - new Date(entry.referenceDate)) / 86400000);
      floatBySymbol[sym] = { impliedFloatShares: entry.impliedFloatShares, referenceDate: entry.referenceDate, stalenessDays, dilutionCorrected: !!entry.dilutionCorrected };
    } else if (entry.status === 'discarded') {
      floatBySymbol[sym] = { impliedFloatShares: null, invalidReason: entry.reason || 'implied float discarded by the shares-outstanding sanity guard' };
    } else if (entry.status === 'unmapped') {
      floatBySymbol[sym] = { impliedFloatShares: null, invalidReason: `no SEC CIK mapping for this symbol (checked ${builtAtDateStr})` };
    } else if (entry.status === 'no-price-data') {
      // PERMANENT for this filing (2026-09-04) -- a retry never resolves
      // it, same non-blocking treatment as no-filing/unmapped, kept as its
      // own status (not folded into no-filing) so its own count stays
      // individually diagnostic — see core/edgar.js/scripts/
      // build-float-table.mjs's headers.
      floatBySymbol[sym] = { impliedFloatShares: null, invalidReason: entry.reason || 'no historical price data available near the float reference date' };
    } else if (entry.status === 'invalid-reference-date') {
      floatBySymbol[sym] = { impliedFloatShares: null, invalidReason: entry.reason || 'float reference date is invalid (after today)' };
    } else {
      // 'no-filing'
      floatBySymbol[sym] = { impliedFloatShares: null, invalidReason: `no EntityPublicFloat filing on record for this symbol (checked ${builtAtDateStr})` };
    }
  }
  return { floatBySymbol, requests: 0, failedSymbols: [], unmappedSymbols: [], tableBuiltAt: table.builtAt, tableStalenessDays };
}
