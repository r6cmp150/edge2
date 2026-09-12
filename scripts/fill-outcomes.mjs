#!/usr/bin/env node
// Outcome-filling job -- Phase 8, signal_log slice only (this pass).
// Fills signal_log.ret_5m..ret_5d (from reference_price/first_shown_at,
// per db/016's column comments) and signal_log.taken_resolution/
// matched_trade_id (per db/016's five-state design). trades_v2's
// sell-timing columns are a deferred second pass -- see db/017's header.
//
// CREDENTIAL: reads via the public anon key (signal_log/trades_v2 are
// both anon-selectable); writes via the outcome_filler role's JWT
// (OUTCOME_FILLER_JWT), verified end-to-end against production in
// scripts/test-outcome-filler-role-production.mjs before this script
// was written. Dry-run mode needs no write credential at all -- it never
// contacts anything but the anon-key read paths and Alpaca.
//
// NULL, NOT ZERO, THROUGHOUT: a return/price is only ever written when a
// real bar was found for the target moment. If a column's window hasn't
// elapsed yet, or a bar genuinely can't be found once it has (halt,
// delisting, gap), that column is simply left out of this run's PATCH --
// identical in the database to "not yet attempted," which is the honest
// state. There is no code path that computes a return from a missing
// price and defaults it to 0.
//
// IDEMPOTENT BY CONSTRUCTION: only rows with at least one null ret_*
// column or taken_resolution='unresolved' are ever queried (reusing
// signal_log_pending_outcomes_idx / signal_log_unresolved_taken_idx from
// db/001 and db/016), and a PATCH only ever includes columns that are
// CURRENTLY null and newly computable this run. A column already filled
// is never re-selected as a candidate, let alone rewritten.
//
// FAILS LOUD: ReferenceError/TypeError/SyntaxError propagate to
// main().catch() and exit 1, same rethrow discipline as both loggers --
// a bug in this script's own code must not be swallowed as "no rows were
// fillable today."
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertColumnsExist } from './lib/schema-check.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WRITE = process.argv.includes('--write');

const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';

const ALPACA_KEY_ID = process.env.ALPACA_KEY_ID;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY) {
  console.error('fill-outcomes: ALPACA_KEY_ID / ALPACA_SECRET_KEY not set.');
  process.exit(1);
}

