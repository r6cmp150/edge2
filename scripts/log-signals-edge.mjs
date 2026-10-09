#!/usr/bin/env node
// Server-side signal logger for EDGE -- Phase 7's second engine, repeating
// the pattern scripts/log-signals-warrior.mjs already proved rather than
// inventing new architecture: same credential shim, same eval-with-real-
// globals technique, same scan_runs/signal_log write shape, same dry-run-
// first discipline.
//
// IMPORTS THE REAL SCORING PATH, not an approximation -- core/edge-
// scoring.js's real scoreStock (the 2026-09-05 extraction), not a ported
// or reimplemented copy. Same rule that made importing engines/warrior/
// gate.js (never scripts/lib/gate-classifier.mjs) matter for Warrior.
//
// NO SESSION DEPENDENCY, checked directly before writing anything here,
// not assumed by analogy to Warrior: grepped core/edge-scoring.js for
// session/getMarketStatus/elapsedMinutes -- zero hits. scoreStock takes
// already-fetched snapshot/bars/news/spyChange as plain arguments and has
// no RVOL-style "N minutes since open" gate anywhere in its own logic.
// The live app's only session-conditional branch in runScreener()
// (app.js) is an OPTIONAL pre-market-movers side computation, not a gate
// on scoring itself. This means EDGE's schedule is free to run at
// different offsets than Warrior's -- it isn't waiting on anything
// analogous to RVOL becoming checkable -- though scoring during real
// market-closed hours still reflects stale prior-close data, a
// data-freshness consideration, not a structural gate.
//
// UNIVERSE: STOCK_UNIVERSES.OTHER from app.js (239 tickers, confirmed by
// direct count) -- the app's own default category, matching what a real
// scan shows before Roman picks a narrower one. Extracted from app.js by
// exact line-range with boundary-text verification (same discipline as
// the original core/edge-scoring.js extraction script), not re-typed --
// a transcription error in a 239-ticker literal would be exactly the
// kind of silent, hard-to-notice defect this project keeps finding.
//
// TIER VOCABULARY IS EDGE'S OWN, not forced into Warrior's shape:
// SHOWN / BELOW_THRESHOLD / NOT_EVALUATED, exactly matching the split
// app.js's own runScreener() already computes (scoredAll, 2026-09-05 --
// "EDGE's equivalent of the gap classifyGate's NOT_EVALUATED/REJECTED
// split closes for Warrior"). engine_source='EDGE' distinguishes the
// rows in a shared table; the tier VALUES don't need to match across
// engines, and forcing them to would make a meaningless comparison look
// meaningful.
//
// WARNING FOR ANYONE QUERYING signal_log ACROSS BOTH ENGINES (2026-09-10,
// found the first night both loggers had real output side by side):
// SHOWN and QUALIFIED are not the same question and their raw counts must
// never be compared as "signals produced." SHOWN means a score cleared a
// display threshold -- one number, one comparison. QUALIFIED means five
// pillars were evaluated and every checkable one passed -- a
// structurally different, stricter claim. The first real numbers from
// both loggers the same night were EDGE 42 SHOWN of 48 scored vs. Warrior
// 3 QUALIFIED of 28 -- reading that as "EDGE produces 14x the signals"
// is exactly the wrong-comparison this warning exists to prevent. The
// engines can only be compared on OUTCOMES of signals actually acted on,
// or on like-for-like selectivity at a matched threshold -- never on raw
// tier counts. Full treatment is a Phase 8 report-spec concern, not a
// logger concern; this paragraph exists so whoever queries these tables
// first reads the warning at the source, before publishing a number.
//
// KNOWN, FLAGGED GAP -- not hidden: macroContext defaults to null here
// (no macro-condition adjustment), not fetched for real. fetchMacroContext/
// classifyMacroCondition live in app.js's DOM-adjacent code, not a clean
// core/*.js file, and null is a REAL state the live app already falls
// back to on a fetch failure ("Failure is non-fatal: scoring/UI just
// treat a null macroContext as no adjustment") -- so this defaults to an
// already-supported degraded state, not a fudge of scoreStock's own
// logic, which is fully real and unmodified. Flagged here for a decision,
// not decided silently: wire the real fetch in if it's worth the added
// app.js-extraction surface.
//
// SCAN COMPLETENESS: scan_runs gets the same accounting as Warrior --
// universe_count (239, the full list), evaluated_count (however many
// passed the price/volume pre-filter and reached scoreStock -- the same
// pre-filter runScreener() itself applies before scoring, not a bug
// introduced here), fetch_failed_count (bars fetches that failed,
// fetchMultiBars' own droppedSymbols), aborted/abort_reason. A ticker
// that fails the pre-filter gets no signal_log row at all, by explicit
// design (three tiers only, not a fourth "filtered" tier) -- the
// universe_count/evaluated_count gap is where that fact lives instead.
//
// SETUP_TRIGGERS: left untouched for EDGE. EDGE has no setup concept --
// no rows written, not an empty analogue invented to look symmetrical
// with Warrior.
//
// SCHEMA GAP FOUND WHILE WRITING THIS (not yet fixed -- needs its own
// migration before --write, flagged here so it isn't discovered at write
// time): db/010's scan_runs.universe_source has a CHECK constraint
// limited to ('committed-movers-snapshot', 'self-fetched-fallback') --
// both Warrior-specific concepts (a live screener call, one way or the
// other). EDGE has neither -- it always reads a static ticker list, not
// a live-fetched universe. This script stamps 'static-universe-list' for
// EDGE's scan_runs rows, which the current CHECK constraint would REJECT
// on a real --write attempt. Needs the constraint widened (db/014) before
// EDGE's write path can go live; harmless for dry runs, which never touch
// Supabase.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertColumnsExist } from './lib/schema-check.mjs';
import { reportNoop } from './lib/workflow-instrumentation.mjs';
import { scheduledScanGate, SPACING_MIN } from './lib/scan-gate.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WRITE = process.argv.includes('--write');

