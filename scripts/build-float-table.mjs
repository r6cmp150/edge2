#!/usr/bin/env node
// Weekly float-table build (2026-09-04) — the fix for a real live boot-
// check failure: SEC's data.sec.gov/www.sec.gov send no
// Access-Control-Allow-Origin on a real GET and flatly 403 any CORS
// preflight OPTIONS request (Akamai WAF). A browser can never call EDGAR
// directly, full stop — confirmed live, not assumed (see core/edgar.js's
// own header and docs/warrior-engine-spec-v2.md Phase 6 for the trace).
//
// This script does what core/edgar.js's getFloatDataForSymbols always
// did — same derivation, same shares-outstanding invariant guard — but
// from Node (where CORS doesn't apply), for the WHOLE instrument-eligible
// universe (~5,700 symbols, the same set core/universe.js's
// _getAssetIndex/_isEligibleInstrument already define and the live app's
// own scans draw from), and writes the settled verdicts to
// data/float-table.json. The live app reads that file same-origin via
// core/float-table.js — no CORS, no forbidden headers, no runtime rate
// limit, no new infrastructure. Same pattern as
// data/movers-snapshots/log.jsonl (scripts/capture-movers-snapshot.mjs).
//
// FULL rebuild every run, not incremental (2026-09-04 decision):
// EntityPublicFloat is an annual figure, already 6-18 months stale by
// nature — a week's table age is noise against that, and tracking SEC's
// daily filing index to find what changed would be real complexity for
// no real freshness gain. ~2 EDGAR calls/symbol at SEC's ~10/s pace is
// roughly 20 minutes for the full universe — comfortable inside a
// scheduled Action's limits, run weekly (.github/workflows/
// build-float-table.yml), not daily.
//
// Loads core/api-client.js, core/clock.js, core/universe.js, core/edgar.js
// as classic scripts (eval, same technique tests/_lib.js and every other
// Node driver in this scripts/ directory uses) with REAL globals, then
// calls getFloatDataForSymbols ONCE for the whole eligible universe and
// reads the resulting state.warriorFloatCache.bySymbol for the full
// per-symbol verdict (including sharesOutstandingAtCheck provenance,
// which getFloatDataForSymbols's own public return value doesn't carry —
// that's fine, this script reads the cache directly since it IS the
// thing populating it, this run, fresh).
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_PATH = path.join(REPO_ROOT, 'data', 'float-table.json');

function readCredentials() {
  // GitHub Actions: real env vars (see .github/workflows/build-float-table.yml).
  // Local dev: fall back to .env.local, same convention scripts/run-symbol-day-scan.mjs uses.
  if (process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY) {
    return { alpacaKeyId: process.env.ALPACA_KEY_ID, alpacaSecretKey: process.env.ALPACA_SECRET_KEY };
  }
  const envLocalPath = path.join(REPO_ROOT, '.env.local');
  if (existsSync(envLocalPath)) {
    const raw = readFileSync(envLocalPath, 'utf8');
    const kv = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) kv[m[1]] = m[2];
    }
    if (kv.APCA_API_KEY_ID && kv.APCA_API_SECRET_KEY) {
      return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
    }
  }
  throw new Error('build-float-table: no Alpaca credentials found (ALPACA_KEY_ID/ALPACA_SECRET_KEY env vars, or .env.local APCA_API_KEY_ID/APCA_API_SECRET_KEY)');
}

// --limit N: cap the eligible universe for a cheap smoke test before
// committing to the full ~20-minute run. Not a general-purpose CLI.
const argv = process.argv.slice(2);
const limitArg = argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(argv[limitArg + 1], 10) : null;

