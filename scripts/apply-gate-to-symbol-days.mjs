#!/usr/bin/env node
// Applies a RETROACTIVE, daily-bar-only approximation of the 5 Pillars
// gate (engines/warrior/gate.js) to a symbol-day list already selected
// by reconstructTopMoversUniverse, and re-cuts that run's per-setup
// summary table down to gate survivors only.
//
// WHY THIS MATTERS (2026-09-02): the universe was reconstructed movers,
// never gated. In Ross's method the gate is what makes the setups mean
// anything -- a HOD break on a stock with no catalyst and ordinary
// volume is not the trade he's describing. This measures how many of
// the symbol-days that reached replay would have actually cleared the
// gate.
//
// FOUR PILLARS, FLOAT NOT-CHECKED (float is Phase 6, unavailable --
// same three-state design the app already uses: pass / fail /
// not-checked, never fabricated as a pass). classifyGate's own logic
// (ported verbatim from gate.js) never puts float in the substantive
// set either way, so this omission changes nothing about how survival
// is computed, only what's displayed.
//
// TWO PILLARS ARE APPROXIMATIONS, NOT EXACT REPLAYS, AND BOTH LEAN
// GENEROUS (more likely to pass than the live gate would be) -- named
// explicitly so a survivor count isn't read as tighter than it is:
//   - CHANGE: gate.js checks live intraday (often premarket) gap%.
//     Only daily bars exist here, so this uses day D's own close-vs-
//     prior-close %, a full-session change, not a premarket gap. A
//     name that gapped 12% at the open and gave half of it back by
//     the close would show under 10% here and fail a pillar the live
//     gate would have already passed at 9:30am.
//   - RVOL: gate.js's exact formula needs an intraday elapsed-minutes
//     snapshot and cumulative volume AT that snapshot -- unavailable
//     without minute bars. Approximated as day D's FULL-DAY volume
//     over the trailing 30-day average, same >=5.0x threshold. Always
//     >= any partial-day cumulative figure, so this can only ever be
//     easier to clear than the live mid-session check, never harder.
// PRICE uses day D's own close (exact, no approximation). NEWS is a
// real historical query against Alpaca's /news endpoint (verified
// live to support historical date ranges), 24h before day D's regular
// session open -- the same lookback the live gate uses, just anchored
// to a historical instant instead of "now."
//
// Bars are fetched ONLY for the symbols this specific symbol-day list
// needs (not the full ~5,711-symbol eligible universe) -- reuses
// core/universe.js's _fetchHistoricalDailyBars and _rankTopMovers
// (unlagged mode, topN effectively unbounded) exactly as already
// written, not a parallel reimplementation of the day-over-day/relVol
// math.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateSymbolDay, fetchNewsByDateSymbol } from './lib/gate-classifier.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node scripts/apply-gate-to-symbol-days.mjs <path-to-run-artifact-dir>');
  process.exit(1);
}

