#!/usr/bin/env node
// Daily backup of this app's own Supabase tables to the repo as JSON.
//
// WHY THIS EXISTS (2026-09-05): the anon key is necessarily public --
// it's embedded in the client bundle (core/store.js) -- and RLS narrows
// what it can do but can never make it secret. The realistic mitigation
// for that threat model is recoverability, not access control (see
// db/NOTE_portfolio_rls_not_applied.sql, which reaches the same
// conclusion for portfolio specifically). This job is that mitigation: a
// daily point-in-time export of every table this app owns, committed to
// the repo, so a wipe -- attacker, or more likely our own migration bug
// -- costs a restore instead of the dataset.
//
// Read-only. Uses the same public anon key already embedded in
// core/store.js -- no new credential, and RLS on every table below
// already grants this key SELECT.
//
// PER-TABLE RULES, NOT ONE GLOBAL RULE (revised 2026-09-05: the first
// draft required every table to hold or grow, all-or-nothing. That's
// wrong -- portfolio shrinks every time Roman sells a position, and
// rating_snapshots shrinks by design once its 90-day retention window
// starts outpacing insertion. Under the all-or-nothing version, the
// FIRST sale after this job shipped would have aborted the entire
// backup, including trades -- the table this exists to protect --
// forever after, silently, looking exactly like a backup that's running
// fine. That's the exact defect class this session spent the whole prior
// pass closing, rebuilt inside the thing meant to protect against it.):
//
//   trades           -- append-only, no delete call site anywhere in the
//                        app. Any shrink at all means something is wrong.
//   settings         -- single-row table. A drop below 1 row means
//                        something is wrong.
//   portfolio        -- shrinks constantly and legitimately
//                        (deletePositionFromSupabase fires on every
//                        sale). Never aborts; only flags a drop to zero
//                        from nonzero, since closing every position at
//                        once is unusual enough to be worth a glance.
//   rating_snapshots -- shrinks gradually and legitimately (90-day
//                        retention pruning). Aborts only on a LARGE drop
//                        (>20% in one run) -- retention prunes a little
//                        every day; a wipe removes most of the table at
//                        once, and that shape is what this rule catches.
//
// PER-TABLE OUTCOMES, NOT ALL-OR-NOTHING: a table that fails its own rule
// has its write skipped -- its last committed file is left untouched --
// but every OTHER table that passes still gets written and committed.
// The four files are independent; a legitimately-shrinking portfolio
// must never cost the trades backup.
//
// THE RUN STILL FAILS LOUDLY, THOUGH: if any table failed its rule, this
// script exits non-zero AFTER writing every table that passed, so
// GitHub Actions shows a failed run with the reason in the log, while
// the tables that were fine still get committed. A backup job whose only
// failure mode is silence is not a backup job.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(REPO_ROOT, 'data', 'backups');

// Same public anon key already embedded in core/store.js -- public by
// construction, not a secret this script introduces.
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';

const PAGE_SIZE = 1000; // PostgREST's default page cap -- paginate past it explicitly rather than assume any table stays under it forever.

// Each rule returns { ok: true } to write normally, or
// { ok: false, reason } to skip writing this table this run. A rule may
// also just console.warn for a non-blocking flag (portfolio) without
// affecting ok.
const TABLE_RULES = {
  trades(fresh, prior) {
    if (fresh < prior) {
      return { ok: false, reason: `shrank from ${prior} to ${fresh} rows -- trades is append-only with no delete call site anywhere in the app; any shrink means something is wrong, not normal usage` };
    }
    return { ok: true };
  },
  settings(fresh, _prior) {
    if (fresh < 1) {
      return { ok: false, reason: `dropped to ${fresh} rows -- settings is a single-row table; anything below 1 means something is wrong` };
    }
    return { ok: true };
  },
  portfolio(fresh, prior) {
    if (fresh === 0 && prior > 0) {
      console.warn(`backup-tables: FLAG -- portfolio dropped to 0 rows (was ${prior}). Not blocked -- shrinking is normal (every sale deletes a row) -- but every position closing at once is unusual enough to be worth a glance.`);
    }
    return { ok: true }; // never aborts: shrinking is this table's normal operation
  },
  rating_snapshots(fresh, prior) {
    if (prior > 0 && fresh < prior * 0.8) {
      return { ok: false, reason: `dropped from ${prior} to ${fresh} rows (more than 20% in one run) -- 90-day retention prunes a little every day; a drop this large at once looks like a wipe, not normal aging-out` };
    }
    return { ok: true };
  },
};

const TABLES = Object.keys(TABLE_RULES);

