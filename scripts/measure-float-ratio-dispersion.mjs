#!/usr/bin/env node
// One-time decision-gate measurement (2026-09-03), NOT part of the shipped
// app: does (EntityPublicFloat-implied float shares) ÷ (shares outstanding)
// cluster tightly enough across real symbols that a calibrated
// shares-outstanding fallback (Option C) would be defensible for the ~35%
// of symbols with no EntityPublicFloat filing at all? Or does it span so
// wide a range that applying any single calibration to an individual name
// would be fabricated precision (take Option E's coverage hit instead)?
//
// Per the corrected derivation (2026-09-03, corrected AGAIN same day after
// a units error was caught): EntityPublicFloat is a DOLLAR figure priced
// as of its OWN reference date (the `end` field — last business day of the
// registrant's most recently completed second fiscal quarter), not today.
// Divide by the historical close on that reference date — but the
// SPLIT-ADJUSTED close (adjustment:'all'), not the raw one. Raw would
// return the share count in that HISTORICAL date's basis; adjusted
// expresses it in TODAY's basis, which is what's actually comparable to
// shares outstanding (confirmed live via DAIC: raw vs. adjusted close on
// the same reference date differed by exactly 25.0x, matching DAIC's known
// ~25:1 reverse split — see core/edgar.js's header for the full trace).
// Uses ONE float point per symbol (the most recent — matching what a live
// gate check would actually use), and matches it to the shares-outstanding
// point closest by date (not necessarily preceding — this is a
// retrospective relationship measurement, not a live no-lookahead
// decision).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runDir = process.argv[2] || 'artifacts/2026-09-03T01-12-37-249Z_symbol-day-scan-lagged';

function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2];
  }
  if (!kv.APCA_API_KEY_ID || !kv.APCA_API_SECRET_KEY) throw new Error('.env.local missing APCA_API_KEY_ID/APCA_API_SECRET_KEY');
  return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

