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
//
// WARNING FOR ANYONE QUERYING signal_log ACROSS BOTH ENGINES (2026-09-10,
// found the first night both loggers had real output side by side):
// QUALIFIED and EDGE's SHOWN are not the same question and their raw
// counts must never be compared as "signals produced." QUALIFIED means
// five pillars were evaluated and every checkable one passed -- a
// structurally strict claim. SHOWN means a score cleared a display
// threshold -- a different, looser one. The first real numbers from both
// loggers the same night were Warrior 3 QUALIFIED of 28 vs. EDGE 42 SHOWN
// of 48 -- reading that as "EDGE produces 14x the signals" is exactly the
// wrong-comparison this warning exists to prevent. The engines can only
// be compared on OUTCOMES of signals actually acted on, or on
// like-for-like selectivity at a matched threshold -- never on raw tier
// counts. Full treatment is a Phase 8 report-spec concern, not a logger
// concern; this paragraph exists so whoever queries these tables first
// reads the warning at the source, before publishing a number.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertColumnsExist } from './lib/schema-check.mjs';

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

  // assertPageNotSuspiciouslyFull/HISTORICAL_BAR_ADJUSTMENT (2026-09-10,
  // found live on the first real OPEN-session run): both were added to
  // their files on 2026-09-01, before this script existed, and core/
  // universe.js's RVOL fetchers (_getSip30DayAvgVolume,
  // _fetchCumulativeMinuteVolume's minute-bar path) reference them as bare
  // ambient globals, matching the real browser's shared-script-scope
  // behavior -- but loadReal's exposure is per-name, per-file, not
  // automatic, so a name genuinely used cross-file has to be listed
  // explicitly at BOTH the defining file's loadReal call, same as anything
  // else this harness exposes. Invisible until now because RVOL is
  // session-gated (rvolCheckable requires session==='OPEN') and every dry
  // run before this one was CLOSED or PRE -- the exact code path that uses
  // these names had never actually run under this harness before. Same
  // failure shape as core/edge-scoring.js's extraction verification and
  // the EDGAR CORS gap: a Node harness proves the code it exercises, not
  // the code it doesn't reach.
  loadReal('core/clock.js', ['getPT', 'ptDateStr', 'ptWallClockToInstant', 'getMarketStatus', 'hoursSincePreviousClose']);
  loadReal('core/api-client.js', ['chunk', 'sanitizeTickerBatch', 'alpacaGet', '_coreClient', 'createApiClient', 'assertPageNotSuspiciouslyFull']);
  loadReal('core/market-data.js', ['fetchSnapshots', 'getLivePrice', 'HISTORICAL_BAR_ADJUSTMENT']);
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

  // ── DST no-op check + once-per-target dedup ──
  // (2026-09-10, explicit ask; EXTENDED 2026-09-11 after the six-entry
  // paired schedule's own assumption broke live -- GitHub delivered every
  // scheduled firing hours late and clustered together, collapsing three
  // intended moments into a window where only one landed inside tolerance
  // by chance. See .github/workflows/log-signals-warrior.yml's header for
  // the full incident and the fix: a dense schedule (every 15 min across
  // the whole trading window) replaces trying to fire at the right
  // moment, and this same tolerance check now also has to guard against
  // the new possibility that DENSITY introduces -- more than one firing
  // landing inside the same target's window.
  //
  // Applies ONLY to a real scheduled firing (GITHUB_EVENT_NAME==='schedule')
  // -- a manual workflow_dispatch (testing, or Roman/Claude checking
  // something by hand) always runs regardless of clock time, same as
  // --session= already bypasses session detection for exactly that reason.
  //
  // Tolerance is explicit, not implicit in an inequality: a firing counts
  // as "on time" if it lands within TOLERANCE_MIN minutes of one of the
  // three intended offsets from open, or the one intended offset before
  // close. Targets: 20 min after open (opening momentum), 105 min after
  // open (mid-morning), 60 min before close (late-session).
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    const TOLERANCE_MIN = 10;
    const TARGETS = [
      { name: 'open+20', kind: 'afterOpen', offset: 20 },
      { name: 'open+105', kind: 'afterOpen', offset: 105 },
      { name: 'close-60', kind: 'beforeClose', offset: 60 },
    ];
    function minutesFromTarget(target, sinceOpen, toClose) {
      return target.kind === 'afterOpen' ? sinceOpen - target.offset : toClose - target.offset;
    }
    const pt = global.getPT();
    const tMin = pt.getHours() * 60 + pt.getMinutes();
    const minutesSinceOpen = tMin - 390; // 390 = 6:30am PT = 9:30am ET, same convention as gate.js's _elapsedSessionMinutes
    const minutesToClose = 780 - tMin;   // 780 = 1:00pm PT = 4:00pm ET

    const matched = TARGETS.find(t => Math.abs(minutesFromTarget(t, minutesSinceOpen, minutesToClose)) <= TOLERANCE_MIN);
    if (!matched) {
      console.log(`log-signals-warrior: scheduled firing at minutesSinceOpen=${minutesSinceOpen}, minutesToClose=${minutesToClose} doesn't land within ${TOLERANCE_MIN} minutes of any intended target (open+20, open+105, close-60). No-op: no scan_runs row written, no Alpaca request made.`);
      return;
    }

    // Once-per-target dedup -- new requirement a dense schedule
    // introduces that three widely-spaced entries never needed. Recompute
    // each EXISTING row's own minutesSinceOpen/minutesToClose from ITS
    // OWN started_at (never "now") -- an earlier run's own delay doesn't
    // matter here, only where IT actually landed relative to open/close
    // on its own clock. This is a Supabase read, not an Alpaca request --
    // still zero cost against the rate-limit queue, and only reached at
    // all once a target has already matched (the common no-match no-op
    // above returns before this, unchanged).
    const todayStr = global.ptDateStr(pt);
    const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/scan_runs?engine_source=eq.WARRIOR&scan_date=eq.${todayStr}&select=started_at`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (existingRes.status >= 300) throw new Error(`log-signals-warrior: dedup check failed -- could not read today's existing scan_runs: ${existingRes.status} ${await existingRes.text()}`);
    const existingRuns = await existingRes.json();
    const alreadySatisfied = existingRuns.some(row => {
      const rowPt = global.getPT(new Date(row.started_at));
      const rowMin = rowPt.getHours() * 60 + rowPt.getMinutes();
      return Math.abs(minutesFromTarget(matched, rowMin - 390, 780 - rowMin)) <= TOLERANCE_MIN;
    });
    if (alreadySatisfied) {
      console.log(`log-signals-warrior: target ${matched.name} was already satisfied by an earlier scan_runs row today -- no-op, no duplicate scan, no Alpaca request made.`);
      return;
    }
    console.log(`log-signals-warrior: scheduled firing matched target ${matched.name} (minutesSinceOpen=${minutesSinceOpen}, minutesToClose=${minutesToClose}), not yet satisfied today -- proceeding with a real scan.`);
  }

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
  // This catch recording `aborted: true` and completing (exit 0) is
  // correct ONLY for a genuine operational failure -- e.g. Alpaca fully
  // unreachable -- which is exactly db/010's own design intent (record the
  // abort as data, don't crash the job over something outside our
  // control). It must NOT also catch a bug in our own code and complete
  // quietly (found live 2026-09-10: two ReferenceErrors from missing
  // Node-harness globals never even reached this far, since
  // core/universe.js's per-batch catches degraded them into fetch-failed
  // pillars first -- but if that inner guard were ever bypassed, or a
  // future bug threw from somewhere else in evaluateGateBatch, this catch
  // would silently absorb it exactly the same way and the job would still
  // report success). Same rethrow rule as core/universe.js's
  // _rethrowIfProgrammerError: ReferenceError/TypeError/SyntaxError are
  // never a real Alpaca condition, so re-throwing them here can't
  // misclassify a genuine outage -- it propagates to main().catch() below
  // and exits 1, failing the job loudly instead of recording a quiet abort.
  let batchResult, aborted = false, abortReason = null;
  try {
    batchResult = await global.evaluateGateBatch(candidates, session);
  } catch (e) {
    if (e instanceof ReferenceError || e instanceof TypeError || e instanceof SyntaxError) throw e;
    aborted = true;
    abortReason = e.message;
    console.error(`log-signals-warrior: evaluateGateBatch threw -- ${e.message}`);
    // requests: null, not 0 -- evaluateGateBatch threw before returning
    // its own count, so the real number of requests made before the
    // throw is genuinely unknown, not zero. Same rule as request_count's
    // own column comment (db/015): unmeasured is null, not a default.
    batchResult = { results: [], requests: null, rvolCheckable: false, floatTableBuiltAt: null, floatTableStalenessDays: null };
  }
  const { results, requests } = batchResult;
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
    // prefiltered_count (db/014): 0 for every Warrior row, including
    // every one already written before this column existed (the default
    // is correct, not just convenient) -- Warrior has no pre-filter stage
    // between universe and gate evaluation, every universe candidate gets
    // a real gate result. Explicit here so universe_count - prefiltered_count
    // = evaluated_count is the same completeness identity both engines
    // satisfy, rather than an implicit assumption that only holds for one
    // of them. See db/014 and log-signals-edge.mjs for the EDGE side,
    // where this is genuinely nonzero (the price/volume pre-filter).
    prefiltered_count: 0,
    evaluated_count: evaluatedCount,
    fetch_failed_count: fetchFailedCount,
    // request_count (db/015): the real Alpaca request cost of this run,
    // previously computed by evaluateGateBatch and discarded here. Null
    // on an aborted run (see the batchResult fallback above), not 0.
    request_count: requests,
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
    // universe_rank (db/018): 1-based position in Alpaca's own returned
    // order (movers by % change, actives by volume; movers wins on
    // overlap, same rule as the rest of the row) -- null only if this
    // candidate's own rank was somehow never captured upstream, not a
    // default standing in for "didn't check."
    universe_rank: candidatesBySymbol.get(r.symbol)?.rank ?? null,
  }));

  // setup_triggers (db/013, 2026-09-10): superseded armed_setup_id, which
  // was dropped from signal_log the same day it was added -- that column
  // could only ever record the FIRST sighting of a QUALIFIED symbol that
  // day, and signal_log's dedup key (signal_date, symbol, engine_source,
  // tier) discards every later insert for the same symbol/tier/day, so a
  // setup that fired between two scans would never get recorded: the
  // measurement could only drift pessimistic, silently, and forever.
  //
  // One row per real trigger EVENT, keyed (signal_date, symbol,
  // engine_source, setup_id, triggered_at) -- triggered_at is the bar
  // that fired (a fact about the market), scan_session is which run
  // observed it (a fact about us). The gap between them is observation
  // lag, and recording both is what lets a later query answer "is three
  // scans a day enough" empirically instead of by argument. The dedup
  // key's own correctness falls out for free: the SAME trigger seen by
  // two different scans carries the same triggered_at and collides into
  // one row; a genuine re-arm carries a new triggered_at and gets its
  // own row -- no special-casing needed in this script.
  const setupTriggerRows = results
    .filter(r => r.primarySetup)
    .map(r => ({
      signal_date: today,
      symbol: r.symbol,
      engine_source: 'WARRIOR',
      setup_id: r.primarySetup.id,
      triggered_at: r.primarySetup.triggeredAt,
      scan_session: scanRunId,
    }));

  // schema-check (see scripts/lib/schema-check.mjs): runs on every
  // dispatch, dry-run included -- the same gap on the EDGE side sat
  // invisible through two successful dry runs because dry-run mode never
  // contacts Supabase otherwise.
  // signal_log: derived from the real row shape (Object.keys(signalRows[0]))
  // rather than a hardcoded list -- found live (2026-09-12, adding
  // universe_rank): a hardcoded list here silently missed the new field
  // entirely, so a --write attempt before db/018 landed would have
  // reached PostgREST's own generic error instead of this check's named,
  // actionable one. A hardcoded fallback list only matters on a quiet day
  // with zero candidates, where there's no real row to derive from and
  // nothing about to be inserted anyway.
  await assertColumnsExist(SUPABASE_URL, SUPABASE_ANON_KEY, 'scan_runs', Object.keys(scanRun));
  await assertColumnsExist(SUPABASE_URL, SUPABASE_ANON_KEY, 'signal_log', signalRows.length ? Object.keys(signalRows[0]) : [
    'signal_date', 'symbol', 'engine_source', 'tier', 'first_shown_at',
    'scan_session', 'build_version', 'signal_snapshot', 'reference_price', 'universe_rank',
  ]);
  await assertColumnsExist(SUPABASE_URL, SUPABASE_ANON_KEY, 'setup_triggers', [
    'signal_date', 'symbol', 'engine_source', 'setup_id', 'triggered_at', 'scan_session',
  ]);

  if (!WRITE) {
    mkdirSync(path.join(REPO_ROOT, 'data', 'signal-log-dry-runs'), { recursive: true });
    const outPath = path.join(REPO_ROOT, 'data', 'signal-log-dry-runs', `${scanRunId}.json`);
    writeFileSync(outPath, JSON.stringify({ scanRun, signalRows, setupTriggerRows }, null, 2));
    console.log(`\nDRY RUN -- wrote ${signalRows.length} would-be signal_log rows, ${setupTriggerRows.length} would-be setup_triggers rows, + 1 scan_runs row to ${outPath}. Nothing sent to Supabase.`);
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

  if (setupTriggerRows.length) {
    const triggerInsertRes = await fetch(`${SUPABASE_URL}/rest/v1/setup_triggers?on_conflict=signal_date,symbol,engine_source,setup_id,triggered_at`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation,resolution=ignore-duplicates' },
      body: JSON.stringify(setupTriggerRows),
    });
    const triggerInsertedBody = await triggerInsertRes.text();
    if (triggerInsertRes.status >= 300) {
      console.error(`log-signals-warrior: setup_triggers insert failed -- status ${triggerInsertRes.status}, body ${triggerInsertedBody}`);
      process.exit(1);
    }
    let triggerInsertedCount = 0;
    try { triggerInsertedCount = JSON.parse(triggerInsertedBody).length; } catch { /* ignore-duplicates can return an empty body on an all-dup batch */ }
    console.log(`log-signals-warrior: setup_triggers insert returned status ${triggerInsertRes.status}, ${triggerInsertedCount} row(s) in the response body (a trigger already recorded under the same triggered_at returns no row, not an error).`);

    const triggerVerifyRes = await fetch(`${SUPABASE_URL}/rest/v1/setup_triggers?scan_session=eq.${scanRunId}&select=symbol,setup_id,triggered_at`, { headers });
    const triggerVerifyBody = await triggerVerifyRes.json();
    console.log(`log-signals-warrior: re-selected ${triggerVerifyBody.length} setup_triggers row(s) actually present for scan_session=${scanRunId} (expected ${setupTriggerRows.length} minus any real same-day/same-setup/same-timestamp duplicates).`);
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

  // rank: same reasoning as core/universe.js's _getMoversUniverse (this
  // function is that one's parallel implementation for the committed-
  // snapshot path, not a caller of it) -- 1-based position in Alpaca's own
  // returned order, captured here because the raw committed entry still
  // has it and the very next line used to throw it away regardless.
  const gainers = (moversData?.gainers || []).map((g, i) => ({
    symbol: g.symbol, price: g.price,
    prevClose: (typeof g.price === 'number' && typeof g.change === 'number') ? g.price - g.change : null,
    changePct: typeof g.percent_change === 'number' ? g.percent_change : null,
    volume: null, source: 'movers', rank: i + 1,
  }));

  const activeRows = activesData?.most_actives || [];
  const activeSymbols = activeRows.map(a => a.symbol);
  const activeSnaps = activeSymbols.length ? await global.fetchSnapshots(activeSymbols, undefined, global._coreClient) : {};
  const actives = activeRows.map((a, i) => {
    const snap = activeSnaps[a.symbol];
    const price = global.getLivePrice(snap) || null;
    const prevClose = snap?.prevDailyBar?.c || null;
    return {
      symbol: a.symbol, price, prevClose,
      changePct: (prevClose && price) ? ((price - prevClose) / prevClose) * 100 : null,
      volume: typeof a.volume === 'number' ? a.volume : null, source: 'actives', rank: i + 1,
    };
  });

  // movers wins on overlap, same rule and same reason as core/universe.js
  // -- rank follows for free, whichever object wins the merge.
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
  // FOUND LIVE (2026-09-12, adding rank): this final map already threw
  // away everything except symbol/price/changePct once before -- rank
  // would have been silently lost here even after being captured above if
  // this line weren't also fixed. Whatever the row-building step actually
  // needs from a candidate belongs in this object; check here first
  // before assuming an upstream capture survives to the caller.
  return instrumentFiltered.map(c => ({ symbol: c.symbol, price: c.price, changePct: c.changePct, rank: c.rank }));
}

main().catch(e => { console.error('log-signals-warrior: FAILED', e.message, e.stack); process.exit(1); });
