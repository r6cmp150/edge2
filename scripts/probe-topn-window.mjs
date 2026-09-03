#!/usr/bin/env node
// topN-vs-window-length probe (2026-09-01 chat): reconstruction + 4-pillar
// gate ONLY at topN=15 over the same 63-day range already scanned
// (2026-06-01..2026-08-28), lagged selection -- no replay. Answers three
// things before committing to a widened run:
//   (a) the REAL topN 10->15 scaling factor on raw symbol-days
//   (b) the gate-pass rate for rank 11-15 candidates SPECIFICALLY, kept
//       separate from rank 1-10 -- this is the one that decides the branch
//   (c) the staleness-survival rate (SEC EDGAR, 180d bound) on the
//       enlarged (topN=15) QUALIFIED set
// then applies the pre-registered decision rule: if rank11-15's gate-pass
// rate is >= 2/3 of rank1-10's ("not materially lower"), branch to
// topN=15 @ 252 trading days; otherwise branch to topN=10 @ ~378 days
// (extend the window instead of diluting candidate quality).
//
// Efficiency note: bars for the full eligible universe are fetched ONCE
// and reused for both the topN=10 and topN=15 _rankTopMovers calls (and
// for the unlagged day-D-own-metrics pass the gate needs) -- ranking is
// pure computation over already-fetched bars, so this stays at the same
// ~64 request order of magnitude as a single reconstruction, not double.
// Rank 1-10's gate-pass rate is NOT recomputed here -- it's already a
// real, measured number from the existing lagged run's gate_results.json
// (79/1054 = 7.5%), reused directly rather than re-spending news requests
// on symbol-days already gated once this session.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateSymbolDay, fetchNewsByDateSymbol } from './lib/gate-classifier.mjs';
import { fetchCikMap, fetchEdgarDataForSymbol, computeStaleness } from './lib/edgar.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const START_DATE = '2026-06-01', END_DATE = '2026-08-28'; // same 63-day range as the existing lagged run, for a like-for-like diff
const EXISTING_RUN_DIR = process.argv[2] || 'artifacts/2026-09-02T03-35-52-344Z_symbol-day-scan-lagged';

function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2];
  }
  return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
}

const key = (r) => `${r.date}|${r.symbol}`;

