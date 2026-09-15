#!/usr/bin/env node
// One-time audit: does any ALREADY-FILLED signal_log.ret_close/1d/3d/5d
// value sit on the same units-mismatch corruption as trades_v2's MSTU row
// (phase-9-entry-exit-spec.md §1.1)? fill-outcomes.mjs Pass 1 computes
// these as ret(reference_price, daily[anchorIdx+N].c), where
// reference_price is a raw live quote and `daily` is fetched with
// adjustment='all' -- same mismatch, no detectSplitInWindow call, until
// this session's fix to Pass 1 (steady-state, null-columns-only).
//
// WHY THIS IS A SEPARATE ONE-TIME SCRIPT, NOT A RECURRING PASS: unlike
// trades_v2's best_exit_price (a "max of a CLOSED window" fact, stable
// and safe to recompute every run), a filled ret_Nd is a point-in-time
// snapshot -- it was computed once, from bars fetched at ONE specific
// moment, and is meant to stay exactly that: what the forward test
// actually saw. Recomputing it on every future run would mean "adjustment
// relative to today" keeps moving the target every time this job runs,
// silently rewriting historical forward-test numbers for reasons that
// have nothing to do with a bug -- exactly the kind of drift the
// stored-once design exists to prevent. So Pass 1 stays null-columns-only
// (fixed going forward, this session), and existing corruption gets one
// deliberate, one-time correction pass: this script.
//
// WHAT "CORRUPT" MEANS HERE: today's raw-vs-adjusted comparison on the
// SAME bar window used to originally compute the value. This answers "is
// the stored number trustworthy as of what's understood today," which is
// the only question worth asking during a cleanup pass -- not "was a
// split already in effect at the exact original fetch moment" (moot; the
// stored value is either right or wrong today, regardless of when the
// wrongness was introduced).
//
// Each of ret_close/1d/3d/5d is checked at ITS OWN offset from the
// signal_date anchor bar (0/1/3/5), not one blanket per-row verdict -- a
// split landing between day 3 and day 5 corrupts ret_5d but leaves
// ret_close/1d/3d clean, and flagging all four would null good data.
// ret_5m/15m/30m are NOT audited: they come from minute bars fetched with
// no `adjustment` param (Alpaca's raw default), same-day only, and cannot
// span a split boundary (splits take effect between sessions).
//
// Dry-run by default (report only). --write requires OUTCOME_FILLER_JWT
// and db/021's widened grant (the four ret_*_split_in_window columns) to
// already be applied -- same two-step pattern as fill-outcomes.mjs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSellTiming, detectSplitInWindow } from './lib/sell-timing.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WRITE = process.argv.includes('--write');
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';

const ALPACA_KEY_ID = process.env.ALPACA_KEY_ID;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY) {
  console.error('audit-signal-log-splits: ALPACA_KEY_ID / ALPACA_SECRET_KEY not set.');
  process.exit(1);
}
let OUTCOME_FILLER_JWT = null;
if (WRITE) {
  OUTCOME_FILLER_JWT = process.env.OUTCOME_FILLER_JWT;
  if (!OUTCOME_FILLER_JWT) {
    console.error('audit-signal-log-splits: --write requires OUTCOME_FILLER_JWT to be set.');
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

// Same reasoning as fill-outcomes.mjs's identical helper: a 401/403 means
// the credential is broken for every remaining row, not a per-row
// problem -- fail loud rather than log N identical errors and exit 0.
async function assertNotAuthFailure(res, context) {
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '');
    throw new Error(`${context}: HTTP ${res.status} (auth/permission failure, not a per-row data problem) -- most likely OUTCOME_FILLER_JWT has expired or lacks the needed grant. Check the expiry date recorded in .github/workflows/fill-outcomes.yml and docs/phase-9-entry-exit-spec.md §2.5. Body: ${body.slice(0, 300)}`);
  }
}

function addCalendarDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// alpacaBars: reuses core/api-client.js's real sipSafeEndParams/alpacaGet
// rather than a hand-rolled fetch -- a first version of this script built
// its own `end` param directly and 403'd on every single one of
// signal_log's rows (all recent, all inside the SIP embargo window;
// sipSafeEndParams exists precisely so a caller never has to compute this
// safely itself -- see core/api-client.js's own header on the three call
// sites this already burned before this file became the fourth).
async function alpacaBars(client, symbol, start, end, adjustment) {
  let bars = [];
  let pageToken;
  do {
    const params = {
      timeframe: '1Day', start, limit: 20, sort: 'asc', feed: 'sip', adjustment,
      ...global.sipSafeEndParams(end),
    };
    if (pageToken) params.page_token = pageToken;
    const data = await client.alpacaGet(`/stocks/${symbol}/bars`, params);
    bars = bars.concat(data.bars || []);
    pageToken = data.next_page_token || null;
    global.assertPageNotSuspiciouslyFull(`audit-signal-log-splits(${symbol},${adjustment})`, (data.bars || []).length, params.limit, pageToken);
  } while (pageToken);
  return bars;
}

