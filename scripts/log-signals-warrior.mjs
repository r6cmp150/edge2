#!/usr/bin/env node
// Server-side signal logger for Warrior -- Phase 7's actual deliverable.
// Imports the REAL engines/warrior/gate.js (never
// scripts/lib/gate-classifier.mjs's backtest approximation) via the same
// eval-with-real-globals technique scripts/apply-gate-to-symbol-days.mjs
// already uses to run real core/*.js code from Node.
//
// DRY RUN BY DEFAULT. Only writes to Supabase with --write. Default
// behavior computes every row it WOULD insert and writes them to a local
// JSON file instead -- signal_log is insert-only for anon (no UPDATE, no
// DELETE), so a wrong row has no cleanup path short of the SQL editor.
// Review the dry-run file before ever passing --write.
//
// UNIVERSE PROVENANCE (constraint 4): reads TODAY's most recent entry
// from the already-committed data/movers-snapshots/log.jsonl rather than
// re-fetching /screener/stocks/movers|most-actives itself. If this
// logger fetched its own screener call at a different minute than
// capture-movers-snapshot.yml, the two jobs' "universe" would silently
// disagree and nothing later could reconstruct why. The committed
// entry's raw gainers/most_actives ARE re-enriched here (current asset
// eligibility, current snapshot price for actives rows) -- that part is
// necessarily live, since the committed snapshot doesn't carry it -- but
// the SYMBOL SET (which tickers count as movers/actives at all) comes
// from the shared, already-recorded capture, not a second independent
// call to the same endpoints. Falls back to a self-fetch (via the real
// getUniverse) ONLY if no sufficiently recent committed entry exists,
// and stamps which path was used on every row either way.
//
// SCAN COMPLETENESS (constraint 1): every run produces a scan_runs row
// (db/010, not yet created -- see that file) recording universe size,
// how many candidates were actually evaluated, how many pillar-batch
// fetches failed, and whether the run completed or aborted. Without
// this, a partial scan (Alpaca 429s partway through) produces fewer
// signal_log rows and looks identical to a day where fewer candidates
// existed -- exactly this project's signature failure mode, aimed at
// the dataset the whole forward test depends on.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WRITE = process.argv.includes('--write');
const SESSION_OVERRIDE = (process.argv.find(a => a.startsWith('--session=')) || '').split('=')[1];

const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';

// ── credentials: same shim shape apply-gate-to-symbol-days.mjs already
// uses (a fake `state.settings`, not an env-var branch inside
// core/api-client.js -- alpacaHeaders() itself is unmodified). Actions
// secrets (ALPACA_KEY_ID/ALPACA_SECRET_KEY) match capture-movers-
// snapshot.yml's names exactly.
const ALPACA_KEY_ID = process.env.ALPACA_KEY_ID;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY) {
  console.error('log-signals-warrior: ALPACA_KEY_ID / ALPACA_SECRET_KEY not set.');
  process.exit(1);
}

// engines/warrior/gate.js is a real ES module (a trailing
// `export { name1, name2, ... };` block, no top-level imports -- already
// confirmed DOM-free). Plain eval() can't parse `export` syntax; strip
// it the same way tests/warrior-index-render.test.js already does for
// this exact file, rather than reimplementing gate.js's logic as a
// second copy that could drift from the real one.
function stripExportSyntax(src) {
  return src
    .replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '')
    .replace(/^export (function|const|async function|class)/gm, '$1');
}

function loadReal(relPath, exposeNames) {
  const src = stripExportSyntax(readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
  const exposeLine = exposeNames.map(n => `global.${n} = ${n};`).join(' ');
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeLine);
}

