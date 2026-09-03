#!/usr/bin/env node
// Coverage/staleness check for SEC EDGAR's XBRL data as a shares-outstanding
// source for the 79 gate-QUALIFIED symbol-days — REPORT ONLY, no float
// pipeline built yet. Verifies live against data.sec.gov (2026-09-02):
// this is not a documentation read, every number below comes from a real
// response. No key, no auth -- SEC asks only for a descriptive
// User-Agent and a self-imposed ~10 req/s pace, both trivial and applied
// here.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node scripts/check-edgar-coverage.mjs <path-to-run-artifact-dir>');
  process.exit(1);
}

const UA = 'EDGE2-Warrior-Research rtcmp150@gmail.com'; // SEC's fair-use policy asks for a descriptive, identifying User-Agent -- not a secret, no redaction needed
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function secGet(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (res.status === 404) return null; // no data for this CIK/concept -- a real, expected outcome, not an error
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const gateResults = JSON.parse(readFileSync(path.join(runDir, 'gate_results.json'), 'utf8'));
  const qualified = gateResults.results.filter(r => r.tier === 'QUALIFIED');
  const uniqueSymbols = [...new Set(qualified.map(r => r.symbol))];
  console.log(`[edgar-coverage] ${qualified.length} QUALIFIED symbol-days, ${uniqueSymbols.length} unique symbols`);

  // ── Ticker -> CIK (one static file, no rate-limit concern) ──
  const tickersData = await secGet('https://www.sec.gov/files/company_tickers.json');
  const cikBySymbol = {};
  for (const entry of Object.values(tickersData)) cikBySymbol[entry.ticker] = entry.cik_str;
  const mapped = uniqueSymbols.filter(s => cikBySymbol[s] != null);
  const unmapped = uniqueSymbols.filter(s => cikBySymbol[s] == null);
  console.log(`[edgar-coverage] CIK mapping: ${mapped.length}/${uniqueSymbols.length} mapped. Unmapped: ${unmapped.join(', ') || '(none)'}`);

  // ── Per-symbol: shares outstanding, public float, filer type (10-Q/10-K vs 20-F) ──
  const perSymbol = {};
  let reqCount = 1; // the tickers file
  for (const sym of mapped) {
    const cikPadded = String(cikBySymbol[sym]).padStart(10, '0');
    const [sharesData, floatData, submissions] = await Promise.all([
      secGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/dei/EntityCommonStockSharesOutstanding.json`),
      secGet(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/dei/EntityPublicFloat.json`),
      secGet(`https://data.sec.gov/submissions/CIK${cikPadded}.json`),
    ]);
    reqCount += 3;
    const sharesPoints = sharesData?.units?.shares || [];
    const floatPoints = floatData?.units?.USD || [];
    const recentForms = submissions?.filings?.recent?.form || [];
    const recentDates = submissions?.filings?.recent?.filingDate || [];
    const is20F = recentForms.includes('20-F') || recentForms.includes('20-F/A');
    // Listing-age proxy (2026-09-02): earliest filingDate within
    // filings.recent -- SEC paginates OLDER history into filings.files
    // (a list of archived JSON pages) once "recent" would otherwise get
    // too large, so a non-empty filings.files means real history exists
    // beyond what's captured here and this symbol is NOT a recent
    // listing, regardless of what the earliest recent-window date says.
    // Only trusted as "genuinely recent" when filings.files is empty AND
    // the earliest recent-window date is itself recent.
    const hasOlderFilingsBeyondRecent = Array.isArray(submissions?.filings?.files) && submissions.filings.files.length > 0;
    const earliestRecentFilingDate = recentDates.length ? [...recentDates].sort()[0] : null;
    perSymbol[sym] = {
      cik: cikBySymbol[sym],
      sharesOutstandingPoints: sharesPoints.map(p => ({ end: p.end, filed: p.filed, val: p.val, form: p.form })),
      publicFloatPoints: floatPoints.map(p => ({ end: p.end, filed: p.filed, val: p.val, form: p.form })),
      filerType: is20F ? 'FPI (20-F)' : 'domestic (10-K/10-Q)',
      recentFormsSample: [...new Set(recentForms)].slice(0, 8),
      earliestRecentFilingDate,
      hasOlderFilingsBeyondRecent,
    };
    await sleep(120); // ~8/s, comfortably under SEC's ~10/s guidance
  }
  console.log(`[edgar-coverage] SEC requests made: ${reqCount}`);

  const withShares = mapped.filter(s => perSymbol[s].sharesOutstandingPoints.length > 0);
  const withFloat = mapped.filter(s => perSymbol[s].publicFloatPoints.length > 0);
  const fpiSymbols = mapped.filter(s => perSymbol[s].filerType.startsWith('FPI'));
  console.log(`[edgar-coverage] symbols with >=1 shares-outstanding data point: ${withShares.length}/${uniqueSymbols.length}`);
  console.log(`[edgar-coverage] symbols with >=1 EntityPublicFloat data point: ${withFloat.length}/${uniqueSymbols.length}`);
  console.log(`[edgar-coverage] FPI (20-F) symbols: ${fpiSymbols.length} -- ${fpiSymbols.join(', ') || '(none)'}`);

  // ── Per symbol-day: staleness of the nearest PRECEDING shares-outstanding filing ──
  const rows = [];
  for (const r of qualified) {
    const sym = r.symbol;
    const info = perSymbol[sym];
    const tradeDate = r.date;
    let staleness = null, matchedFiling = null;
    if (info && info.sharesOutstandingPoints.length) {
      const preceding = info.sharesOutstandingPoints
        .filter(p => p.filed && p.filed < tradeDate)
        .sort((a, b) => b.filed.localeCompare(a.filed));
      if (preceding.length) {
        matchedFiling = preceding[0];
        staleness = Math.round((new Date(tradeDate) - new Date(matchedFiling.filed)) / 86400000);
      }
    }
    // Listing-age proxy relative to the TRADE date, not today -- days
    // from the earliest known filing to when this symbol-day actually
    // traded, so a company that later built up history doesn't look
    // "old" for a trade that happened back when it was new.
    let daysSinceEarliestFiling = null;
    if (info && info.earliestRecentFilingDate) {
      daysSinceEarliestFiling = Math.round((new Date(tradeDate) - new Date(info.earliestRecentFilingDate)) / 86400000);
    }
    rows.push({
      date: tradeDate, symbol: sym,
      priceValue: r.pillars.price.value,
      relVolValue: r.pillars.rvol.value,
      filerType: info ? info.filerType : 'unmapped',
      stalenessDays: staleness,
      matchedFilingDate: matchedFiling ? matchedFiling.filed : null,
      matchedSharesVal: matchedFiling ? matchedFiling.val : null,
      earliestRecentFilingDate: info ? info.earliestRecentFilingDate : null,
      hasOlderFilingsBeyondRecent: info ? info.hasOlderFilingsBeyondRecent : null,
      daysSinceEarliestFiling,
    });
  }

  // ── Listing-age comparison: the 10 with no usable preceding filing vs the 69 that have one ──
  const missing = rows.filter(r => r.stalenessDays == null);
  const covered = rows.filter(r => r.stalenessDays != null);
  function ageSummary(label, group) {
    const withAge = group.filter(r => r.daysSinceEarliestFiling != null);
    const ages = withAge.map(r => r.daysSinceEarliestFiling);
    const olderHistoryCount = group.filter(r => r.hasOlderFilingsBeyondRecent === true).length;
    const noOlderHistoryCount = group.filter(r => r.hasOlderFilingsBeyondRecent === false).length;
    console.log(`[edgar-coverage] listing-age (${label}): n=${group.length}, with-age-data=${withAge.length}, median days-since-earliest-filing=${medianOfArr(ages)}, min=${ages.length ? Math.min(...ages) : null}, max=${ages.length ? Math.max(...ages) : null}`);
    console.log(`[edgar-coverage] listing-age (${label}): has older filings beyond 'recent' window (NOT a recent listing): ${olderHistoryCount}/${group.length} | no older filings found (consistent with recent listing): ${noOlderHistoryCount}/${group.length}`);
  }
  function medianOfArr(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }
  console.log();
  console.log(`[edgar-coverage] === LISTING AGE: missing-10 vs covered-69 ===`);
  ageSummary('missing (no usable preceding filing)', missing);
  ageSummary('covered (has a usable preceding filing)', covered);
  console.log('[edgar-coverage] missing rows detail:', JSON.stringify(missing.map(r => ({ symbol: r.symbol, date: r.date, filerType: r.filerType, daysSinceEarliestFiling: r.daysSinceEarliestFiling, hasOlderFilingsBeyondRecent: r.hasOlderFilingsBeyondRecent, earliestRecentFilingDate: r.earliestRecentFilingDate })), null, 2));
  console.log();

  const withStaleness = rows.filter(r => r.stalenessDays != null);
  console.log(`[edgar-coverage] symbol-days with a usable preceding filing: ${withStaleness.length}/${rows.length}`);

  function medianOf(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }
  function summarizeStaleness(label, group) {
    const vals = group.map(r => r.stalenessDays).filter(v => v != null);
    console.log(`[edgar-coverage] staleness (${label}): n=${vals.length}, median=${medianOf(vals)}, max=${vals.length ? Math.max(...vals) : null}, min=${vals.length ? Math.min(...vals) : null}`);
  }
  summarizeStaleness('all', withStaleness);
  summarizeStaleness('domestic (10-K/10-Q)', withStaleness.filter(r => r.filerType.startsWith('domestic')));
  summarizeStaleness('FPI (20-F)', withStaleness.filter(r => r.filerType.startsWith('FPI')));

  // Staleness-bound survival, uniform across filer type (2026-09-02
  // decision: exclude on staleness, not filer type -- a domestic filer
  // at 286 days stale is exactly as unusable as an FPI at 286 days).
  // Needed both to report the sizing signal for the widened run and as
  // the basis for the eventual 90/180/365-day sensitivity check.
  for (const bound of [90, 180, 365]) {
    const survive = withStaleness.filter(r => r.stalenessDays <= bound);
    console.log(`[edgar-coverage] staleness bound <=${bound}d: ${survive.length}/${rows.length} of ALL qualified symbol-days survive (${survive.length}/${withStaleness.length} of the ones with any filing data at all)`);
  }

  // ── Coverage cut by price bucket and relVol bucket ──
  function priceBucket(p) { if (p == null) return 'n/a'; if (p < 5) return '$1-5'; if (p < 10) return '$5-10'; if (p < 15) return '$10-15'; return '$15-20'; }
  function volBucket(v) { if (v == null) return 'n/a'; if (v < 5) return '<5x'; if (v < 10) return '5-10x'; if (v < 20) return '10-20x'; return '>=20x'; }
  const byPriceBucket = {};
  const byVolBucket = {};
  for (const r of rows) {
    const pb = priceBucket(r.priceValue);
    const vb = volBucket(r.relVolValue);
    (byPriceBucket[pb] = byPriceBucket[pb] || { total: 0, covered: 0 }).total++;
    if (r.stalenessDays != null) byPriceBucket[pb].covered++;
    (byVolBucket[vb] = byVolBucket[vb] || { total: 0, covered: 0 }).total++;
    if (r.stalenessDays != null) byVolBucket[vb].covered++;
  }
  console.log('[edgar-coverage] coverage by price bucket:', JSON.stringify(byPriceBucket));
  console.log('[edgar-coverage] coverage by relVol bucket:', JSON.stringify(byVolBucket));

  const outPath = path.join(runDir, 'edgar_coverage.json');
  const fs = await import('node:fs');
  fs.writeFileSync(outPath, JSON.stringify({ perSymbol, rows, summary: {
    uniqueSymbols: uniqueSymbols.length, mapped: mapped.length, unmapped,
    withShares: withShares.length, withFloat: withFloat.length, fpiSymbols,
    withStaleness: withStaleness.length, byPriceBucket, byVolBucket,
  } }, null, 2));
  console.log(`[edgar-coverage] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[edgar-coverage] FAILED —', err.message, err.stack);
  process.exit(1);
});