const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';

const ALPACA_KEY_ID = process.env.ALPACA_KEY_ID;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY) {
  console.error('log-signals-edge: ALPACA_KEY_ID / ALPACA_SECRET_KEY not set.');
  process.exit(1);
}

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

// Extracts a block from app.js by TEXT ANCHOR and evals it in isolation.
// Was a fixed line range (2026-10-08: a4af74a added two comment lines above
// BASE_SCORE_THRESHOLD, the pinned range missed by 2, and every EDGE run
// crashed until the numbers were hand-bumped). Now: the block starts at the
// ONE line exactly equal to expectedFirst (zero or several matches throws --
// never guess), and ends at the first line after it exactly equal to
// expectedLast. Unrelated app.js edits no longer break this; a change to the
// anchor line itself (e.g. the threshold value) still throws, which is the
// point -- that's a scoring change a human should look at before the logger
// keeps running. A wrong end line can't slip through silently either: the
// expose line below references every name, so a short cut throws a
// ReferenceError.
function loadFromAppJs(appJsSrc, expectedFirst, expectedLast, exposeNames) {
  const lines = appJsSrc.split('\n').map(l => l.replace(/\r$/, ''));
  const starts = [];
  lines.forEach((l, i) => { if (l === expectedFirst) starts.push(i); });
  if (starts.length !== 1) {
    throw new Error(`app.js anchor ${JSON.stringify(expectedFirst)} found ${starts.length} times (expected exactly 1)${starts.length ? ' at lines ' + starts.map(i => i + 1).join(', ') : ''}.`);
  }
  const startIdx = starts[0];
  const endIdx = lines.findIndex((l, i) => i > startIdx && l === expectedLast);
  if (endIdx === -1) {
    throw new Error(`app.js end marker ${JSON.stringify(expectedLast)} not found after anchor ${JSON.stringify(expectedFirst)} (line ${startIdx + 1}).`);
  }
  console.log(`log-signals-edge: app.js ${JSON.stringify(expectedFirst)} -> lines ${startIdx + 1}-${endIdx + 1}`);
  const block = lines.slice(startIdx, endIdx + 1).join('\n');
  const exposeLine = exposeNames.map(n => `global.${n} = ${n};`).join(' ');
  // eslint-disable-next-line no-eval
  eval(block + '\n' + exposeLine);
}