let OUTCOME_FILLER_JWT = null;
if (WRITE) {
  OUTCOME_FILLER_JWT = process.env.OUTCOME_FILLER_JWT;
  if (!OUTCOME_FILLER_JWT) {
    console.error('fill-outcomes: --write requires OUTCOME_FILLER_JWT to be set.');
    process.exit(1);
  }
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

// ACTIONABLE_TIER_RANK: per-engine tiers Roman could actually act on, best
// first. A tier absent from its engine's map is non-actionable (WARRIOR:
// BLOCKED/REJECTED/NOT_EVALUATED; EDGE: BELOW_THRESHOLD/NOT_EVALUATED) --
// see db/016's taken_resolution comment for the full design and the
// traded-against-engine state this distinction exists to produce.
const ACTIONABLE_TIER_RANK = {
  WARRIOR: { QUALIFIED: 1, NEAR_MISS: 2 },
  EDGE: { SHOWN: 1 },
};

// NOT a trading-day function -- deliberately, after finding live
// (2026-09-11) that the previous version was: it skipped weekends but not
// holidays (core/clock.js's own HOLIDAYS table exists and was never
// consulted), so "5 trading days after signal_date" silently counted a
// closed Labor Day as a session, producing two failure modes at once --
// a visible null where the mislabeled date landed on a day with no bar
// (the day that CAN'T be mistaken for correct), and a real, non-null,
// SILENTLY WRONG value for every offset after the swallowed holiday (the
// day that reads as correct and isn't -- AAPL/2026-09-02's ret_5d was
// really the 4th trading session's close, not the 5th, with nothing to
// distinguish it from a genuine 5-day return).
//
// Fixed by not doing calendar-date arithmetic for the thing that actually
// matters (WHICH bar is "N trading days later") at all -- see the
// array-position lookup below, which uses the real fetched bars as the
// trading calendar instead of predicting one. This helper now exists
// only to build a GENEROUS, approximate upper bound for how far forward
// to fetch and for the taken-resolution window -- being off by a day
// near a holiday there just shifts a fetch window's edge or when a row
// flips to not-taken-confirmed, not the value of any column. Pure
// calendar-day addition, no holiday/weekend logic, no ambiguity to get
// wrong.
function addCalendarDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

async function main() {
  // state shim -- alpacaHeaders() (core/api-client.js) reads
  // state.settings.alpacaKey/alpacaSecret as a bare global, same
  // requirement both loggers already satisfy this same way.
  global.state = { settings: { alpacaKey: ALPACA_KEY_ID, alpacaSecret: ALPACA_SECRET_KEY } };

  loadReal('core/clock.js', ['getPT', 'ptDateStr', 'getMarketStatus']);
  loadReal('core/api-client.js', ['chunk', 'sanitizeTickerBatch', 'alpacaGet', 'createApiClient', 'assertPageNotSuspiciouslyFull', 'sipSafeEndParams']);
  loadReal('core/market-data.js', ['HISTORICAL_BAR_ADJUSTMENT']);

  // 'CORE', not a new engine tag: _engineTimestamps (core/api-client.js)
  // is a hardcoded { EDGE, WARRIOR, CORE } object, not an open map --
  // found live: an invented tag ('OUTCOME_FILLER') makes
  // _engineTimestamps[item.engine].push(...) throw inside _drainWorker's
  // loop, BEFORE that item's own try/catch, so the queued promise never
  // resolves or rejects and the caller hangs while the crashed worker's
  // unhandled rejection compounds with every subsequent call -- not a
  // clean error, a silent hang that (as seen) runs the process out of
  // heap rather than failing fast. 'CORE' is the correct, honest tag
  // anyway: this traffic isn't attributable to either live engine's
  // real-time scanning.
  const fillerClient = global.createApiClient('CORE');
  const todayPT = global.ptDateStr(global.getPT());
  const pt = global.getPT();
  const minutesSinceMidnightPT = pt.getHours() * 60 + pt.getMinutes();
  const CLOSE_MIN_PT = 780; // 1:00pm PT = 4:00pm ET, same constant both loggers use

  // A trading day `dateStr` has closed if it's strictly before today (PT),
  // or it IS today and today's close time has passed.
  function tradingDayHasClosed(dateStr) {
    if (dateStr < todayPT) return true;
    if (dateStr > todayPT) return false;
    return minutesSinceMidnightPT >= CLOSE_MIN_PT;
  }

  // sipSafeEndParams (core/api-client.js) -- the shared helper built after
  // this script's own first version guessed a clamp value (16min,
  // borrowed from a DIFFERENT data type's measured embargo) and still got
  // 403'd on a daily-bar request. Spread its result into a params object;
  // it contributes `end` only when the desired end is safely old, and
  // contributes nothing (Alpaca's own safe default applies) otherwise.

  // OPEN_MIN_PT/CLOSE_MIN_PT: regular trading hours in PT minutes-past-
  // midnight, same constants both loggers already use for their DST
  // no-op checks. shownDuringRegularHours takes an arbitrary INSTANT
  // (first_shown_at), not "now" -- getPT(date) accepts one -- because the
  // question that matters is whether the SIGNAL had a same-day forward
  // window when it fired, not whether the fill job happens to be running
  // during market hours. Found live (2026-09-11): every 2026-09-10 row's
  // first_shown_at was 20:26 UTC, 26 minutes after that day's close --
  // ret_close was comparing a post-close snapshot against the close that
  // had already happened, backwards from what the column claims, and
  // ret_5m/15m/30m were real after-hours prints in a thin, different
  // market regime than the one the gate scored. Gates all four same-day
  // columns as one condition, not four separate carve-outs for the same
  // underlying fact: a post-close (or pre-open) signal has no same-day
  // tradeable outcome. ret_1d/3d/5d are unaffected -- their forward
  // window is real regardless of what time the signal fired.
  const OPEN_MIN_PT = 390; // 6:30am PT = 9:30am ET
  const CLOSE_MIN_PT_FOR_SHOWN = 780; // 1:00pm PT = 4:00pm ET
  function shownDuringRegularHours(firstShownAtIso) {
    const shownPT = global.getPT(new Date(firstShownAtIso));
    const shownMin = shownPT.getHours() * 60 + shownPT.getMinutes();
    return shownMin >= OPEN_MIN_PT && shownMin < CLOSE_MIN_PT_FOR_SHOWN;
  }

  // minutesFromShownToClose -- the guard above answers "was the signal
  // shown during regular hours," which is necessary but not sufficient:
  // it says nothing about whether a given horizon's WINDOW fits before
  // the close. Found live (2026-09-11), from the dense schedule's own
  // shape: a firing landing at 19:50 UTC is genuinely during regular
  // hours (close is 20:00), so the per-signal guard passes -- but its
  // 15-minute window ends at 20:05 and its 30-minute window at 20:20,
  // both past the bell. The old guard would have filled all four
  // same-day columns anyway, with ret_15m/30m coming from whatever bar
  // the fetch happened to return after hours -- the exact defect just
  // fixed, one layer down: "the signal was after the close" is fixed;
  // "the signal was before the close but the window wasn't" is a
  // separate, finer-grained case the per-signal check can't see. Each of
  // ret_5m/15m/30m is now gated on ITS OWN endpoint fitting before close,
  // not just the signal's own start time. ret_close needs no such check --
  // its target IS the close itself, so it always fits once
  // shownDuringRegularHours is true at all.
  function minutesFromShownToClose(firstShownAtIso) {
    const shownPT = global.getPT(new Date(firstShownAtIso));
    const shownMin = shownPT.getHours() * 60 + shownPT.getMinutes();
    return CLOSE_MIN_PT_FOR_SHOWN - shownMin;
  }

  // ── Fetch candidate rows ──
  // Cutoff: 12 calendar days back is generous slack over the 5-trading-
  // day tail (covers a holiday week) without scanning the whole table --
  // reuses signal_log_pending_outcomes_idx (db/001) and
  // signal_log_unresolved_taken_idx (db/016) via the same signal_date /
  // null-column shape those indexes were built for.
  const cutoff = (() => { const d = new Date(todayPT + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 12); return d.toISOString().split('T')[0]; })();
  const anonHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
  const selectCols = 'id,signal_date,symbol,engine_source,tier,first_shown_at,reference_price,ret_5m,ret_15m,ret_30m,ret_close,ret_1d,ret_3d,ret_5d,outcomes_filled_at,taken_resolution';
  const orFilter = 'or=(ret_5m.is.null,ret_15m.is.null,ret_30m.is.null,ret_close.is.null,ret_1d.is.null,ret_3d.is.null,ret_5d.is.null,taken_resolution.eq.unresolved)';
  const rowsRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?select=${selectCols}&signal_date=gte.${cutoff}&${orFilter}`, { headers: anonHeaders });
  if (rowsRes.status >= 300) throw new Error(`signal_log pending-rows query failed: ${rowsRes.status} ${await rowsRes.text()}`);
  const rows = await rowsRes.json();
  console.log(`fill-outcomes: ${rows.length} candidate row(s) since ${cutoff} (any ret_* null or taken_resolution='unresolved').`);

  const patches = new Map(); // id -> partial update object
  function patchFor(id) {
    if (!patches.has(id)) patches.set(id, {});
    return patches.get(id);
  }

  // ── Pass 1: returns ──
  // ret_close/5m/15m/30m all require the signal to have fired during
  // regular hours (shownDuringRegularHours) -- a PRE/AH-shown row simply
  // never becomes eligible for these four, permanently, which is the
  // correct terminal state (no same-day window ever existed), not a gap
  // waiting to be filled. ret_5m/15m/30m ALSO require their own endpoint
  // to fit before close (minutesFromShownToClose) -- a signal shown late
  // enough in the session has some of these windows genuinely unavailable
  // even though the signal itself was during regular hours; see
  // minutesFromShownToClose's own comment.
  const needIntraday = rows.filter(r => {
    if (!shownDuringRegularHours(r.first_shown_at)) return false;
    const minToClose = minutesFromShownToClose(r.first_shown_at);
    const elapsedMin = (Date.now() - new Date(r.first_shown_at)) / 60000;
    return (r.ret_5m == null && minToClose >= 5 && elapsedMin >= 5) ||
      (r.ret_15m == null && minToClose >= 15 && elapsedMin >= 15) ||
      (r.ret_30m == null && minToClose >= 30 && elapsedMin >= 30) ||
      (r.ret_close == null && tradingDayHasClosed(r.signal_date));
  });
  // needDaily no longer pre-computes WHICH calendar date each offset
  // needs (that was the holiday bug's other half) -- it just decides
  // whether it's worth fetching at all. ret_1d/3d/5d have no
  // regular-hours requirement (see shownDuringRegularHours's own
  // comment); ret_close does.
  const needDaily = rows.filter(r =>
    (r.ret_close == null && shownDuringRegularHours(r.first_shown_at) && tradingDayHasClosed(r.signal_date)) ||
    r.ret_1d == null || r.ret_3d == null || r.ret_5d == null
  );

  const intradayBySymbolDate = new Map(); // `${symbol}|${date}` -> bars[]
  for (const r of needIntraday) {
    const key = `${r.symbol}|${r.signal_date}`;
    if (intradayBySymbolDate.has(key)) continue;
    let bars = [];
    try {
      let pageToken;
      do {
        const params = {
          timeframe: '1Min', start: r.signal_date, limit: 10000, sort: 'asc', feed: 'sip',
          ...global.sipSafeEndParams(addCalendarDays(r.signal_date, 1)),
        };
        if (pageToken) params.page_token = pageToken;
        const data = await fillerClient.alpacaGet(`/stocks/${r.symbol}/bars`, params);
        bars = bars.concat(data.bars || []);
        pageToken = data.next_page_token || null;
        global.assertPageNotSuspiciouslyFull(`fill-outcomes minute bars(${r.symbol})`, (data.bars || []).length, params.limit, pageToken);
      } while (pageToken);
    } catch (e) {
      console.warn(`fill-outcomes: minute-bars fetch failed for ${r.symbol}/${r.signal_date}: ${e.message}`);
    }
    intradayBySymbolDate.set(key, bars);
  }

  const dailyBySymbolDate = new Map(); // `${symbol}|${signal_date}` -> bars[] spanning signal_date..~signal_date+12 calendar days
  for (const r of needDaily) {
    const key = `${r.symbol}|${r.signal_date}`;
    if (dailyBySymbolDate.has(key)) continue;
    // 12 CALENDAR days, not "5 trading days" -- this only needs to be
    // wide enough to contain at least 5 real trading sessions past
    // signal_date, comfortably covering a full holiday week; it no
    // longer needs to be the exact right date, because the value lookup
    // below is array-position-based, not date-based. limit:20 is still
    // slack over what 12 calendar days can ever actually contain (~9
    // trading days worst case), same exemption shape as core/market-
    // data.js's fetchNextDayClose. Pagination followed anyway regardless.
    let bars = [];
    try {
      let pageToken;
      do {
        const params = {
          timeframe: '1Day', start: r.signal_date, limit: 20, sort: 'asc', feed: 'sip', adjustment: global.HISTORICAL_BAR_ADJUSTMENT,
          ...global.sipSafeEndParams(addCalendarDays(r.signal_date, 12)),
        };
        if (pageToken) params.page_token = pageToken;
        const data = await fillerClient.alpacaGet(`/stocks/${r.symbol}/bars`, params);
        bars = bars.concat(data.bars || []);
        pageToken = data.next_page_token || null;
        global.assertPageNotSuspiciouslyFull(`fill-outcomes daily bars(${r.symbol})`, (data.bars || []).length, params.limit, pageToken);
      } while (pageToken);
    } catch (e) {
      console.warn(`fill-outcomes: daily-bars fetch failed for ${r.symbol}/${r.signal_date}: ${e.message}`);
    }
    dailyBySymbolDate.set(key, bars);
  }

  function priceAtOrAfter(bars, targetIso) {
    const target = new Date(targetIso).getTime();
    for (const b of bars) {
      if (new Date(b.t).getTime() >= target) return b.c;
    }
    return null;
  }
  function ret(basePrice, targetPrice) {
    return targetPrice == null ? null : (targetPrice - basePrice) / basePrice;
  }

  let returnsFilledCount = 0;
  for (const r of rows) {
    const p = patchFor(r.id);
    const base = Number(r.reference_price);
    const shownAt = new Date(r.first_shown_at);
    const elapsedMin = (Date.now() - shownAt) / 60000;
    const regularHours = shownDuringRegularHours(r.first_shown_at);
    const minToClose = minutesFromShownToClose(r.first_shown_at);
    const intraday = intradayBySymbolDate.get(`${r.symbol}|${r.signal_date}`);
    const daily = dailyBySymbolDate.get(`${r.symbol}|${r.signal_date}`);

    // Each of 5m/15m/30m gated on ITS OWN window fitting before close
    // (minToClose >= N), not just on the signal having fired during
    // regular hours -- see minutesFromShownToClose's comment. A signal
    // shown late enough in the session permanently and correctly never
    // fills whichever of these three windows runs past the bell.
    if (regularHours) {
      if (r.ret_5m == null && minToClose >= 5 && elapsedMin >= 5 && intraday) {
        const px = priceAtOrAfter(intraday, new Date(shownAt.getTime() + 5 * 60000).toISOString());
        const v = ret(base, px);
        if (v != null) { p.ret_5m = v; returnsFilledCount++; }
      }
      if (r.ret_15m == null && minToClose >= 15 && elapsedMin >= 15 && intraday) {
        const px = priceAtOrAfter(intraday, new Date(shownAt.getTime() + 15 * 60000).toISOString());
        const v = ret(base, px);
        if (v != null) { p.ret_15m = v; returnsFilledCount++; }
      }
      if (r.ret_30m == null && minToClose >= 30 && elapsedMin >= 30 && intraday) {
        const px = priceAtOrAfter(intraday, new Date(shownAt.getTime() + 30 * 60000).toISOString());
        const v = ret(base, px);
        if (v != null) { p.ret_30m = v; returnsFilledCount++; }
      }
    }

    // Array-position lookup, not calendar arithmetic -- the actual fix
    // for the holiday bug. anchorIdx is signal_date's own bar; "N trading
    // days later" is simply the bar N positions further into the array
    // Alpaca actually returned, which by construction can never include
    // a day the market didn't trade (a holiday never produces a bar, so
    // it can never occupy a position). "Not enough real sessions have
    // happened yet" and "there's a gap in the data" are now the same,
    // correct condition: daily[anchorIdx + N] doesn't exist.
    if (daily && daily.length) {
      const anchorIdx = daily.findIndex(b => (b.t || '').split('T')[0] === r.signal_date);
      if (anchorIdx !== -1) {
        if (r.ret_close == null && regularHours) {
          const v = ret(base, daily[anchorIdx].c);
          if (v != null) { p.ret_close = v; returnsFilledCount++; }
        }
        if (r.ret_1d == null && daily[anchorIdx + 1]) {
          const v = ret(base, daily[anchorIdx + 1].c);
          if (v != null) { p.ret_1d = v; returnsFilledCount++; }
        }
        if (r.ret_3d == null && daily[anchorIdx + 3]) {
          const v = ret(base, daily[anchorIdx + 3].c);
          if (v != null) { p.ret_3d = v; returnsFilledCount++; }
        }
        if (r.ret_5d == null && daily[anchorIdx + 5]) {
          const v = ret(base, daily[anchorIdx + 5].c);
          if (v != null) { p.ret_5d = v; returnsFilledCount++; }
        }
      }
    }

    // outcomes_filled_at: only once every ret_* is non-null accounting for
    // both this run's new values AND whatever was already there.
    const merged = {
      ret_5m: p.ret_5m ?? r.ret_5m, ret_15m: p.ret_15m ?? r.ret_15m, ret_30m: p.ret_30m ?? r.ret_30m,
      ret_close: p.ret_close ?? r.ret_close, ret_1d: p.ret_1d ?? r.ret_1d, ret_3d: p.ret_3d ?? r.ret_3d, ret_5d: p.ret_5d ?? r.ret_5d,
    };
    if (r.outcomes_filled_at == null && Object.values(merged).every(v => v != null)) {
      p.outcomes_filled_at = new Date().toISOString();
    }
  }

  // ── Pass 2: taken_resolution ──
  // Grouped by (signal_date, symbol, engine_source) -- dedup's tier-
  // inclusive key means a symbol/day can have more than one signal_log
  // row per engine. See db/016's header for the tie-break and the
  // traded-against-engine state this produces.
  const unresolvedRows = rows.filter(r => r.taken_resolution === 'unresolved');
  const groups = new Map();
  for (const r of unresolvedRows) {
    const key = `${r.signal_date}|${r.symbol}|${r.engine_source}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let takenResolvedCount = 0;
  for (const [key, groupRows] of groups) {
    const [signalDate, symbol, engineSource] = key.split('|');
    // 9 calendar days, not "5 trading days" -- generous slack over 5 real
    // trading sessions through any single-holiday week. Being a day or
    // two wide here only shifts WHEN a row can flip to
    // not-taken-confirmed, or admits one extra day of fallback-match
    // candidates -- unlike the returns fix, there's no per-column value
    // to mislabel, so an approximate calendar bound is an honest
    // tradeoff, not a shortcut version of the same bug.
    const windowEnd = addCalendarDays(signalDate, 9);
    const candRes = await fetch(
      `${SUPABASE_URL}/rest/v1/trades_v2?select=id,signal_log_id,buy_date,created_at&source=neq.Own Decision&engine_source=eq.${engineSource}&ticker=eq.${symbol}&buy_date=gte.${signalDate}&buy_date=lte.${windowEnd}&order=buy_date.asc,created_at.asc`,
      { headers: anonHeaders }
    );
    if (candRes.status >= 300) { console.warn(`fill-outcomes: trades_v2 candidate query failed for ${key}: ${candRes.status} ${await candRes.text()}`); continue; }
    const candidates = await candRes.json();
    const windowElapsed = tradingDayHasClosed(windowEnd);

    if (candidates.length) {
      const match = candidates[0];
      const rankOf = (row) => ACTIONABLE_TIER_RANK[engineSource]?.[row.tier];
      const actionable = groupRows.filter(row => rankOf(row) != null).sort((a, b) => rankOf(a) - rankOf(b));
      if (actionable.length) {
        const winner = actionable[0];
        const isExact = match.signal_log_id === winner.id;
        patchFor(winner.id).taken_resolution = isExact ? 'taken-exact' : 'taken-by-fallback';
        patchFor(winner.id).matched_trade_id = match.id;
        takenResolvedCount++;
        for (const row of groupRows) {
          if (row.id === winner.id) continue;
          patchFor(row.id).taken_resolution = 'not-taken-confirmed';
          takenResolvedCount++;
        }
      } else {
        for (const row of groupRows) {
          patchFor(row.id).taken_resolution = 'traded-against-engine';
          patchFor(row.id).matched_trade_id = match.id;
          takenResolvedCount++;
        }
      }
    } else if (windowElapsed) {
      for (const row of groupRows) {
        patchFor(row.id).taken_resolution = 'not-taken-confirmed';
        takenResolvedCount++;
      }
    }
    // else: no candidate yet and window still open -- leave unresolved, no write.
  }

  const toWrite = [...patches.entries()].filter(([, p]) => Object.keys(p).length > 0);
  console.log(`fill-outcomes: ${returnsFilledCount} return value(s) computed, ${takenResolvedCount} taken_resolution transition(s), across ${toWrite.length} row(s) with at least one new column to write.`);

  // schema-check (scripts/lib/schema-check.mjs): runs on every dispatch,
  // dry-run included -- same reasoning as both loggers. Checked against
  // the actual union of columns this run is about to patch, not a
  // hardcoded list, so it stays correct as new columns get added.
  const patchedColumns = [...new Set(toWrite.flatMap(([, p]) => Object.keys(p)))];
  await assertColumnsExist(SUPABASE_URL, SUPABASE_ANON_KEY, 'signal_log', patchedColumns);

  if (!WRITE) {
    mkdirSync(path.join(REPO_ROOT, 'data', 'outcome-fill-dry-runs'), { recursive: true });
    const outPath = path.join(REPO_ROOT, 'data', 'outcome-fill-dry-runs', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(outPath, JSON.stringify(toWrite, null, 2));
    console.log(`\nDRY RUN -- wrote ${toWrite.length} would-be signal_log PATCH(es) to ${outPath}. Nothing sent to Supabase.`);
    for (const [id, p] of toWrite) {
      console.log(`  ${id}: ${JSON.stringify(p)}`);
    }
    return;
  }

  console.log('\n--write passed -- patching signal_log for real.');
  const roleHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${OUTCOME_FILLER_JWT}`, 'Content-Type': 'application/json' };
  const touchedIds = [];
  for (const [id, p] of toWrite) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
      method: 'PATCH', headers: roleHeaders, body: JSON.stringify(p),
    });
    if (res.status >= 300) {
      console.error(`fill-outcomes: PATCH failed for ${id}: ${res.status} ${await res.text()}`);
      continue;
    }
    touchedIds.push(id);
  }
  console.log(`fill-outcomes: ${touchedIds.length}/${toWrite.length} PATCH(es) succeeded.`);

  if (touchedIds.length) {
    const verifyRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=in.(${touchedIds.join(',')})&select=${selectCols}`, { headers: anonHeaders });
    const verifyBody = await verifyRes.json();
    console.log(`fill-outcomes: re-selected ${verifyBody.length}/${touchedIds.length} touched row(s) via anon key:`);
    for (const row of verifyBody) console.log(`  ${row.id}: ${JSON.stringify(row)}`);
  }
}

main().catch(e => { console.error('fill-outcomes: FAILED', e.message, e.stack); process.exit(1); });