function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2];
  }
  return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
}

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
  eval(universeSrc + '\nglobal._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._rankTopMovers = _rankTopMovers; global._shiftDateStr = _shiftDateStr;');

  const universe = JSON.parse(readFileSync(path.join(runDir, 'universe.json'), 'utf8'));
  const targetSymbolDays = universe.symbolDays.map(r => ({ date: r.date, symbol: r.symbol }));
  const targetKey = (d, s) => `${d}|${s}`;
  const targetSet = new Set(targetSymbolDays.map(r => targetKey(r.date, r.symbol)));
  const symbols = [...new Set(targetSymbolDays.map(r => r.symbol))];
  const dates = [...new Set(targetSymbolDays.map(r => r.date))].sort();
  console.log(`[apply-gate] ${targetSymbolDays.length} symbol-days, ${symbols.length} unique symbols, ${dates.length} trading days`);

  // ── Day D's own change%/volume (NOT the lagged run's selection metric) ──
  const startDate = dates[0], endDate = dates[dates.length - 1];
  const fetchStart = global._shiftDateStr(startDate, -60); // same 60-day pad as the original reconstruction, for a valid 30-day relVol lookback near the range's start
  const t0 = Date.now();
  const { barsBySymbol, requests: barRequests } = await global._fetchHistoricalDailyBars(symbols, fetchStart, endDate, global._coreClient);
  const ownMetricRows = global._rankTopMovers(barsBySymbol, startDate, endDate, 999999, { lagSelectionByOneDay: false });
  const ownMetricsByKey = new Map();
  for (const row of ownMetricRows) ownMetricsByKey.set(targetKey(row.date, row.symbol), row);
  const targetsWithOwnMetrics = targetSymbolDays.filter(r => ownMetricsByKey.has(targetKey(r.date, r.symbol))).length;
  console.log(`[apply-gate] day-D's-own metrics: ${barRequests} requests, ${Math.round((Date.now() - t0) / 1000)}s, ${ownMetricsByKey.size} total qualifying rows across all fetched symbols, ${targetsWithOwnMetrics} of ${targetSymbolDays.length} TARGET symbol-days matched (rest lack a valid prior close or fell outside $1-$20 on their own close, so price/change fail below rather than being fabricated)`);

  // ── Historical news, batched per trading day (24h before that day's open) ──
  const t1 = Date.now();
  const { newsByDateSymbol, newsRequests } = await fetchNewsByDateSymbol(
    dates,
    (date) => targetSymbolDays.filter(r => r.date === date).map(r => r.symbol)
  );
  console.log(`[apply-gate] news: ${newsRequests} requests, ${Math.round((Date.now() - t1) / 1000)}s`);

  // ── Gate each symbol-day ──
  const results = [];
  for (const { date, symbol } of targetSymbolDays) {
    const own = ownMetricsByKey.get(targetKey(date, symbol));
    const headline = newsByDateSymbol.get(targetKey(date, symbol));
    const { pillars, tier } = gateSymbolDay({ own, headline });
    results.push({ date, symbol, tier, pillars });
  }

  const qualified = results.filter(r => r.tier === 'QUALIFIED');
  const nearMiss = results.filter(r => r.tier === 'NEAR_MISS');
  // 2026-09-05: was `r.tier === null`, back when classifyGate returned bare
  // null for two different cases (a genuine 2+-pillar reject, and nothing
  // substantive being checkable at all) lumped into one `disqualified`
  // bucket. gate-classifier.mjs now names both explicitly -- split here to
  // match, so a symbol-day that was never evaluated isn't counted the same
  // way as one that was evaluated and failed.
  const disqualified = results.filter(r => r.tier === 'REJECTED');
  const notEvaluated = results.filter(r => r.tier === 'NOT_EVALUATED');
  console.log(`[apply-gate] QUALIFIED: ${qualified.length} / ${results.length} (${(100 * qualified.length / results.length).toFixed(1)}%)`);
  console.log(`[apply-gate] NEAR_MISS: ${nearMiss.length} | disqualified (REJECTED): ${disqualified.length} | NOT_EVALUATED: ${notEvaluated.length}`);
  const failReasonCounts = {};
  for (const r of disqualified.concat(nearMiss)) {
    for (const id of ['price', 'change', 'rvol', 'news']) {
      if (r.pillars[id].status === 'fail') failReasonCounts[id] = (failReasonCounts[id] || 0) + 1;
    }
  }
  console.log('[apply-gate] fail counts by pillar (among non-QUALIFIED):', JSON.stringify(failReasonCounts));

  // ── Re-cut the run's triggers to QUALIFIED symbol-days only ──
  const triggers = JSON.parse(readFileSync(path.join(runDir, 'triggers.json'), 'utf8'));
  const qualifiedSet = new Set(qualified.map(r => targetKey(r.date, r.symbol)));
  const gatedTriggers = triggers.filter(t => qualifiedSet.has(targetKey(t.date, t.symbol)));
  console.log(`[apply-gate] triggers before gate: ${triggers.length} -> after (QUALIFIED symbol-days only): ${gatedTriggers.length}`);

  const outPath = path.join(runDir, 'gate_results.json');
  writeFileSync(outPath, JSON.stringify({ results, qualifiedCount: qualified.length, nearMissCount: nearMiss.length, disqualifiedCount: disqualified.length, notEvaluatedCount: notEvaluated.length, totalSymbolDays: results.length }, null, 2));
  const gatedTriggersPath = path.join(runDir, 'triggers_gated.json');
  writeFileSync(gatedTriggersPath, JSON.stringify(gatedTriggers, null, 2));
  console.log(`[apply-gate] wrote ${outPath} and ${gatedTriggersPath}`);
}

main().catch((err) => {
  console.error('[apply-gate] FAILED —', err.message, err.stack);
  process.exit(1);
});