async function main() {
  const t0 = Date.now();
  const { alpacaKeyId, alpacaSecretKey } = readCredentials();

  global.state = { settings: { alpacaKey: alpacaKeyId, alpacaSecret: alpacaSecretKey }, warriorEdgarCikMapCache: null, warriorFloatCache: null, universeAssetCache: null };
  global.persist = () => {};

  const apiClientSrc = readFileSync(path.join(REPO_ROOT, 'core', 'api-client.js'), 'utf8');
  eval(apiClientSrc + '\nglobal.alpacaGet = alpacaGet; global._coreClient = _coreClient; global.chunk = chunk; global.assertPageNotSuspiciouslyFull = assertPageNotSuspiciouslyFull;');

  const clockSrc = readFileSync(path.join(REPO_ROOT, 'core', 'clock.js'), 'utf8');
  eval(clockSrc + '\nglobal.getPT = getPT; global.ptDateStr = ptDateStr;');

  const universeSrc = readFileSync(path.join(REPO_ROOT, 'core', 'universe.js'), 'utf8');
  eval(universeSrc + '\nglobal._fetchHistoricalDailyBars = _fetchHistoricalDailyBars; global._getAssetIndex = _getAssetIndex;');

  const edgarSrc = readFileSync(path.join(REPO_ROOT, 'core', 'edgar.js'), 'utf8');
  eval(edgarSrc + '\nglobal.getFloatDataForSymbols = getFloatDataForSymbols;');

  console.log('[build-float-table] fetching instrument-eligible universe…');
  const assetIndex = await global._getAssetIndex(global._coreClient);
  let eligibleSymbols = assetIndex.filter(a => a.isEligibleInstrument).map(a => a.symbol);
  console.log(`[build-float-table] ${assetIndex.length} tradable assets -> ${eligibleSymbols.length} instrument-eligible`);
  if (LIMIT) {
    eligibleSymbols = eligibleSymbols.slice(0, LIMIT);
    console.log(`[build-float-table] --limit ${LIMIT} applied -- smoke-test run, not a real build`);
  }

  console.log(`[build-float-table] fetching float data for ${eligibleSymbols.length} symbols… (this takes a while — ~2 EDGAR calls/symbol at ~8/s)`);
  const result = await global.getFloatDataForSymbols(eligibleSymbols);
  console.log(`[build-float-table] getFloatDataForSymbols done: ${result.requests} requests, ${result.failedSymbols.length} failed, ${result.unmappedSymbols.length} unmapped (this run only)`);

  // Read the cache directly, not result.floatBySymbol -- the cache carries
  // the full verdict taxonomy and the sharesOutstandingAtCheck provenance
  // the public return value doesn't.
  //
  // SIX buckets now, not four (2026-09-04, reclassified after the first
  // full-universe build): no-price-data and invalid-reference-date used to
  // both fall into "failed" -- 232/233 of that run's failures were
  // genuinely no-price-data (confirmed live via a direct Alpaca query: it
  // has zero bars for a sample of these, not a batch fault), a PERMANENT
  // structural gap for that filing (the company likely wasn't yet publicly
  // traded), not a build defect a retry would fix. Folding it into "no
  // filing" was considered and rejected too -- if that bucket's own count
  // ever spikes, it's diagnostic of something new (SEC data or our date
  // handling), which only holds if it's counted separately.
  // Rounding (2026-09-04, found while investigating a file-size question):
  // impliedFloatShares/impliedFloatAtRefShares carried full floating-point
  // noise into the committed file (e.g. 102467243.6522465 -- fake
  // precision for an estimate derived from two independently-stale SEC
  // facts; a share count was never going to be exact to the fraction of a
  // share). splitFactor (a price ratio) carried similar noise (e.g.
  // 27.999999999999996 instead of 28). Rounding shares to whole numbers
  // and splitFactor to 4 decimal places recovers ~8.4% of file size (about
  // 78KB on the 5,709-symbol build) for free -- no information lost, since
  // sub-share/sub-0.0001 precision was never meaningful here. Measured
  // before applying, not assumed: the OTHER hypothesis (full shares-
  // outstanding history being stored) was checked and ruled out first --
  // only 7 scalar fields per entry, no arrays, confirmed by inspection.
  const _round = (n) => (n == null ? null : Math.round(n));
  const _round4 = (n) => (n == null ? null : Math.round(n * 10000) / 10000);

  const bySymbolCache = global.state.warriorFloatCache.bySymbol;
  const bySymbol = {};
  let valueCount = 0, noFilingCount = 0, unmappedCount = 0, discardedCount = 0, noPriceDataCount = 0, invalidReferenceDateCount = 0, missingCount = 0;
  let dilutionCorrectedCount = 0, uncorrectedNoSharesDataCount = 0;
  for (const sym of eligibleSymbols) {
    const entry = bySymbolCache[sym];
    if (!entry) { missingCount++; continue; } // build-time failure this run -- omitted, not fabricated as any verdict; "not in table" to the live app
    if (entry.impliedFloatShares != null) {
      // dilutionCorrected/impliedFloatAtRefShares/splitFactor (2026-09-04):
      // provenance for the dilution correction (core/edgar.js's own header
      // has the full derivation and the residual-bias caveat). Tracked here
      // too, separately, so the correction's OWN coverage (how many usable
      // entries could actually be corrected, vs. how many fall back to the
      // uncorrected value for lack of shares-outstanding history) is a
      // number this build reports on its own, not something inferred.
      bySymbol[sym] = {
        status: 'value', impliedFloatShares: _round(entry.impliedFloatShares), referenceDate: entry.referenceDate,
        sharesOutstandingAtCheck: entry.sharesOutstandingAtCheck ?? null,
        dilutionCorrected: !!entry.dilutionCorrected,
        impliedFloatAtRefShares: _round(entry.impliedFloatAtRefShares),
        splitFactor: _round4(entry.splitFactor),
      };
      valueCount++;
      if (entry.dilutionCorrected) dilutionCorrectedCount++; else uncorrectedNoSharesDataCount++;
    } else if (entry.invalidReason) {
      bySymbol[sym] = { status: 'discarded', reason: entry.invalidReason, sharesOutstandingAtCheck: entry.sharesOutstandingAtCheck ?? null };
      discardedCount++;
    } else if (entry.noPriceDataReason) {
      bySymbol[sym] = { status: 'no-price-data', reason: entry.noPriceDataReason };
      noPriceDataCount++;
    } else if (entry.invalidReferenceDateReason) {
      bySymbol[sym] = { status: 'invalid-reference-date', reason: entry.invalidReferenceDateReason };
      invalidReferenceDateCount++;
    } else if (entry.unmapped) {
      bySymbol[sym] = { status: 'unmapped' };
      unmappedCount++;
    } else {
      bySymbol[sym] = { status: 'no-filing' };
      noFilingCount++;
    }
  }

  // Hard-fail on incomplete, same rule as core/universe.js's
  // _fetchHistoricalDailyBars (CLAUDE.md: a partial universe is not a
  // smaller universe, it's a wrong one — found live once already, the
  // widened backtest scan that silently shipped an artifact at 92.2%
  // symbol coverage). The failure mode here is different (a committed
  // FILE, not a one-off artifact) but the fix is the same shape: assert
  // completeness BEFORE writing anything, and if it doesn't hold, fail
  // loudly and write NOTHING — the previous committed table stays in
  // place (stale but honest) rather than being replaced by a partial one.
  // Only genuine build-time failures (missingCount) count against the
  // tolerance — unmapped/no-filing/discarded/no-price-data/invalid-
  // reference-date are all real, structural verdicts, not incompleteness
  // (no-price-data/invalid-reference-date were reclassified OUT of this
  // count 2026-09-04 — they were 232/233 of the first full-universe run's
  // failures, but they're permanent per-filing facts a retry never
  // resolves, not build defects; see core/edgar.js's header). 2%: generous
  // enough to absorb ordinary transient network flakiness across ~5,700
  // sequential unretried SEC requests (core/edgar.js's _edgarGet has no
  // retry logic, unlike Alpaca calls routed through core/api-client.js's
  // queue), tight enough that a systematic defect (the parsing bug this
  // build's first attempt hit) would still trip it — confirmed against the
  // real numbers: with the reclassification, this run's true failedCount
  // is expected to be a small handful, not hundreds.
  const FAILURE_TOLERANCE_FRACTION = 0.02;
  const failedFraction = eligibleSymbols.length ? missingCount / eligibleSymbols.length : 0;
  const completenessCheck = { failedCount: missingCount, attemptedCount: eligibleSymbols.length, failedFraction, toleranceFraction: FAILURE_TOLERANCE_FRACTION, passed: failedFraction <= FAILURE_TOLERANCE_FRACTION };
  console.log(`[build-float-table] completeness check: ${missingCount}/${eligibleSymbols.length} failed outright (${(failedFraction * 100).toFixed(2)}%, tolerance ${(FAILURE_TOLERANCE_FRACTION * 100).toFixed(0)}%) -> ${completenessCheck.passed ? 'PASS' : 'FAIL'}`);
  if (!completenessCheck.passed) {
    throw new Error(`build-float-table: completeness check failed — ${missingCount}/${eligibleSymbols.length} symbols (${(failedFraction * 100).toFixed(2)}%) failed outright, exceeding the ${(FAILURE_TOLERANCE_FRACTION * 100).toFixed(0)}% tolerance. Writing nothing — the previously committed data/float-table.json stays in place. This is very likely a systematic bug (network outage, a parsing defect, an EDGAR/Alpaca API shape change), not ordinary flakiness — investigate before re-running.`);
  }

  // Drift detection against the previous committed table (2026-09-04) —
  // matters more than the static tolerance above: a fixed threshold can't
  // catch a NEW failure mode that wears a permanent-gap costume. If
  // no-price-data jumped from 4% to 40% next week, every instance would be
  // individually classified as permanent and non-blocking, the
  // completeness check above would pass cleanly, and a broken build would
  // commit anyway. This compares every bucket's SHARE of the attempted
  // population against the last committed table and fails if any moves by
  // more than DRIFT_TOLERANCE_PP (absolute percentage points) — the
  // previous table is right there in the repo, no extra state needed. 5pp:
  // a starting point, not a measured constant (no real week-over-week
  // history exists yet to calibrate against) — reasoned as generous enough
  // to absorb ordinary week-to-week filing-volume noise across ~5,700
  // symbols while still catching a swing the size of the user's own
  // illustrative example (4%->40%, an 36pp jump). Revisit once a few real
  // weekly runs establish what normal drift actually looks like.
  let previousTable = null;
  if (existsSync(OUT_PATH)) {
    try {
      previousTable = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
    } catch (e) {
      console.warn(`[build-float-table] could not parse the previous table for drift comparison (${e.message}) — treating this as a first build, no drift check`);
    }
  }
  const DRIFT_TOLERANCE_PP = 0.05;
  const currentCounts = { usableCount: valueCount, noFilingCount, unmappedCount, discardedByGuardCount: discardedCount, noPriceDataCount, invalidReferenceDateCount, failedCount: missingCount };
  let driftCheck = { skipped: true, reason: 'no previous table to compare against (first build)' };
  if (previousTable && typeof previousTable.attemptedCount === 'number' && previousTable.attemptedCount > 0) {
    const driftIssues = [];
    const perBucket = {};
    for (const key of Object.keys(currentCounts)) {
      const prevFrac = (previousTable[key] ?? 0) / previousTable.attemptedCount;
      const newFrac = currentCounts[key] / eligibleSymbols.length;
      const deltaPP = newFrac - prevFrac;
      perBucket[key] = { prevFraction: prevFrac, newFraction: newFrac, deltaPP };
      if (Math.abs(deltaPP) > DRIFT_TOLERANCE_PP) {
        driftIssues.push(`${key}: ${(prevFrac * 100).toFixed(1)}% -> ${(newFrac * 100).toFixed(1)}% (Δ${(deltaPP * 100).toFixed(1)}pp)`);
      }
    }
    driftCheck = { skipped: false, toleranceFraction: DRIFT_TOLERANCE_PP, perBucket, passed: driftIssues.length === 0, previousBuiltAt: previousTable.builtAt ?? null };
    console.log(`[build-float-table] drift check vs. previous table (built ${previousTable.builtAt ?? 'unknown'}): ${driftCheck.passed ? 'PASS' : 'FAIL'}${driftIssues.length ? ' — ' + driftIssues.join('; ') : ''}`);
    if (!driftCheck.passed) {
      throw new Error(`build-float-table: drift check failed against the previous committed table (built ${previousTable.builtAt ?? 'unknown'}) — ${driftIssues.join('; ')}. Writing nothing — the previously committed data/float-table.json stays in place. A bucket moving this much week-over-week is very likely a new failure mode (a data-source change, a code regression) wearing a permanent-gap costume, not normal variation — investigate before re-running.`);
    }
  } else {
    console.log('[build-float-table] drift check: skipped (no previous table found — this is the first build)');
  }

  const builtAt = new Date().toISOString();
  const table = {
    builtAt,
    // The numbers a future session needs to tell a real coverage gap
    // (structural: no filing, no CIK, guard-discarded, no price data,
    // invalid reference date) apart from a broken build (failed outright)
    // -- see this section's header comment. attemptedCount/usableCount/
    // discardedByGuardCount/failedCount are the four-number contract this
    // was originally asked for; noFilingCount/unmappedCount/
    // noPriceDataCount/invalidReferenceDateCount are the finer split
    // within "not-checked, structural" that make each bucket individually
    // diagnostic (see the drift check above, which depends on exactly this
    // granularity).
    attemptedCount: eligibleSymbols.length,
    usableCount: valueCount,
    discardedByGuardCount: discardedCount,
    failedCount: missingCount,
    noFilingCount, unmappedCount, noPriceDataCount, invalidReferenceDateCount,
    // Dilution-correction coverage (2026-09-04) — its own number, tracked
    // separately: of the usable entries, how many could actually be
    // corrected (had shares-outstanding history to correct WITH) vs. how
    // many fall back to the uncorrected value, protected only by the
    // volume-consistency backstop. See core/edgar.js's header for why
    // ~16% of usable entries can't be corrected (no dei:EntityCommonStock-
    // SharesOutstanding history at all for that filer, confirmed for real,
    // established names like GPRO, not an edge case).
    dilutionCorrectedCount, uncorrectedNoSharesDataCount,
    completenessCheck,
    driftCheck,
    requests: result.requests,
    buildDurationSeconds: Math.round((Date.now() - t0) / 1000),
    bySymbol,
  };

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const json = JSON.stringify(table);
  writeFileSync(OUT_PATH, json);
  const sizeBytes = statSync(OUT_PATH).size;
  console.log(`[build-float-table] wrote ${OUT_PATH}`);
  console.log(`[build-float-table] attempted=${table.attemptedCount} usable=${valueCount} no-filing=${noFilingCount} unmapped=${unmappedCount} discarded-by-guard=${discardedCount} no-price-data=${noPriceDataCount} invalid-reference-date=${invalidReferenceDateCount} failed=${missingCount}`);
  console.log(`[build-float-table] dilution-correction coverage: ${dilutionCorrectedCount}/${valueCount} usable entries corrected (${valueCount ? (dilutionCorrectedCount / valueCount * 100).toFixed(1) : '0.0'}%), ${uncorrectedNoSharesDataCount} uncorrected for lack of shares-outstanding history`);
  console.log(`[build-float-table] file size: ${sizeBytes} bytes (${(sizeBytes / 1024).toFixed(1)} KB, ${(sizeBytes / 1024 / 1024).toFixed(3)} MB)`);
  console.log(`[build-float-table] total wall time: ${table.buildDurationSeconds}s`);
}

main().catch((err) => {
  console.error('[build-float-table] FAILED —', err.message, err.stack);
  process.exit(1);
});