async function main() {
  const { alpacaKeyId, alpacaSecretKey } = readEnvLocal();
  global.state = { settings: { alpacaKey: alpacaKeyId, alpacaSecret: alpacaSecretKey } };
  global.persist = () => {};
  const apiClientSrc = readFileSync(path.join(REPO_ROOT, 'core', 'api-client.js'), 'utf8');
  eval(apiClientSrc + '\nglobal.alpacaGet = alpacaGet; global._coreClient = _coreClient;');

  const coverage = JSON.parse(readFileSync(path.join(REPO_ROOT, runDir, 'edgar_coverage.json'), 'utf8'));
  const perSymbol = coverage.perSymbol;

  // ── Step 1: pick ONE float point per symbol (most recent by `end`) and
  // the shares-outstanding point closest to it by date -- symbols lacking
  // either are excluded (same "measurable or not" honesty the app itself
  // applies, not a synthetic completion). ──
  const chosen = []; // { sym, floatEnd, floatVal, sharesVal, sharesEnd, sharesDayGap }
  for (const [sym, info] of Object.entries(perSymbol)) {
    if (!info.sharesOutstandingPoints.length || !info.publicFloatPoints.length) continue;
    const floatPoint = [...info.publicFloatPoints].sort((a, b) => b.end.localeCompare(a.end))[0];
    let best = null, bestGap = Infinity;
    for (const sp of info.sharesOutstandingPoints) {
      const spDate = sp.end || sp.filed;
      if (!spDate) continue;
      const gap = Math.abs((new Date(spDate) - new Date(floatPoint.end)) / 86400000);
      if (gap < bestGap) { bestGap = gap; best = sp; }
    }
    if (!best) continue;
    chosen.push({ sym, floatEnd: floatPoint.end, floatVal: floatPoint.val, sharesVal: best.val, sharesEnd: best.end || best.filed, sharesDayGap: Math.round(bestGap) });
  }
  console.log(`[ratio-dispersion] symbols with a usable float point + matched shares-outstanding point: ${chosen.length}`);

  // ── Step 2: batch historical daily bars by unique float reference date ──
  const byDate = {};
  for (const c of chosen) (byDate[c.floatEnd] = byDate[c.floatEnd] || []).push(c.sym);
  const uniqueDates = Object.keys(byDate).sort();
  console.log(`[ratio-dispersion] unique float reference dates to look up: ${uniqueDates.length}`);

  const closeBySymDate = {}; // `${sym}|${floatEnd}` -> raw close
  let requests = 0;
  const failedLookups = [];
  for (const endDate of uniqueDates) {
    const symbols = byDate[endDate];
    const startPad = new Date(endDate); startPad.setUTCDate(startPad.getUTCDate() - 10); // pad back for weekends/holidays
    const startStr = startPad.toISOString().slice(0, 10);
    try {
      const params = {
        symbols: symbols.join(','), timeframe: '1Day',
        start: `${startStr}T00:00:00Z`, end: `${endDate}T23:59:59Z`,
        limit: 10000, feed: 'sip', adjustment: 'all', // ADJUSTED -- lands the derived share count in TODAY's basis, matching shares outstanding (see header)
      };
      const data = await global._coreClient.alpacaGet('/stocks/bars', params);
      requests++;
      for (const sym of symbols) {
        const bars = (data.bars && data.bars[sym]) || [];
        const onOrBefore = bars.filter(b => b.t.slice(0, 10) <= endDate).sort((a, b) => b.t.localeCompare(a.t));
        if (onOrBefore.length) closeBySymDate[`${sym}|${endDate}`] = onOrBefore[0].c;
        else failedLookups.push({ sym, endDate, reason: 'no bar on or before reference date within 10-day pad' });
      }
    } catch (e) {
      console.warn(`[ratio-dispersion] batch failed for date ${endDate} (${symbols.length} symbols): ${e.message}`);
      for (const sym of symbols) failedLookups.push({ sym, endDate, reason: e.message });
    }
    await new Promise(r => setTimeout(r, 120));
  }
  console.log(`[ratio-dispersion] price lookups: ${requests} requests, ${Object.keys(closeBySymDate).length} resolved, ${failedLookups.length} failed`);
  if (failedLookups.length) console.log('[ratio-dispersion] failed lookups:', JSON.stringify(failedLookups.slice(0, 20)));

  // ── Step 3: compute the ratio for every symbol with a resolved price ──
  const rows = [];
  for (const c of chosen) {
    const close = closeBySymDate[`${c.sym}|${c.floatEnd}`];
    if (close == null || close <= 0) continue;
    const impliedFloatShares = c.floatVal / close;
    const ratio = impliedFloatShares / c.sharesVal;
    rows.push({ sym: c.sym, floatEnd: c.floatEnd, floatVal: c.floatVal, close, impliedFloatShares, sharesVal: c.sharesVal, sharesDayGap: c.sharesDayGap, ratio });
  }
  console.log(`[ratio-dispersion] rows with a full computed ratio: ${rows.length} of ${chosen.length} chosen`);

  const ratios = rows.map(r => r.ratio);
  console.log();
  console.log('[ratio-dispersion] === RESULT: (implied float shares) / (shares outstanding) ===');
  console.log(`n=${ratios.length}`);
  console.log(`median: ${median(ratios).toFixed(4)}`);
  console.log(`p10: ${percentile(ratios, 0.10).toFixed(4)}`);
  console.log(`p90: ${percentile(ratios, 0.90).toFixed(4)}`);
  console.log(`min: ${Math.min(...ratios).toFixed(4)}`);
  console.log(`max: ${Math.max(...ratios).toFixed(4)}`);
  console.log(`mean: ${(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(4)}`);
  const gt1 = rows.filter(r => r.ratio > 1).length;
  console.log(`ratio > 1.0 (implied float exceeds total shares outstanding -- a sign of a bad match or a data anomaly): ${gt1}/${rows.length}`);
  const gap0to20 = rows.filter(r => Math.abs(r.sharesDayGap) <= 20).length;
  console.log(`rows where the matched shares-outstanding point is within 20 days of the float reference date: ${gap0to20}/${rows.length}`);

  // Distribution buckets, quick visual read
  const buckets = { '0.0-0.2': 0, '0.2-0.4': 0, '0.4-0.6': 0, '0.6-0.8': 0, '0.8-1.0': 0, '>1.0': 0 };
  for (const r of ratios) {
    if (r > 1.0) buckets['>1.0']++;
    else if (r >= 0.8) buckets['0.8-1.0']++;
    else if (r >= 0.6) buckets['0.6-0.8']++;
    else if (r >= 0.4) buckets['0.4-0.6']++;
    else if (r >= 0.2) buckets['0.2-0.4']++;
    else buckets['0.0-0.2']++;
  }
  console.log('bucket distribution:', JSON.stringify(buckets));

  const outPath = path.join(REPO_ROOT, runDir, 'float_ratio_dispersion.json');
  const fs = await import('node:fs');
  fs.writeFileSync(outPath, JSON.stringify({ rows, summary: { n: ratios.length, median: median(ratios), p10: percentile(ratios, 0.10), p90: percentile(ratios, 0.90), min: Math.min(...ratios), max: Math.max(...ratios), buckets } }, null, 2));
  console.log(`[ratio-dispersion] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[ratio-dispersion] FAILED —', err.message, err.stack);
  process.exit(1);
});
