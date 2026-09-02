#!/usr/bin/env node
// Bulk symbol-day scan driver — Node, not the browser harness, by
// deliberate choice (2026-09-01): the render layer needs exercising
// once, not 1,000+ times — scripts/replay-scan.mjs's small 3-day gate
// already does that and keeps running as the always-on check. This is a
// data-generation job; putting a browser in front of it adds fragility
// and wall-clock, not coverage.
//
// THE CONDITION this script exists under: it calls the SAME
// scanDateRangeForSetups (engines/warrior/setups.js) the browser harness
// calls — never a reimplementation of the fetch/rank/carry-forward/
// distribution logic. Re-deriving any of that here would let this path
// and the browser path drift, which has already produced two real
// defects in this project (the bySetup renderer mismatch, and the
// single-day path having no notEvaluated concept). Same engine,
// different driver: drift becomes structurally impossible rather than
// something to police.
//
// Flattening (matrix/triggers/distribution below) is NOT reused from
// scripts/replay-scan.mjs: flattenRangeScan assumes the same symbol list
// every day (a symbols x tradingDays cross product, 'missing' for any
// absent combination) — correct for the browser panel's fixed-list mode,
// wrong here, where most symbols genuinely aren't scheduled most days by
// design, not by defect. This script's own flattening walks only the
// (date, symbol) pairs scanDateRangeForSetups actually populated, using
// the identical per-cell/per-trigger extraction — output shaping for a
// different input shape, not a re-derivation of what scanDateRangeForSetups
// itself computes.
//
// Loads core/universe.js and core/clock.js as classic scripts (eval,
// same technique tests/_lib.js uses) with REAL globals — not mocks —
// and engines/warrior/{replay,setups}.js as real ES modules via dynamic
// import(). Key is read from .env.local and passed only into fetch
// headers; never logged, echoed, or written to any artifact.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// --start/--end override the scan spec's real range (2026-06-01..2026-08-28)
// for cheap smoke-testing on a small window before committing to the full
// run — not a general-purpose CLI, just enough to validate correctness first.
const argv = process.argv.slice(2);
const argVal = (flag, fallback) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : fallback; };
const START_DATE = argVal('--start', '2026-06-01');
const END_DATE = argVal('--end', '2026-08-28');
// --lagged: rank day D's universe by day D-1's move/relVol instead of
// day D's own (core/universe.js's lagSelectionByOneDay) -- the decisive
// test for selection lookahead in the default mode (see chat 2026-09-01).
const LAGGED = argv.includes('--lagged');

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

