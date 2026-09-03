#!/usr/bin/env node
// Float/shares-outstanding dose-response test over a gated widened-scan
// run. Two INDEPENDENT bucketings of the same QUALIFIED symbol-day set —
// shares outstanding (pre-registered thresholds: <5M/5-10M/10-20M/20-50M/
// >50M shares) and EntityPublicFloat (pre-committed BEFORE looking at the
// data's distribution, dollar-denominated since that's what the SEC
// concept actually measures: <$10M/$10-25M/$25-50M/$50-100M/>$100M) — so
// agreement between the two is real evidence, not an artifact of using
// the same number twice.
//
// SEQUENCING (explicit instruction): sizing is computed and printed FIRST,
// completely separately from any expectancy number. A thin bucket is
// reported as thin before any number is attached to it, not alongside one.
//
// Pre-registered success criterion, restated so the code enforces exactly
// what was specified rather than something that merely looks similar:
// monotonic expectancy improvement as the bucketing variable decreases,
// AND the lowest bucket clearly positive at 0.3%/side slippage. One good
// bucket, non-monotonic, or positive-only-at-zero-slippage are each a null
// result, reported as null, not glossed as partial success.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeStaleness } from './lib/edgar.mjs';

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node scripts/bucket-and-compute-expectancy.mjs <run-dir>');
  process.exit(1);
}

const STALENESS_BOUND_PRIMARY = Number(process.argv[3]) || 180;
const STALENESS_BOUNDS_SENSITIVITY = [90, 180, 365];
const SLIPPAGE_PCTS = [0, 0.3, 0.6]; // per side; round-trip cost = 2x this
const STOPS_PCT = [2, 3, 5];
const TARGETS_PCT = [3, 5, 10];
const PRIMARY_CELL = { stop: 3, target: 5 }; // headline cell for the monotonicity check; full grid still computed
const HORIZON = '30m';

// Pre-registered (2026-09-01ish chat): labeled honestly as shares
// outstanding, not float -- no haircut applied.
const SHARES_BUCKETS = [
  { label: '<5M', min: 0, max: 5_000_000 },
  { label: '5-10M', min: 5_000_000, max: 10_000_000 },
  { label: '10-20M', min: 10_000_000, max: 20_000_000 },
  { label: '20-50M', min: 20_000_000, max: 50_000_000 },
  { label: '>50M', min: 50_000_000, max: Infinity },
];
// Committed here, BEFORE inspecting how they split this dataset --
// EntityPublicFloat is dollar-denominated (aggregate market value of
// non-affiliate-held shares), a different unit than shares outstanding,
// so the same numeric thresholds would be a category error. Chosen as
// round dollar bands in the same spirit as the pre-registered share
// buckets, not fit to the data.
const FLOAT_BUCKETS = [
  { label: '<$10M', min: 0, max: 10_000_000 },
  { label: '$10-25M', min: 10_000_000, max: 25_000_000 },
  { label: '$25-50M', min: 25_000_000, max: 50_000_000 },
  { label: '$50-100M', min: 50_000_000, max: 100_000_000 },
  { label: '>$100M', min: 100_000_000, max: Infinity },
];

function bucketOf(val, buckets) {
  if (val == null) return null;
  for (const b of buckets) if (val >= b.min && val < b.max) return b.label;
  return null;
}

const edgar = JSON.parse(readFileSync(path.join(runDir, 'edgar_coverage.json'), 'utf8'));
const gate = JSON.parse(readFileSync(path.join(runDir, 'gate_results.json'), 'utf8'));
const triggers = JSON.parse(readFileSync(path.join(runDir, 'triggers_gated.json'), 'utf8'));

const qualified = gate.results.filter(r => r.tier === 'QUALIFIED').map(r => ({ date: r.date, symbol: r.symbol }));
console.log(`[bucket] ${qualified.length} QUALIFIED symbol-days (the real sample size for this test -- triggers within a symbol-day share one price path, not independent observations)`);

// ── Per-symbol-day: shares-outstanding staleness (reuse edgar_coverage.json's
// own rows[]) + EntityPublicFloat staleness (computed fresh here from the
// SAME saved perSymbol.publicFloatPoints -- no new EDGAR calls) ──
const rowsBySharesKey = new Map(edgar.rows.map(r => [`${r.date}|${r.symbol}`, r]));
const enriched = qualified.map(({ date, symbol }) => {
  const sharesRow = rowsBySharesKey.get(`${date}|${symbol}`);
  const info = edgar.perSymbol[symbol];
  const floatPoints = info ? info.publicFloatPoints : [];
  const { stalenessDays: floatStalenessDays, matchedFiling: floatMatchedFiling } = computeStaleness(floatPoints, date);
  return {
    date, symbol,
    priceValue: sharesRow ? sharesRow.priceValue : null,
    sharesStalenessDays: sharesRow ? sharesRow.stalenessDays : null,
    matchedSharesVal: sharesRow ? sharesRow.matchedSharesVal : null,
    floatStalenessDays,
    matchedFloatVal: floatMatchedFiling ? floatMatchedFiling.val : null,
  };
});