async function main() {
  global.state = {
    settings: { alpacaKey: ALPACA_KEY_ID, alpacaSecret: ALPACA_SECRET_KEY, minVolume: 100000, includeUnder2: false },
    newsFailedSymbols: [], newsLookbackHours: null, newsUnavailable: false, newsTruncatedSymbols: [],
  };
  global.persist = () => {};
  // app.js's real VERSION const, read directly rather than duplicated --
  // a hardcoded copy here would silently drift from the real build the
  // moment app.js's own VERSION changes, defeating the entire point of
  // stamping it.
  const appSrc = readFileSync(path.join(REPO_ROOT, 'app.js'), 'utf8');
  const versionMatch = appSrc.match(/^const VERSION = '([^']+)'/m);
  global.VERSION = versionMatch ? versionMatch[1] : null;
  if (!global.VERSION) throw new Error('Could not read VERSION from app.js -- refusing to log signals with no buildVersion.');

  loadReal('core/clock.js', ['getPT', 'ptDateStr', 'ptWallClockToInstant', 'getMarketStatus', 'hoursSincePreviousClose']);
  loadReal('core/api-client.js', ['chunk', 'sanitizeTickerBatch', 'alpacaGet', '_coreClient', 'createApiClient']);
  loadReal('core/market-data.js', ['fetchSnapshots', 'getLivePrice']);
  loadReal('core/universe.js', [
    '_getAssetIndex', '_assetIndexBySymbol', '_inPriceRange', 'getUniverse',
    '_fetchCumulativeMinuteVolume', '_getSip30DayAvgVolume',
  ]);
  loadReal('core/news.js', ['fetchNewsForTickers']);

  // core/float-table.js does one relative same-origin fetch
  // ('./data/float-table.json'), which only resolves in a browser.
  // Intercepting just that one URL and serving the committed file
  // locally preserves the file's REAL logic (three-state handling,
  // staleness calc, the dilution/guard provenance fields) verbatim --
  // nothing about float-table.js's own source is touched or duplicated.
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url === './data/float-table.json') {
      const data = readFileSync(path.join(REPO_ROOT, 'data', 'float-table.json'), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(data) };
    }
    return realFetch(url, opts);
  };
  loadReal('core/float-table.js', ['getFloatDataForSymbols']);

  loadReal('engines/warrior/gate.js', ['evaluateGateBatch']);

  // ── session ── getMarketStatus() returns `.status`, not `.session`
  // (confirmed by reading core/clock.js directly after a first dry run
  // logged "session=undefined" -- would have silently mis-scheduled
  // every downstream session-dependent branch, including which universe
  // strategy runs, if trusted from the field name alone).
  const marketStatus = SESSION_OVERRIDE ? { status: SESSION_OVERRIDE } : global.getMarketStatus();
  const session = marketStatus.status;
  console.log(`log-signals-warrior: session=${session}`);

  // ── universe: committed movers-snapshot preferred, self-fetch as a
  // named, stamped fallback ──
  const scanRunId = randomUUID();
  const today = global.ptDateStr(global.getPT());
  let candidates, universeSource, universeSnapshotCapturedAt;

  const logPath = path.join(REPO_ROOT, 'data', 'movers-snapshots', 'log.jsonl');
  let committedEntry = null;
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = JSON.parse(lines[i]);
      const rowDatePt = global.ptDateStr(global.getPT(new Date(row.capturedAt)));
      if (rowDatePt === today && row.marketOpen) { committedEntry = row; break; }
    }
  }

  // MAX_COMMITTED_SNAPSHOT_AGE_MIN: how stale a committed entry can be
  // and still count as "the shared universe," not "so old this run would
  // effectively be evaluating a different morning's movers." 40 minutes
  // comfortably covers the gap between a movers-capture run and this
  // logger's own staggered offset (constraint 5), without accepting an
  // entry from hours earlier in the session as if it were current.
  const MAX_COMMITTED_SNAPSHOT_AGE_MIN = 40;
  const ageMin = committedEntry ? (Date.now() - new Date(committedEntry.capturedAt).getTime()) / 60000 : Infinity;

  if (committedEntry && ageMin <= MAX_COMMITTED_SNAPSHOT_AGE_MIN) {
    universeSource = 'committed-movers-snapshot';
    universeSnapshotCapturedAt = committedEntry.capturedAt;
    console.log(`log-signals-warrior: using committed snapshot from ${committedEntry.capturedAt} (${ageMin.toFixed(1)} min old)`);
    candidates = await moversUniverseFromRaw(committedEntry.movers, committedEntry.mostActives);
  } else {
    universeSource = 'self-fetched-fallback';
    universeSnapshotCapturedAt = new Date().toISOString();
    console.warn(`log-signals-warrior: NO usable committed snapshot (${committedEntry ? `found one but it's ${ageMin.toFixed(1)} min old, over the ${MAX_COMMITTED_SNAPSHOT_AGE_MIN}min bound` : 'none for today with marketOpen=true'}) -- falling back to a self-fetched universe via getUniverse(). This run's universe will NOT match capture-movers-snapshot's recorded one for today; stamped accordingly on every row.`);
    const strategy = session === 'PRE' ? 'premarket-gap' : 'movers';
    candidates = await global.getUniverse({ session, strategy });
  }

  console.log(`log-signals-warrior: universe = ${candidates.length} candidates (source: ${universeSource})`);

  // ── evaluate ──
  let batchResult, aborted = false, abortReason = null;
  try {
    batchResult = await global.evaluateGateBatch(candidates, session);
  } catch (e) {
    aborted = true;
    abortReason = e.message;
    console.error(`log-signals-warrior: evaluateGateBatch threw -- ${e.message}`);
    batchResult = { results: [], requests: 0, rvolCheckable: false, floatTableBuiltAt: null, floatTableStalenessDays: null };
  }
  const { results } = batchResult;
  const evaluatedCount = results.length;
  const fetchFailedCount = results.filter(r => r.pillars.some(p => p.status === 'fetch-failed')).length;

  console.log(`log-signals-warrior: evaluated ${evaluatedCount} of ${candidates.length} universe candidates, ${fetchFailedCount} with a fetch-failed pillar, aborted=${aborted}`);

  const scanRun = {
    id: scanRunId,
    engine_source: 'WARRIOR',
    session,
    scan_date: today,
    started_at: new Date().toISOString(),
    universe_source: universeSource,
    universe_snapshot_captured_at: universeSnapshotCapturedAt,
    universe_count: candidates.length,
    evaluated_count: evaluatedCount,
    fetch_failed_count: fetchFailedCount,
    aborted,
    abort_reason: abortReason,
    build_version: global.VERSION,
  };

  const candidatesBySymbol = new Map(candidates.map(c => [c.symbol, c]));
  const signalRows = results.map(r => ({
    signal_date: today,
    symbol: r.symbol,
    engine_source: 'WARRIOR',
    tier: r.tier,
    first_shown_at: new Date().toISOString(),
    scan_session: scanRunId,
    build_version: r.buildVersion || global.VERSION,
    signal_snapshot: r,
    reference_price: candidatesBySymbol.get(r.symbol)?.price ?? null,
  }));

  if (!WRITE) {
    mkdirSync(path.join(REPO_ROOT, 'data', 'signal-log-dry-runs'), { recursive: true });
    const outPath = path.join(REPO_ROOT, 'data', 'signal-log-dry-runs', `${scanRunId}.json`);
    writeFileSync(outPath, JSON.stringify({ scanRun, signalRows }, null, 2));
    console.log(`\nDRY RUN -- wrote ${signalRows.length} would-be signal_log rows + 1 scan_runs row to ${outPath}. Nothing sent to Supabase.`);
    console.log(`\nTier breakdown: ${JSON.stringify(results.reduce((acc, r) => { acc[r.tier] = (acc[r.tier] || 0) + 1; return acc; }, {}))}`);
    return;
  }

  console.log('\n--write passed -- inserting for real.');
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };

  const runRes = await fetch(`${SUPABASE_URL}/rest/v1/scan_runs`, {
    method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(scanRun),
  });
  if (runRes.status >= 300) {
    console.error(`log-signals-warrior: scan_runs insert failed -- status ${runRes.status}, body ${await runRes.text()}`);
    process.exit(1);
  }
  console.log(`log-signals-warrior: scan_runs row inserted (id=${scanRunId}).`);

  if (signalRows.length) {
    // ignore-duplicates + on_conflict on the real unique key means a
    // second run of the same scan_session (or a genuine same-day re-run
    // hitting the same signal_date/symbol/engine_source/tier) is a clean
    // no-op, not an error that would fail the job (constraint 3).
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?on_conflict=signal_date,symbol,engine_source,tier`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation,resolution=ignore-duplicates' },
      body: JSON.stringify(signalRows),
    });
    const insertedBody = await insertRes.text();
    if (insertRes.status >= 300) {
      console.error(`log-signals-warrior: signal_log insert failed -- status ${insertRes.status}, body ${insertedBody}`);
      process.exit(1);
    }
    let insertedCount = 0;
    try { insertedCount = JSON.parse(insertedBody).length; } catch { /* ignore-duplicates can return an empty body on an all-dup batch */ }
    console.log(`log-signals-warrior: signal_log insert returned status ${insertRes.status}, ${insertedCount} row(s) in the response body (duplicates against an existing (signal_date, symbol, engine_source, tier) return no row, not an error).`);

    // VERIFY BY RE-SELECTING (constraint 3), not by status code -- an
    // ignore-duplicates POST can legitimately return 201 with an empty
    // body on an all-duplicate batch, which looks identical to "nothing
    // was ever inserted" unless checked against the table directly.
    const verifyRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?scan_session=eq.${scanRunId}&select=symbol,tier`, { headers });
    const verifyBody = await verifyRes.json();
    console.log(`log-signals-warrior: re-selected ${verifyBody.length} row(s) actually present for scan_session=${scanRunId} (expected ${signalRows.length} minus any real same-day/same-tier duplicates).`);
  }
}

