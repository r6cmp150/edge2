// Shared SEC EDGAR helpers (CIK lookup, shares-outstanding/float XBRL pull,
// staleness calc) — extracted so the topN/window probe and the eventual
// full bucketing pass over the widened scan share one implementation
// instead of a second hand-copied duplicate of check-edgar-coverage.mjs's
// logic. No key, no auth; SEC's fair-use policy just asks for a
// descriptive User-Agent and a modest pace, both applied here.
const UA = 'EDGE2-Warrior-Research rtcmp150@gmail.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function secGet(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (res.status === 404) return null; // no data for this CIK/concept -- expected, not an error
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function fetchCikMap() {
  const tickersData = await secGet('https://www.sec.gov/files/company_tickers.json');
  const cikBySymbol = {};
  for (const entry of Object.values(tickersData)) cikBySymbol[entry.ticker] = entry.cik_str;
  return cikBySymbol;
}

// Pulls shares-outstanding/float/submissions for one symbol's CIK. Paces
// itself with a trailing sleep (~8/s across a loop of callers), same as
// check-edgar-coverage.mjs.
export async function fetchEdgarDataForSymbol(cik) {
  const cikPadded = String(cik).padStart(10, '0');
  const [sharesData, floatData, submissions] = await Promise.all([
    secGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/dei/EntityCommonStockSharesOutstanding.json`),
    secGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/dei/EntityPublicFloat.json`),
    secGet(`https://data.sec.gov/submissions/CIK${cikPadded}.json`),
  ]);
  await sleep(120); // ~8/s, comfortably under SEC's ~10/s guidance
  // Array.isArray guard (2026-09-04, found live building the full float
  // table): SEC's companyconcept endpoint sometimes returns an EMPTY
  // OBJECT for "no data" (e.g. `units: { shares: {} }`, confirmed live for
  // BIIB and ~25 others) instead of omitting the key or using an empty
  // array. `{} || []` stays `{}` (truthy), so a bare `.map()` on it throws
  // -- didn't corrupt this session's own measurements (none of the 209-340
  // symbols in that population happened to trigger it), but a real latent
  // defect worth closing here too, not just in core/edgar.js.
  const sharesRaw = sharesData?.units?.shares;
  const floatRaw = floatData?.units?.USD;
  const sharesPoints = Array.isArray(sharesRaw) ? sharesRaw : [];
  const floatPoints = Array.isArray(floatRaw) ? floatRaw : [];
  const recentForms = submissions?.filings?.recent?.form || [];
  const recentDates = submissions?.filings?.recent?.filingDate || [];
  const is20F = recentForms.includes('20-F') || recentForms.includes('20-F/A');
  return {
    cik,
    sharesOutstandingPoints: sharesPoints.map(p => ({ end: p.end, filed: p.filed, val: p.val, form: p.form })),
    publicFloatPoints: floatPoints.map(p => ({ end: p.end, filed: p.filed, val: p.val, form: p.form })),
    filerType: is20F ? 'FPI (20-F)' : 'domestic (10-K/10-Q)',
    recentFormsSample: [...new Set(recentForms)].slice(0, 8),
    earliestRecentFilingDate: recentDates.length ? [...recentDates].sort()[0] : null,
    hasOlderFilingsBeyondRecent: Array.isArray(submissions?.filings?.files) && submissions.filings.files.length > 0,
    requestCount: 3,
  };
}

// Nearest PRECEDING filing's staleness (days) relative to a trade date,
// against a symbol's sharesOutstandingPoints (or publicFloatPoints — same
// {filed, val} shape). Returns { stalenessDays, matchedFiling } — both
// null if no filing precedes the trade date.
export function computeStaleness(points, tradeDate) {
  const preceding = points.filter(p => p.filed && p.filed < tradeDate).sort((a, b) => b.filed.localeCompare(a.filed));
  if (!preceding.length) return { stalenessDays: null, matchedFiling: null };
  const matchedFiling = preceding[0];
  const stalenessDays = Math.round((new Date(tradeDate) - new Date(matchedFiling.filed)) / 86400000);
  return { stalenessDays, matchedFiling };
}