// ── SIZING: staleness sensitivity for BOTH measurements, independently ──
console.log('');
console.log('[bucket] === SIZING (reported before any expectancy number) ===');
for (const bound of STALENESS_BOUNDS_SENSITIVITY) {
  const sharesOk = enriched.filter(r => r.sharesStalenessDays != null && r.sharesStalenessDays <= bound).length;
  const floatOk = enriched.filter(r => r.floatStalenessDays != null && r.floatStalenessDays <= bound).length;
  console.log(`[bucket] staleness <=${bound}d: shares-outstanding usable=${sharesOk}/${qualified.length} | EntityPublicFloat usable=${floatOk}/${qualified.length}`);
}

const sharesSurvived = enriched.filter(r => r.sharesStalenessDays != null && r.sharesStalenessDays <= STALENESS_BOUND_PRIMARY);
const floatSurvived = enriched.filter(r => r.floatStalenessDays != null && r.floatStalenessDays <= STALENESS_BOUND_PRIMARY);
console.log('');
console.log(`[bucket] primary staleness bound: <=${STALENESS_BOUND_PRIMARY}d`);
console.log(`[bucket] shares-outstanding: ${sharesSurvived.length}/${qualified.length} symbol-days survive`);
console.log(`[bucket] EntityPublicFloat: ${floatSurvived.length}/${qualified.length} symbol-days survive`);

function sizeBuckets(survived, buckets, valueKey, label) {
  console.log('');
  console.log(`[bucket] === ${label} bucket sizing (symbol-days, staleness<=${STALENESS_BOUND_PRIMARY}d) ===`);
  const bySymbolDayKey = new Map();
  const counts = {};
  for (const b of buckets) counts[b.label] = { symbolDays: 0, uniqueSymbols: new Set(), triggers: 0 };
  for (const r of survived) {
    const label2 = bucketOf(r[valueKey], buckets);
    if (!label2) continue;
    bySymbolDayKey.set(`${r.date}|${r.symbol}`, label2);
    counts[label2].symbolDays++;
    counts[label2].uniqueSymbols.add(r.symbol);
  }
  for (const t of triggers) {
    const key = `${t.date}|${t.symbol}`;
    const label2 = bySymbolDayKey.get(key);
    if (label2) counts[label2].triggers++;
  }
  for (const b of buckets) {
    const c = counts[b.label];
    const thin = c.symbolDays < 15 ? '  *** THIN — likely too small to support a real test ***' : '';
    console.log(`[bucket]   ${b.label.padEnd(10)} symbol-days=${String(c.symbolDays).padEnd(4)} uniqueSymbols=${String(c.uniqueSymbols.size).padEnd(4)} triggers=${c.triggers}${thin}`);
  }
  return { bySymbolDayKey, counts };
}

const sharesBucketing = sizeBuckets(sharesSurvived, SHARES_BUCKETS, 'matchedSharesVal', 'SHARES OUTSTANDING');
const floatBucketing = sizeBuckets(floatSurvived, FLOAT_BUCKETS, 'matchedFloatVal', 'ENTITY PUBLIC FLOAT');

writeFileSync(path.join(runDir, `bucket_sizing_${STALENESS_BOUND_PRIMARY}d.json`), JSON.stringify({
  qualifiedSymbolDays: qualified.length,
  stalenessSensitivity: STALENESS_BOUNDS_SENSITIVITY.map(bound => ({
    bound,
    sharesUsable: enriched.filter(r => r.sharesStalenessDays != null && r.sharesStalenessDays <= bound).length,
    floatUsable: enriched.filter(r => r.floatStalenessDays != null && r.floatStalenessDays <= bound).length,
  })),
  sharesBuckets: SHARES_BUCKETS.map(b => ({ label: b.label, ...toPlain(sharesBucketing.counts[b.label]) })),
  floatBuckets: FLOAT_BUCKETS.map(b => ({ label: b.label, ...toPlain(floatBucketing.counts[b.label]) })),
  // Full per-symbol-day bucket assignment (date|symbol -> bucket label),
  // so compute-bucket-expectancy.mjs can join against triggers_gated.json
  // directly rather than re-deriving bucket membership a second time.
  sharesBucketAssignment: Object.fromEntries(sharesBucketing.bySymbolDayKey),
  floatBucketAssignment: Object.fromEntries(floatBucketing.bySymbolDayKey),
}, null, 2));

function toPlain(c) {
  return { symbolDays: c.symbolDays, uniqueSymbols: c.uniqueSymbols.size, triggers: c.triggers };
}

console.log('');
console.log(`[bucket] wrote ${path.join(runDir, `bucket_sizing_${STALENESS_BOUND_PRIMARY}d.json`)}`);
console.log('[bucket] SIZING COMPLETE. Run scripts/compute-bucket-expectancy.mjs next to compute expectancy per bucket.');