// Replicates core/universe.js's _getMoversUniverse merge/filter logic
// (gainers.map + actives enrichment + dedupe + price/instrument filter)
// against ALREADY-FETCHED raw movers/mostActives data instead of live-
// fetching them -- the one piece that must still be fetched fresh is
// enrichment that isn't in the committed snapshot at all (current asset
// eligibility, current snapshot price for actives rows), not the
// gainers/most_actives symbol sets themselves.
async function moversUniverseFromRaw(moversData, activesData) {
  const [assetIndex] = await Promise.all([global._getAssetIndex(global._coreClient)]);
  const assetsBySymbol = global._assetIndexBySymbol(assetIndex);

  const gainers = (moversData?.gainers || []).map(g => ({
    symbol: g.symbol, price: g.price,
    prevClose: (typeof g.price === 'number' && typeof g.change === 'number') ? g.price - g.change : null,
    changePct: typeof g.percent_change === 'number' ? g.percent_change : null,
    volume: null, source: 'movers',
  }));

  const activeRows = activesData?.most_actives || [];
  const activeSymbols = activeRows.map(a => a.symbol);
  const activeSnaps = activeSymbols.length ? await global.fetchSnapshots(activeSymbols, undefined, global._coreClient) : {};
  const actives = activeRows.map(a => {
    const snap = activeSnaps[a.symbol];
    const price = global.getLivePrice(snap) || null;
    const prevClose = snap?.prevDailyBar?.c || null;
    return {
      symbol: a.symbol, price, prevClose,
      changePct: (prevClose && price) ? ((price - prevClose) / prevClose) * 100 : null,
      volume: typeof a.volume === 'number' ? a.volume : null, source: 'actives',
    };
  });

  const merged = {};
  actives.forEach(a => { merged[a.symbol] = a; });
  gainers.forEach(g => { merged[g.symbol] = g; });
  const combined = Object.values(merged);

  const priceFiltered = combined.filter(c => global._inPriceRange(c.price));
  const instrumentFiltered = priceFiltered.filter(c => {
    const asset = assetsBySymbol[c.symbol];
    return !!(asset && asset.isEligibleInstrument);
  });

  console.log(`log-signals-warrior: (from committed snapshot) ${gainers.length} movers + ${actives.length} actives -> ${combined.length} after dedupe -> ${priceFiltered.length} in $1-$20 -> ${instrumentFiltered.length} eligible instrument`);
  return instrumentFiltered.map(c => ({ symbol: c.symbol, price: c.price, changePct: c.changePct }));
}

main().catch(e => { console.error('log-signals-warrior: FAILED', e.message, e.stack); process.exit(1); });