// No `order=` clause: not every table's primary key column is confirmed
// (trades/settings/rating_snapshots use `id`; portfolio's own key is
// `position_id` -- see savePositionToSupabase's onConflict). A backup
// doesn't need a stable row order, so this avoids assuming a column name
// that isn't actually shared across all four tables.
//
// COMPLETENESS IS VERIFIED, NOT INFERRED (revised 2026-09-05): the first
// draft treated `page.length < PAGE_SIZE` as "that was the last page."
// If PostgREST's own max-rows setting is ever below PAGE_SIZE for any
// reason (a config change, a plan limit, anything on Supabase's side),
// every page comes back short and the loop exits after page one --
// silently capturing a fraction of the table. Worse, a STABLE truncation
// produces a STABLE row count: the first truncated run becomes the floor,
// every run after it matches that floor, and the shrink checks -- which
// only compare against the PRIOR run -- never fire. A backup that
// faithfully records 1,000 of 1,277 rows forever, looking healthy the
// entire time. `Prefer: count=exact` plus Content-Range's total gives an
// authoritative count straight from Postgres instead of an inference
// from response size, and the loop keeps requesting until it's actually
// fetched that many -- with a final assert as a second, independent
// check that the two numbers actually agree.
async function fetchTable(table) {
  const rows = [];
  let offset = 0;
  let total = null;
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
        Prefer: 'count=exact',
      },
    });
    if (!res.ok && res.status !== 206) {
      const body = await res.text().catch(() => '');
      throw new Error(`${table}: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    const contentRange = res.headers.get('content-range'); // e.g. "0-999/1277"
    const totalMatch = contentRange && contentRange.match(/\/(\d+|\*)$/);
    const pageTotal = totalMatch ? totalMatch[1] : null;
    if (pageTotal === null || pageTotal === '*') {
      throw new Error(`${table}: no authoritative row count from Content-Range ("${contentRange}") -- refusing to infer completeness from page size`);
    }
    total = Number(pageTotal);
    const page = await res.json();
    rows.push(...page);
    if (rows.length >= total) break;
    offset += PAGE_SIZE;
  }
  if (rows.length !== total) {
    throw new Error(`${table}: fetched ${rows.length} rows but Content-Range reported ${total} total -- pagination did not retrieve every row, refusing to treat this as a complete backup`);
  }
  return rows;
}

// Distinguishes "no prior backup" from "prior backup is corrupt" --
// collapsing both to 0 (as the first draft did) meant a corrupt file
// silently disabled every shrink rule: the run would happily overwrite
// broken data (or a wipe) with whatever it just fetched, in exactly the
// case where the check should be MOST suspicious, not least. A corrupt
// existing file is itself a signal something already went wrong; it
// blocks that table until someone looks, same as any other rule failure.
function readPriorBackup(filePath) {
  if (!existsSync(filePath)) return { status: 'absent', count: 0 };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { status: 'corrupt', reason: `not valid JSON (${e.message})` };
  }
  if (!Array.isArray(parsed)) {
    return { status: 'corrupt', reason: 'did not contain a JSON array' };
  }
  return { status: 'ok', count: parsed.length };
}

async function main() {
  mkdirSync(BACKUP_DIR, { recursive: true });

  const toWrite = [];
  const failures = [];

  for (const table of TABLES) {
    const filePath = path.join(BACKUP_DIR, `${table}.json`);
    const prior = readPriorBackup(filePath);

    if (prior.status === 'corrupt') {
      console.error(`backup-tables: SKIPPING ${table} this run -- its existing backup file is present but ${prior.reason}. A corrupt backup is itself a signal something already went wrong; overwriting it blindly (including with a wipe) is exactly what a shrink check exists to prevent. Fix or remove the file, then re-run. Other tables are not affected.`);
      failures.push({ table, reason: `corrupt prior backup (${prior.reason})` });
      continue;
    }

    const fresh = await fetchTable(table);
    const priorCount = prior.count;
    console.log(`backup-tables: ${table} -- fetched ${fresh.length} rows, prior backup had ${priorCount}${prior.status === 'absent' ? ' (no prior backup -- first run)' : ''}.`);

    const verdict = TABLE_RULES[table](fresh.length, priorCount);
    if (verdict.ok) {
      toWrite.push({ table, filePath, fresh });
    } else {
      console.error(`backup-tables: SKIPPING ${table} this run -- ${verdict.reason}. Its last committed backup is left untouched. Other tables are not affected.`);
      failures.push({ table, reason: verdict.reason });
    }
  }

  for (const { table, filePath, fresh } of toWrite) {
    writeFileSync(filePath, JSON.stringify(fresh, null, 2) + '\n');
    console.log(`backup-tables: wrote ${table} (${fresh.length} rows).`);
  }

  if (failures.length) {
    console.error(`backup-tables: FAILED for ${failures.map(f => f.table).join(', ')} -- see reasons above. ${toWrite.length} other table(s) still written and will still be committed.`);
    process.exit(1);
  }
  console.log('backup-tables: all tables passed their rule and were written.');
}

main().catch(e => {
  console.error('backup-tables: FAILED', e.message);
  process.exit(1);
});