async function main() {
  global.state = { settings: { alpacaKey: ALPACA_KEY_ID, alpacaSecret: ALPACA_SECRET_KEY } };
  loadReal('core/api-client.js', ['sipSafeEndParams', 'alpacaGet', 'createApiClient', 'assertPageNotSuspiciouslyFull']);
  const client = global.createApiClient('CORE');
  const anonHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
  const selectCols = 'id,symbol,signal_date,reference_price,ret_close,ret_1d,ret_3d,ret_5d';
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/signal_log?select=${selectCols}&or=(ret_close.not.is.null,ret_1d.not.is.null,ret_3d.not.is.null,ret_5d.not.is.null)&order=signal_date.asc`,
    { headers: anonHeaders }
  );
  if (res.status >= 300) throw new Error(`signal_log query failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  console.log(`audit-signal-log-splits: ${rows.length} row(s) with at least one filled daily return, checking each against a fresh raw-vs-adjusted comparison.`);

  const barsCache = new Map(); // `${symbol}|${signal_date}` -> { allBars, rawBars }
  const patches = [];
  let checkedCount = 0, corruptColumnCount = 0, corruptRowCount = 0, fetchFailures = 0;

  for (const r of rows) {
    checkedCount++;
    const key = `${r.symbol}|${r.signal_date}`;
    let cached = barsCache.get(key);
    if (!cached) {
      try {
        const end = addCalendarDays(r.signal_date, 12);
        const [allBars, rawBars] = await Promise.all([
          alpacaBars(client, r.symbol, r.signal_date, end, 'all'),
          alpacaBars(client, r.symbol, r.signal_date, end, 'raw'),
        ]);
        cached = { allBars, rawBars };
      } catch (e) {
        console.warn(`audit-signal-log-splits: bars fetch failed for ${key}: ${e.message}`);
        fetchFailures++;
        continue;
      }
      barsCache.set(key, cached);
    }
    const { allBars, rawBars } = cached;
    const anchorIdx = allBars.findIndex(b => (b.t || '').split('T')[0] === r.signal_date);
    if (anchorIdx === -1) {
      console.warn(`audit-signal-log-splits: ${key} -- signal_date has no matching bar in a fresh fetch, skipping (data gap, not a split finding).`);
      continue;
    }

    const offsets = { ret_close: 0, ret_1d: 1, ret_3d: 3, ret_5d: 5 };
    const patch = {};
    let rowCorrupt = false;
    for (const [col, offset] of Object.entries(offsets)) {
      if (r[col] == null) continue; // not filled, nothing to audit
      const lastIdx = anchorIdx + offset;
      if (allBars.length <= lastIdx || rawBars.length <= lastIdx) continue; // can't re-verify past what a fresh fetch covers; leave as-is rather than guess
      if (detectSplitInWindow(allBars, rawBars, lastIdx)) {
        patch[col] = null;
        patch[`${col}_split_in_window`] = true;
        rowCorrupt = true;
        corruptColumnCount++;
        console.log(`  CORRUPT: ${r.symbol} ${r.signal_date} ${col}=${r[col]} -- split detected within [signal_date, +${offset}d]`);
      }
    }
    if (rowCorrupt) {
      corruptRowCount++;
      patches.push([r.id, patch]);
    }
  }

  console.log(`\naudit-signal-log-splits: checked ${checkedCount} row(s), ${fetchFailures} fetch failure(s), ${corruptRowCount} row(s) with ${corruptColumnCount} corrupt column(s) found.`);

  if (!patches.length) {
    console.log('audit-signal-log-splits: no corruption found. Nothing to write.');
    if (WRITE) {
      console.log('audit-signal-log-splits: CAVEAT -- this was a --write run, but zero corrupt rows means the PATCH path above (the actual correction, not the detection) was never exercised. "0 corrupt rows" proves detectSplitInWindow is working, not that the write-a-correction path works. Do not read a clean --write run as evidence the write path itself has been tested until at least one real PATCH has gone through it.');
    }
    return;
  }

  if (!WRITE) {
    console.log('\nDRY RUN -- would PATCH the following (nothing sent to Supabase):');
    for (const [id, p] of patches) console.log(`  ${id}: ${JSON.stringify(p)}`);
    console.log('\nRe-run with --write (requires db/021 applied and OUTCOME_FILLER_JWT set) to apply.');
    return;
  }

  console.log('\n--write passed -- patching signal_log for real.');
  const roleHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${OUTCOME_FILLER_JWT}`, 'Content-Type': 'application/json' };
  const touchedIds = [];
  for (const [id, p] of patches) {
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
      method: 'PATCH', headers: roleHeaders, body: JSON.stringify(p),
    });
    await assertNotAuthFailure(patchRes, `signal_log PATCH for ${id}`);
    if (patchRes.status >= 300) {
      console.error(`audit-signal-log-splits: PATCH failed for ${id}: ${patchRes.status} ${await patchRes.text()}`);
      continue;
    }
    touchedIds.push(id);
  }
  console.log(`audit-signal-log-splits: ${touchedIds.length}/${patches.length} PATCH(es) succeeded.`);
  if (touchedIds.length) {
    const verifyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/signal_log?id=in.(${touchedIds.join(',')})&select=${selectCols},ret_close_split_in_window,ret_1d_split_in_window,ret_3d_split_in_window,ret_5d_split_in_window`,
      { headers: anonHeaders }
    );
    const verifyBody = await verifyRes.json();
    console.log(`audit-signal-log-splits: re-selected ${verifyBody.length}/${touchedIds.length} touched row(s) via anon key:`);
    for (const row of verifyBody) console.log(`  ${row.id}: ${JSON.stringify(row)}`);
  }
}

main().catch(e => { console.error('audit-signal-log-splits: FAILED', e.message, e.stack); process.exit(1); });