async function main() {
  const { alpacaKeyId, alpacaSecretKey } = readEnvLocal();

  // ── Real globals, shared scope (mirrors the browser's classic-script
  // sharing, per this codebase's own architecture — see CLAUDE.md) ──────
  global.state = {};
  global.persist = () => {};
  global.chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };

  const realAlpacaGet = async (urlPath, params = {}, base = 'https://data.alpaca.markets/v2') => {
    const url = new URL(base + urlPath);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': alpacaKeyId, 'APCA-API-SECRET-KEY': alpacaSecretKey } });
    if (!res.ok) throw new Error(`${urlPath}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
  global.alpacaGet = realAlpacaGet; // fetchPrevCloseAsOf (replay.js) calls this bare global directly
  global._coreClient = { alpacaGet: realAlpacaGet }; // _fetchRawMinuteBars/_getAssetIndex etc. default to this

  const clockSrc = readFileSync(path.join(REPO_ROOT, 'core', 'clock.js'), 'utf8');
  eval(clockSrc + '\nglobal.getPT = getPT; global.ptDateStr = ptDateStr; global.ptWallClockToInstant = ptWallClockToInstant; global.isTradingDay = isTradingDay;');

  const universeSrc = readFileSync(path.join(REPO_ROOT, 'core', 'universe.js'), 'utf8');
  eval(universeSrc + '\nglobal._fetchRawMinuteBars = _fetchRawMinuteBars; global.reconstructTopMoversUniverse = reconstructTopMoversUniverse;');

  const replayMod = await import(pathToFileURL(path.join(REPO_ROOT, 'engines', 'warrior', 'replay.js')));
  global.runReplay = replayMod.runReplay; // setups.js's classifiers/detectSetupsForCandidate don't need this directly, but keeping the same-shared-scope shape explicit
  const setupsMod = await import(pathToFileURL(path.join(REPO_ROOT, 'engines', 'warrior', 'setups.js')));

  // ── Step 1: universe reconstruction (already verified live — see chat) ──
  console.log(`[run-symbol-day-scan] reconstructing universe… (lagSelectionByOneDay=${LAGGED})`);
  const t0 = Date.now();
  const universeResult = await global.reconstructTopMoversUniverse({ startDateStr: START_DATE, endDateStr: END_DATE, topN: 10, client: global._coreClient, lagSelectionByOneDay: LAGGED });
  console.log(`[run-symbol-day-scan] universe: ${universeResult.symbolDays.length} symbol-days, ${universeResult.requests} requests, ${Math.round((Date.now() - t0) / 1000)}s, label="${universeResult.label}"`);

  const symbolsByDate = {};
  for (const row of universeResult.symbolDays) (symbolsByDate[row.date] = symbolsByDate[row.date] || []).push(row.symbol);
  const dataQualityFlagsByDate = {}; // date -> symbol -> flag, threaded through separately so the replay result can carry it without changing scanDateRangeForSetups's own shape
  for (const row of universeResult.symbolDays) {
    if (row.dataQualityFlag) (dataQualityFlagsByDate[row.date] = dataQualityFlagsByDate[row.date] || {})[row.symbol] = row.dataQualityFlag;
  }

  // ── Step 2: replay, same scanDateRangeForSetups the browser harness calls ──
  // onRawDistribution pools RAW per-bar observations across the whole
  // scan, per setup -- a true population percentile needs the raw
  // values, not a median-of-medians across 1,000+ already-summarized
  // per-symbol-day rows (mathematically invalid to merge that way). No
  // extra fetch or classifier-eval cost: this reuses the exact
  // captureEvaluationDistribution call scanDateRangeForSetups already
  // makes internally for its own per-symbol-day summary, just also
  // handing the raw array to this callback before it gets reduced.
  console.log('[run-symbol-day-scan] running scanDateRangeForSetups across all five classifiers…');
  const t1 = Date.now();
  let lastLoggedSymbolDays = -1;
  const pooledObservations = {}; // setupId -> { volumeMultiple: [], baselineSpanMinutes: [], baselineBarCount: [] }
  const result = await setupsMod.scanDateRangeForSetups(
    setupsMod.ALL_SETUPS_ID, [], START_DATE, END_DATE,
    {
      symbolsByDate,
      onRawDistribution: (dateStr, sym, observationsBySetup) => {
        for (const setupId of Object.keys(observationsBySetup)) {
          const bucket = pooledObservations[setupId] || (pooledObservations[setupId] = { volumeMultiple: [], baselineSpanMinutes: [], baselineBarCount: [] });
          for (const obs of observationsBySetup[setupId]) {
            bucket.volumeMultiple.push(obs.volumeMultiple);
            bucket.baselineSpanMinutes.push(obs.baselineSpanMinutes);
            bucket.baselineBarCount.push(obs.baselineBarCount);
          }
        }
      },
      onProgress: (p) => {
        if (p.symbolDaysCompleted !== lastLoggedSymbolDays && (p.symbolDaysCompleted % 25 === 0 || p.symbolDaysCompleted === p.totalSymbolDays)) {
          lastLoggedSymbolDays = p.symbolDaysCompleted;
          const elapsedSec = Math.round((Date.now() - t1) / 1000);
          console.log(`[run-symbol-day-scan] progress: ${p.symbolDaysCompleted}/${p.totalSymbolDays} symbol-days (day ${p.index + 1}/${p.total}, ${p.dateStr}) — ${elapsedSec}s elapsed`);
        }
      },
    }
  );
  const elapsedSec = Math.round((Date.now() - t1) / 1000);
  console.log(`[run-symbol-day-scan] replay done: ${result.requests} requests, ${elapsedSec}s, cancelled=${result.cancelled}`);

  // True population percentiles per setup, computed once from the pooled
  // raw values (nearest-rank, same method as _distributionSummary in
  // setups.js, kept consistent rather than reinventing a second
  // percentile method here).
  const percentile = (sortedAscending, p) => {
    if (!sortedAscending.length) return null;
    const idx = Math.min(sortedAscending.length - 1, Math.floor((p / 100) * sortedAscending.length));
    return sortedAscending[idx];
  };
  const summarizeField = (values) => {
    const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (!finite.length) return { count: 0, median: null, p75: null, p90: null, p99: null, max: null };
    const sorted = [...finite].sort((a, b) => a - b);
    return { count: sorted.length, median: percentile(sorted, 50), p75: percentile(sorted, 75), p90: percentile(sorted, 90), p99: percentile(sorted, 99), max: sorted[sorted.length - 1] };
  };
  const pooledDistributionSummary = {};
  for (const setupId of Object.keys(pooledObservations)) {
    const b = pooledObservations[setupId];
    pooledDistributionSummary[setupId] = {
      volumeMultiple: summarizeField(b.volumeMultiple),
      baselineSpanMinutes: summarizeField(b.baselineSpanMinutes),
      baselineBarCount: summarizeField(b.baselineBarCount),
    };
  }
  console.log('[run-symbol-day-scan] pooled distribution (true population percentiles):', JSON.stringify(pooledDistributionSummary, null, 2));

  // ── Flatten: scripts/replay-scan.mjs's own flattenRangeScan/
  // flattenDistribution assume the SAME symbol list every day (a
  // symbols x tradingDays cross product, 'missing' for any combination
  // absent from resultsByDate) — correct for the browser panel's
  // fixed-list mode, wrong here: a reconstructed-movers day genuinely
  // doesn't schedule most symbols on most days, and that's not a
  // finding, it's the design. This walks only the (date, symbol) pairs
  // scanDateRangeForSetups actually populated — same per-cell/per-
  // trigger extraction as flattenRangeScan, just without manufacturing
  // a 'missing' cell for every combination that was never scheduled.
  // Nothing about fetch/rank/carry-forward/distribution capture is
  // re-derived here — that's 100% scanDateRangeForSetups, per the
  // condition this script exists under (see header comment).
  const setupIds = setupsMod.SETUP_REPLAY_CATALOG.map(e => e.id);
  const cells = [];
  const triggers = [];
  for (const [date, byDate] of Object.entries(result.resultsByDate)) {
    for (const [symbol, dayResult] of Object.entries(byDate)) {
      if (dayResult.notEvaluated) {
        for (const setup of setupIds) cells.push({ date, symbol, setup, naive: null, reArmed: null, state: 'not-evaluated', reason: dayResult.reason, barCount: null });
        continue;
      }
      const barCount = dayResult.barCount ?? null;
      for (const setup of setupIds) {
        const r = dayResult.bySetup?.[setup];
        if (!r) continue;
        if (r.notEvaluated) { cells.push({ date, symbol, setup, naive: null, reArmed: null, state: 'not-evaluated', reason: r.reason, barCount }); continue; }
        cells.push({ date, symbol, setup, naive: r.naiveTriggers.length, reArmed: r.rearmedTriggers.length, state: r.rearmedTriggers.length > 0 ? 'fired' : 'zero', reason: null, barCount });
        const flag = dataQualityFlagsByDate[date]?.[symbol] || null;
        for (const t of r.rearmedTriggers) triggers.push({ date, symbol, setup, ...t, dataQualityFlag: flag });
      }
    }
  }
  const distribution = [];
  for (const [date, byDate] of Object.entries(result.resultsByDate)) {
    for (const [symbol, dayResult] of Object.entries(byDate)) {
      if (dayResult.notEvaluated || !dayResult.distribution) continue;
      for (const setup of setupIds) {
        const d = dayResult.distribution[setup];
        if (d) distribution.push({ date, symbol, setup, ...d });
      }
    }
  }
  const flattened = { cells, triggers };

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}_symbol-day-scan${LAGGED ? '-lagged' : ''}`;
  const artifactDir = path.join(REPO_ROOT, 'artifacts', runId);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(path.join(artifactDir, 'universe.json'), JSON.stringify(universeResult, null, 2));
  writeFileSync(path.join(artifactDir, 'matrix.json'), JSON.stringify(flattened.cells, null, 2));
  writeFileSync(path.join(artifactDir, 'triggers.json'), JSON.stringify(flattened.triggers, null, 2));
  writeFileSync(path.join(artifactDir, 'distribution.json'), JSON.stringify(distribution, null, 2));
  writeFileSync(path.join(artifactDir, 'pooled_distribution.json'), JSON.stringify(pooledDistributionSummary, null, 2));
  writeFileSync(path.join(artifactDir, 'meta.json'), JSON.stringify({
    startDate: START_DATE, endDate: END_DATE, lagSelectionByOneDay: LAGGED,
    symbolDayCount: universeResult.symbolDays.length,
    universeRequests: universeResult.requests,
    replayRequests: result.requests,
    replayElapsedSec: elapsedSec,
    cellCount: flattened.cells.length,
    triggerCount: flattened.triggers.length,
    pooledDistributionSummary,
  }, null, 2));

  console.log(`[run-symbol-day-scan] cells=${flattened.cells.length} triggers=${flattened.triggers.length}`);
  console.log(`[run-symbol-day-scan] artifacts written to ${artifactDir}`);
}

main().catch((err) => {
  console.error('[run-symbol-day-scan] FAILED —', err.message, err.stack);
  process.exit(1);
});