async function main() {
  const { alpacaKeyId, alpacaSecretKey } = readEnvLocal();
  global.state = { settings: { alpacaKey: alpacaKeyId, alpacaSecret: alpacaSecretKey } };
  global.persist = () => {};
  // core/api-client.js's real queue (2026-09-02 fix), not a hand-rolled
  // fetch — see run-symbol-day-scan.mjs's header comment for why: the
  // previous bare fetch here had no 429 retry/backoff or concurrency
  // limit, and Alpaca's default bar sort (ascending) means a mid-
  // pagination 429 silently truncates a chunk's MOST RECENT months while
  // keeping its oldest ones.
  const apiClientSrc = readFileSync(path.join(REPO_ROOT, 'core', 'api-client.js'), 'utf8');
  eval(apiClientSrc + '\nglobal.chunk = chunk; global.alpacaGet = alpacaGet; global._coreClient = _coreClient; global.assertPageNotSuspiciouslyFull = assertPageNotSuspiciouslyFull; global.createApiClient = createApiClient;');

  const clockSrc = readFileSync(path.join(REPO_ROOT, 'core', 'clock.js'), 'utf8');
  eval(clockSrc + '\nglobal.getPT = getPT; global.ptWallClockToInstant = ptWallClockToInstant;');
  const universeSrc = readFileSync(path.join(REPO_ROOT, 'core', 'universe.js'), 'utf8');
  eval(universeSrc + '\nglobal._getAssetIndex = _getAssetIndex; global._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._rankTopMovers = _rankTopMovers; global._shiftDateStr = _shiftDateStr;');

  // ── Fetch bars ONCE for the full eligible universe (60-day pad, same as reconstructTopMoversUniverse) ──
  const t0 = Date.now();
  const fetchStartDateStr = global._shiftDateStr(START_DATE, -60);
  const assetIndex = await global._getAssetIndex(global._coreClient);
  const eligibleSymbols = assetIndex.filter(a => a.isEligibleInstrument).map(a => a.symbol);
  const { barsBySymbol, requests: barRequests } = await global._fetchHistoricalDailyBars(eligibleSymbols, fetchStartDateStr, END_DATE, global._coreClient);
  console.log(`[probe] universe bars: ${barRequests} requests, ${Math.round((Date.now() - t0) / 1000)}s, ${eligibleSymbols.length} eligible symbols, ${Object.keys(barsBySymbol).length} with bars`);

  // ── Rank at topN=10 and topN=15, both lagged (the selection rule already proven to remove lookahead) ──
  const rank10Rows = global._rankTopMovers(barsBySymbol, START_DATE, END_DATE, 10, { lagSelectionByOneDay: true });
  const rank15Rows = global._rankTopMovers(barsBySymbol, START_DATE, END_DATE, 15, { lagSelectionByOneDay: true });
  const rank10Keys = new Set(rank10Rows.map(key));
  const rank11to15Rows = rank15Rows.filter(r => !rank10Keys.has(key(r)));

  const scalingFactor = rank15Rows.length / rank10Rows.length;
  console.log(`[probe] (a) topN scaling: topN=10 -> ${rank10Rows.length} symbol-days, topN=15 -> ${rank15Rows.length} symbol-days, factor=${scalingFactor.toFixed(3)}`);
  console.log(`[probe] rank 11-15-only symbol-days: ${rank11to15Rows.length} (topN15 - topN10 = ${rank15Rows.length - rank10Rows.length}, sanity check ${rank11to15Rows.length === rank15Rows.length - rank10Rows.length ? 'PASSES' : 'FAILS — investigate'})`);

  const existingUniverse = JSON.parse(readFileSync(path.join(REPO_ROOT, EXISTING_RUN_DIR, 'universe.json'), 'utf8'));
  const existingSymbolDayCount = existingUniverse.symbolDays.length;
  console.log(`[probe] cross-check: freshly-recomputed topN=10 gives ${rank10Rows.length} symbol-days vs existing artifact's ${existingSymbolDayCount} (${rank10Rows.length === existingSymbolDayCount ? 'MATCH — same deterministic selection' : 'MISMATCH — investigate before trusting reuse of gate_results.json below'})`);

  // ── Day-D's-own metrics (unlagged), needed for gating — separate from the LAGGED selection rank above ──
  const ownMetricRows = global._rankTopMovers(barsBySymbol, START_DATE, END_DATE, 999999, { lagSelectionByOneDay: false });
  const ownMetricsByKey = new Map();
  for (const row of ownMetricRows) ownMetricsByKey.set(key(row), row);

  // ── (b) Gate rank 11-15 ONLY (rank 1-10's rate is reused from the existing gate_results.json, not re-spent) ──
  const t1 = Date.now();
  const dates11to15 = [...new Set(rank11to15Rows.map(r => r.date))].sort();
  const { newsByDateSymbol, newsRequests } = await fetchNewsByDateSymbol(
    dates11to15,
    (date) => rank11to15Rows.filter(r => r.date === date).map(r => r.symbol)
  );
  console.log(`[probe] rank 11-15 news: ${newsRequests} requests, ${Math.round((Date.now() - t1) / 1000)}s`);

  const rank11to15Gated = rank11to15Rows.map(r => {
    const own = ownMetricsByKey.get(key(r));
    const headline = newsByDateSymbol.get(key(r));
    const { pillars, tier } = gateSymbolDay({ own, headline });
    return { date: r.date, symbol: r.symbol, tier, pillars };
  });
  const rank11to15Qualified = rank11to15Gated.filter(r => r.tier === 'QUALIFIED');
  const rank11to15Rate = rank11to15Qualified.length / rank11to15Gated.length;

  const existingGate = JSON.parse(readFileSync(path.join(REPO_ROOT, EXISTING_RUN_DIR, 'gate_results.json'), 'utf8'));
  const rank1to10Qualified = existingGate.results.filter(r => r.tier === 'QUALIFIED');
  const rank1to10Rate = existingGate.qualifiedCount / existingGate.totalSymbolDays;

  console.log(`[probe] (b) rank 1-10 gate-pass rate (reused from existing run): ${rank1to10Qualified.length}/${existingGate.totalSymbolDays} = ${(rank1to10Rate * 100).toFixed(2)}%`);
  console.log(`[probe] (b) rank 11-15 gate-pass rate (freshly measured):        ${rank11to15Qualified.length}/${rank11to15Gated.length} = ${(rank11to15Rate * 100).toFixed(2)}%`);
  const rateRatio = rank11to15Rate / rank1to10Rate;
  console.log(`[probe] (b) ratio (rank11-15 / rank1-10) = ${rateRatio.toFixed(3)} — decision rule threshold is 2/3 = ${(2 / 3).toFixed(3)}`);

  // ── (c) Staleness-survival rate on the ENLARGED (topN=15) QUALIFIED set ──
  const enlargedQualifiedKeys = new Set([...rank1to10Qualified.map(key), ...rank11to15Qualified.map(key)]);
  const enlargedQualified = [...rank1to10Qualified.map(r => ({ date: r.date, symbol: r.symbol })), ...rank11to15Qualified.map(r => ({ date: r.date, symbol: r.symbol }))];
  console.log(`[probe] enlarged (topN=15) QUALIFIED set: ${enlargedQualified.length} symbol-days (${rank1to10Qualified.length} from rank1-10 + ${rank11to15Qualified.length} from rank11-15), ${enlargedQualifiedKeys.size} unique (should match — no dupes expected across disjoint rank groups)`);

  const enlargedSymbols = [...new Set(enlargedQualified.map(r => r.symbol))];
  const cikBySymbol = await fetchCikMap();
  const mapped = enlargedSymbols.filter(s => cikBySymbol[s] != null);
  console.log(`[probe] (c) CIK mapping: ${mapped.length}/${enlargedSymbols.length} unique symbols mapped`);

  const edgarBySymbol = {};
  let edgarRequests = 1; // the tickers file
  for (const sym of mapped) {
    edgarBySymbol[sym] = await fetchEdgarDataForSymbol(cikBySymbol[sym]);
    edgarRequests += edgarBySymbol[sym].requestCount;
  }
  console.log(`[probe] (c) SEC requests: ${edgarRequests}`);

  const stalenessRows = enlargedQualified.map(r => {
    const info = edgarBySymbol[r.symbol];
    if (!info) return { ...r, stalenessDays: null };
    const { stalenessDays } = computeStaleness(info.sharesOutstandingPoints, r.date);
    return { ...r, stalenessDays };
  });
  const withStaleness = stalenessRows.filter(r => r.stalenessDays != null);
  console.log(`[probe] (c) symbol-days with a usable preceding shares-outstanding filing: ${withStaleness.length}/${stalenessRows.length}`);
  for (const bound of [90, 180, 365]) {
    const survive = withStaleness.filter(r => r.stalenessDays <= bound);
    console.log(`[probe] (c) staleness bound <=${bound}d: ${survive.length}/${stalenessRows.length} of ALL enlarged-QUALIFIED symbol-days survive`);
  }
  const survival180 = withStaleness.filter(r => r.stalenessDays <= 180).length / stalenessRows.length;

  // ── Decision rule (2026-09-01 chat): "materially lower" = more than a third below, i.e. ratio < 2/3 ──
  const branch = rateRatio >= (2 / 3)
    ? 'topN=15 @ 252 trading days'
    : 'topN=10 @ ~378 trading days (~18 months)';
  console.log('');
  console.log('[probe] === SUMMARY ===');
  console.log(`[probe] (a) topN 10->15 scaling factor: ${scalingFactor.toFixed(3)}x (${rank10Rows.length} -> ${rank15Rows.length} symbol-days)`);
  console.log(`[probe] (b) rank1-10 gate-pass rate: ${(rank1to10Rate * 100).toFixed(2)}% | rank11-15 gate-pass rate: ${(rank11to15Rate * 100).toFixed(2)}% | ratio: ${rateRatio.toFixed(3)}`);
  console.log(`[probe] (c) enlarged (topN=15) QUALIFIED staleness-survival at 180d: ${(survival180 * 100).toFixed(1)}%`);
  console.log(`[probe] DECISION: ratio ${rateRatio.toFixed(3)} ${rateRatio >= (2 / 3) ? '>=' : '<'} 2/3 threshold -> branch to ${branch}`);

  const outDir = path.join(REPO_ROOT, 'artifacts', 'topn-window-probe');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'probe_result.json'), JSON.stringify({
    startDate: START_DATE, endDate: END_DATE,
    a_scaling: { rank10Count: rank10Rows.length, rank15Count: rank15Rows.length, factor: scalingFactor },
    b_gateRates: { rank1to10Rate, rank11to15Rate, ratio: rateRatio, rank11to15Qualified: rank11to15Qualified.length, rank11to15Total: rank11to15Gated.length },
    c_staleness: { survival90: withStaleness.filter(r => r.stalenessDays <= 90).length / stalenessRows.length, survival180, survival365: withStaleness.filter(r => r.stalenessDays <= 365).length / stalenessRows.length, withStaleness: withStaleness.length, total: stalenessRows.length },
    decisionRule: { thresholdRatio: 2 / 3, branch },
    rank11to15Gated, stalenessRows,
  }, null, 2));
  console.log(`[probe] wrote ${path.join(outDir, 'probe_result.json')}`);
}

main().catch((err) => {
  console.error('[probe] FAILED —', err.message, err.stack);
  process.exit(1);
});