async function main() {
  global.state = {
    settings: { alpacaKey: ALPACA_KEY_ID, alpacaSecret: ALPACA_SECRET_KEY, minVolume: 100000, includeUnder2: false, disableMacroOverlay: false },
    macroContext: null, // KNOWN GAP -- see header comment
    ownedScores: {},
    portfolio: [],
  };
  global.persist = () => {};

  const appJsSrc = readFileSync(path.join(REPO_ROOT, 'app.js'), 'utf8');
  const versionMatch = appJsSrc.match(/const VERSION = '([^']+)'/);
  if (!versionMatch) throw new Error('Could not read VERSION from app.js -- refusing to log signals with no buildVersion.');
  global.VERSION = versionMatch[1];

  loadReal('core/clock.js', ['getPT', 'ptDateStr', 'getMarketStatus', 'hoursSincePreviousClose', 'classifySession']);
  loadReal('core/api-client.js', ['chunk', 'sanitizeTickerBatch', 'alpacaGet', '_coreClient', 'createApiClient', 'assertPageNotSuspiciouslyFull']);
  loadReal('core/market-data.js', ['fetchSnapshots', 'getLivePrice', 'HISTORICAL_BAR_ADJUSTMENT', 'fetchMultiBars', 'checkUnresolvedSymbols']);
  loadReal('core/news.js', ['fetchNewsForTickers']);
  loadReal('core/indicators.js', ['calcRSI', 'calcATR', 'calcTrimmedATR', 'calcMA', 'calcAvgVolume']);
  loadReal('core/edge-scoring.js', ['scoreStock']);

  // STOCK_UNIVERSES -- text-anchored, see loadFromAppJs.
  loadFromAppJs(appJsSrc, 'const STOCK_UNIVERSES = {', '};', ['STOCK_UNIVERSES']);
  const TICKERS = global.STOCK_UNIVERSES.OTHER;

  // Display-threshold logic -- text-anchored, see loadFromAppJs.
  loadFromAppJs(appJsSrc,
    'const BASE_SCORE_THRESHOLD = 29;', '}',
    ['BASE_SCORE_THRESHOLD', 'ELEVATED_SCORE_THRESHOLD', 'SECTOR_WEAKNESS_THRESHOLD_CATEGORIES', 'BROAD_ELEVATED_CONDITIONS', 'getDisplayThreshold']);

  const marketStatus = global.getMarketStatus();
  const session = marketStatus.status;
  console.log(`log-signals-edge: session=${session}`);

  // ── Scheduled-scan gate (2026-10-09) ──
  // Was a fixed-target window (see git history); replaced because GitHub
  // delivers these crons hours late and the window turned almost every
  // firing into a silent exit-0 no-op. Rule and rationale live in
  // scripts/lib/scan-gate.mjs: scan iff the regular session is open and
  // no EDGE scan_runs row started in the last SPACING_MIN minutes.
  // Applies ONLY to a real scheduled firing -- a manual workflow_dispatch
  // always runs, for testing/debugging.
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    const gate = await scheduledScanGate({
      engineSource: 'EDGE', getPT: global.getPT, ptDateStr: global.ptDateStr,
      classifySession: global.classifySession, supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY,
    });
    if (!gate.proceed) {
      console.log(`log-signals-edge: ${gate.reason} (minutesSinceOpen=${gate.minutesSinceOpen}). No-op: no scan_runs row written, no Alpaca request made.`);
      reportNoop(gate.reason);
      return;
    }
    console.log(`log-signals-edge: scheduled firing at ${gate.hhmm} PT, minutesSinceOpen=${gate.minutesSinceOpen}, regular session open, no EDGE scan in the last ${SPACING_MIN} min -- proceeding with a real scan.`);
  }

  const scanRunId = randomUUID();
  const today = global.ptDateStr(global.getPT());

  console.log(`log-signals-edge: universe = ${TICKERS.length} candidates (source: static-universe-list, STOCK_UNIVERSES.OTHER)`);

  const snapshots = await global.fetchSnapshots(TICKERS);
  global.checkUnresolvedSymbols(TICKERS, snapshots);

  const minVol = global.state.settings.minVolume || 100000;
  const minPrice = 1; // matches app.js runScreener's own minPrice (both ternary branches evaluate to 1 there -- replicated as-is, not fixed here, since changing live EDGE filter behavior wasn't asked for)
  const candidates = Object.entries(snapshots).filter(([, snap]) => {
    const p = global.getLivePrice(snap);
    const v = snap.dailyBar?.v || 0;
    return p >= minPrice && p <= 20 && v >= minVol;
  });

  const ctickers = candidates.map(([t]) => t);
  const { results: allBars, droppedSymbols: barsDroppedSymbols } = await global.fetchMultiBars(ctickers, 10000);
  const newsItems = await global.fetchNewsForTickers(ctickers);
  const newsMap = {};
  newsItems.forEach(n => {
    (n.symbols || []).forEach(sym => { if (!newsMap[sym]) newsMap[sym] = n; });
  });

  let spyChangePct = 0;
  try {
    const spySnap = await global.fetchSnapshots(['SPY']);
    const spy = spySnap['SPY'];
    if (spy) {
      const spyP = global.getLivePrice(spy);
      const spyPrev = spy.prevDailyBar?.c || spyP;
      spyChangePct = spyPrev > 0 ? ((spyP - spyPrev) / spyPrev) * 100 : 0;
    }
  } catch (e) { console.warn(`log-signals-edge: SPY snapshot fetch failed: ${e.message}`); }

  const category = 'OTHER';
  const macroCondition = global.state.macroContext?.condition || null;
  const displayThreshold = global.getDisplayThreshold(macroCondition, category);
  const minP2 = global.state.settings.includeUnder2 ? 0 : 2;

  const scoredAll = candidates.map(([ticker, snap]) => {
    const bars = allBars[ticker] || [];
    const s = global.scoreStock(ticker, snap, bars, newsMap[ticker] || null, spyChangePct, category);
    if (s) {
      s.thresholdAtBuy = displayThreshold;
      s.buildVersion = global.VERSION;
    }
    const shown = !!s && s.score >= displayThreshold && s.price >= minP2;
    return { ticker, signal: s, shown, tier: s ? (shown ? 'SHOWN' : 'BELOW_THRESHOLD') : 'NOT_EVALUATED' };
  });

  const tierCounts = scoredAll.reduce((acc, r) => { acc[r.tier] = (acc[r.tier] || 0) + 1; return acc; }, {});
  console.log(`log-signals-edge: evaluated ${scoredAll.length} of ${TICKERS.length} universe candidates (${TICKERS.length - candidates.length} excluded by the price/volume pre-filter, not scored, not logged -- three tiers only, per spec), ${barsDroppedSymbols.length} with a bars-fetch failure.`);
  console.log(`Tier breakdown: ${JSON.stringify(tierCounts)}`);

  const scanRun = {
    id: scanRunId,
    engine_source: 'EDGE',
    session,
    scan_date: today,
    started_at: new Date().toISOString(),
    universe_source: 'static-universe-list', // db/014 widens the CHECK constraint to allow this
    universe_snapshot_captured_at: null, // no live screener snapshot concept for EDGE's static list
    // universe_detail (db/014): WHICH static list, not just that it's
    // static -- currently STOCK_UNIVERSES.OTHER, a known open item that
    // may change mid-test (e.g. widened to the full eligible set). If it
    // ever does, rows before and after carry a different value here
    // rather than being silently pooled as equivalent.
    universe_detail: `STOCK_UNIVERSES.OTHER (${TICKERS.length} tickers)`,
    universe_count: TICKERS.length,
    // prefiltered_count (db/014): explicit, not implied. universe_count -
    // prefiltered_count = evaluated_count is the same completeness
    // identity Warrior's rows satisfy with prefiltered_count=0 -- for
    // EDGE it's the count the price/volume pre-filter excluded before
    // scoreStock ever ran, a real structural fact, not a failure.
    prefiltered_count: TICKERS.length - candidates.length,
    evaluated_count: scoredAll.length,
    fetch_failed_count: barsDroppedSymbols.length,
    aborted: false,
    abort_reason: null,
    build_version: global.VERSION,
  };

  const signalRows = scoredAll.map(r => ({
    signal_date: today,
    symbol: r.ticker,
    engine_source: 'EDGE',
    tier: r.tier,
    first_shown_at: new Date().toISOString(),
    scan_session: scanRunId,
    build_version: global.VERSION,
    signal_snapshot: r.signal || { ticker: r.ticker, tier: r.tier },
    reference_price: global.getLivePrice(snapshots[r.ticker]) ?? null,
  }));

  // schema-check (see scripts/lib/schema-check.mjs): runs on every
  // dispatch, dry-run included -- a dry run never contacts Supabase
  // otherwise, which is exactly how db/014's gap sat invisible through two
  // successful EDGE dry runs before the first real --write hit it.
  await assertColumnsExist(SUPABASE_URL, SUPABASE_ANON_KEY, 'scan_runs', Object.keys(scanRun));
  await assertColumnsExist(SUPABASE_URL, SUPABASE_ANON_KEY, 'signal_log', [
    'signal_date', 'symbol', 'engine_source', 'tier', 'first_shown_at',
    'scan_session', 'build_version', 'signal_snapshot', 'reference_price',
  ]);

  if (!WRITE) {
    mkdirSync(path.join(REPO_ROOT, 'data', 'signal-log-dry-runs'), { recursive: true });
    const outPath = path.join(REPO_ROOT, 'data', 'signal-log-dry-runs', `${scanRunId}.json`);
    writeFileSync(outPath, JSON.stringify({ scanRun, signalRows }, null, 2));
    console.log(`\nDRY RUN -- wrote ${signalRows.length} would-be signal_log rows + 1 scan_runs row to ${outPath}. Nothing sent to Supabase.`);
    return;
  }

  console.log('\n--write passed -- inserting for real.');
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };

  const runRes = await fetch(`${SUPABASE_URL}/rest/v1/scan_runs`, {
    method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(scanRun),
  });
  if (runRes.status >= 300) {
    console.error(`log-signals-edge: scan_runs insert failed -- status ${runRes.status}, body ${await runRes.text()}`);
    process.exit(1);
  }
  console.log(`log-signals-edge: scan_runs row inserted (id=${scanRunId}).`);

  if (signalRows.length) {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?on_conflict=signal_date,symbol,engine_source,tier`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation,resolution=ignore-duplicates' },
      body: JSON.stringify(signalRows),
    });
    const insertedBody = await insertRes.text();
    if (insertRes.status >= 300) {
      console.error(`log-signals-edge: signal_log insert failed -- status ${insertRes.status}, body ${insertedBody}`);
      process.exit(1);
    }
    let insertedCount = 0;
    try { insertedCount = JSON.parse(insertedBody).length; } catch { /* ignore-duplicates can return an empty body on an all-dup batch */ }
    console.log(`log-signals-edge: signal_log insert returned status ${insertRes.status}, ${insertedCount} row(s) in the response body (duplicates against an existing (signal_date, symbol, engine_source, tier) return no row, not an error).`);

    const verifyRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?scan_session=eq.${scanRunId}&select=symbol,tier`, { headers });
    const verifyBody = await verifyRes.json();
    console.log(`log-signals-edge: re-selected ${verifyBody.length} row(s) actually present for scan_session=${scanRunId} (expected ${signalRows.length} minus any real same-day/same-tier duplicates).`);
  }
}

main().catch(e => { console.error('log-signals-edge: FAILED', e.message, e.stack); process.exit(1); });
