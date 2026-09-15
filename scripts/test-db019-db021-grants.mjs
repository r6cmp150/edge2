#!/usr/bin/env node
// Verification for db/019 (trades_v2 sell-timing columns) and db/021
// (signal_log split-flag columns) -- the two grant widenings that came
// after test-outcome-filler-role-production.mjs was written, so that
// script's checkA/B/E don't cover them. Same four-bucket status reading,
// same "re-select from the database, never trust a status code alone"
// discipline (phase-9-entry-exit-spec.md §6).
//
// SAFETY (2026-09-15, first production write through outcome_filler to
// trades_v2 -- Roman's own instruction before this script was run):
// every check here uses a REAL row, not a disposable one, because
// db/019/db/021's own verification plans call for real rows and a
// disposable trades_v2 row isn't available (no anon insert policy on the
// table that holds actual trade records). The two "expect denied" checks
// (019 check B on buy_price, 021 check B on reference_price) write the
// row's CURRENT value back to itself -- if the grant is exactly as narrow
// as intended the PATCH is denied and nothing changes either way; if the
// grant is somehow wider than intended, the round-trip write is a no-op,
// not a corruption. 021 check A (the one "expect success" check not
// otherwise exercised by tonight's real fill run) intentionally toggles a
// real value and restores it in the same run, verifying BOTH the toggle
// and the restore from the database, specifically so a genuine landed
// write is distinguishable from a PostgREST 200-with-empty-body RLS
// no-op -- the failure mode this whole verification pass exists to catch.
//
// 019 check A is NOT implemented here: the real fill-outcomes.mjs --write
// run this same dispatch performs writes to sell_timing_resolved on real
// eligible trades_v2 rows for real (that's Pass 3's actual job), and
// phase-9-entry-exit-spec.md §6 test 3's re-select is that check, done
// with real production data rather than a redundant synthetic write to
// the same money-bearing table.
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
const ROLE_JWT = process.env.OUTCOME_FILLER_JWT;

if (!ROLE_JWT) {
  console.error('Set OUTCOME_FILLER_JWT first. This message intentionally does not echo the env var even if it were set wrong.');
  process.exit(1);
}

const anonHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
const roleHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${ROLE_JWT}`, 'Content-Type': 'application/json' };

async function dump(label, res, meanings) {
  const body = await res.text();
  console.log(`\n--- ${label} ---`);
  console.log(`status: ${res.status} ${res.statusText}`);
  console.log(`body: ${body}`);

  let bucket;
  if (res.status === 400) bucket = 'requestRejected400';
  else if (res.status === 401) bucket = 'jwtRejected401';
  else if (res.status === 404) bucket = 'weakEmptyOrFiltered';
  else if (res.status >= 400) bucket = 'permissionRejected';
  else {
    const isEmpty = body === '' || body === '[]' || body === 'null';
    bucket = isEmpty ? 'weakEmptyOrFiltered' : 'ok';
  }
  console.log(`READ AS: ${meanings[bucket] || `(no interpretation supplied for a ${res.status} in the "${bucket}" bucket -- report this raw)`}`);
  return body;
}

async function db019checkB() {
  console.log('\n=== db/019 CHECK B: outcome_filler attempts trades_v2.buy_price (NOT in the widened grant), real row, self-write ===');
  const rowRes = await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?select=id,buy_price&limit=1`, { headers: anonHeaders });
  const rows = await rowRes.json();
  if (!rows.length) { console.log('No trades_v2 rows exist -- cannot run this check meaningfully.'); return; }
  const { id, buy_price } = rows[0];
  console.log(`Using real trades_v2 row id=${id}, current buy_price=${buy_price} -- PATCHing this SAME value back (safe either way it lands)`);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?id=eq.${id}`, {
    method: 'PATCH', headers: roleHeaders, body: JSON.stringify({ buy_price }),
  });
  await dump('db/019 CHECK B: PATCH trades_v2.buy_price (real row, same value)', res, {
    ok: 'UNEXPECTED AND SERIOUS -- outcome_filler can write a column outside db/019\'s grant. The self-write kept this row\'s value unchanged, but the boundary itself is not where it should be.',
    jwtRejected401: 'JWT rejected outright, unrelated to buy_price specifically',
    requestRejected400: 'malformed request -- fix and re-run, not evidence about the grant',
    permissionRejected: 'expected and informative -- db/019 narrowed the grant to exactly five columns and buy_price is correctly outside it',
    weakEmptyOrFiltered: 'ambiguous against a known-real id -- investigate before trusting either way',
  });
  const verify = await (await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?id=eq.${id}&select=buy_price`, { headers: anonHeaders })).json();
  console.log(`re-select (anon key) buy_price = ${verify[0]?.buy_price} -- expect ${buy_price} (unchanged)`);
}

async function db021checkA() {
  console.log('\n=== db/021 CHECK A: outcome_filler updates ret_5d_split_in_window (granted by db/021), real row, toggle + restore ===');
  // No "all four ret_* filled" requirement: this step runs strictly after
  // the filler step completes in the same job (separate sequential
  // steps, not concurrent), so Pass 1's real writes are already done by
  // the time this query runs -- any row with the flag currently false is
  // safe to toggle, regardless of whether its ret_* columns are filled.
  const rowRes = await fetch(
    `${SUPABASE_URL}/rest/v1/signal_log?select=id,ret_5d_split_in_window&ret_5d_split_in_window=eq.false&limit=1`,
    { headers: anonHeaders }
  );
  const rows = await rowRes.json();
  if (!rows.length) { console.log('No signal_log row found with ret_5d_split_in_window=false -- cannot run this check. Skipped.'); return; }
  const { id } = rows[0];
  console.log(`Using real signal_log row id=${id} -- toggling ret_5d_split_in_window true then back to false, re-selecting after each write`);

  const setTrue = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
    method: 'PATCH', headers: { ...roleHeaders, Prefer: 'return=representation' }, body: JSON.stringify({ ret_5d_split_in_window: true }),
  });
  await dump('db/021 CHECK A: PATCH ret_5d_split_in_window=true', setTrue, {
    ok: 'role switch happened AND ret_5d_split_in_window is genuinely writable by this role',
    jwtRejected401: 'JWT itself was rejected',
    requestRejected400: 'malformed request -- fix and re-run',
    permissionRejected: 'UNEXPECTED -- db/021\'s grant is not doing its job, check it was applied',
    weakEmptyOrFiltered: 'the row was invisible to this role (RLS filtered it) rather than the update being denied outright',
  });
  const verifyTrue = await (await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}&select=ret_5d_split_in_window`, { headers: anonHeaders })).json();
  const landedTrue = verifyTrue[0]?.ret_5d_split_in_window;
  console.log(`re-select (anon key) ret_5d_split_in_window = ${landedTrue} -- expect true`);
  if (landedTrue !== true) {
    console.error('db/021 CHECK A: the write did not actually land (re-select disagrees with a 2xx status) -- this is the PostgREST-200-empty-body RLS no-op this whole pass exists to catch. Report this, do not restore blindly if the row is now in an unexpected state.');
  }

  const setFalse = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
    method: 'PATCH', headers: { ...roleHeaders, Prefer: 'return=representation' }, body: JSON.stringify({ ret_5d_split_in_window: false }),
  });
  await dump('db/021 CHECK A: restore PATCH ret_5d_split_in_window=false', setFalse, {
    ok: 'restore write accepted',
    jwtRejected401: 'JWT rejected on the restore write -- row may be left at true, needs manual fix',
    requestRejected400: 'malformed restore request -- row may be left at true, needs manual fix',
    permissionRejected: 'UNEXPECTED on a column already proven writable above -- row may be left at true, needs manual fix',
    weakEmptyOrFiltered: 'row invisible on the restore write -- row may be left at true, needs manual fix',
  });
  const verifyFalse = await (await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}&select=ret_5d_split_in_window`, { headers: anonHeaders })).json();
  console.log(`re-select (anon key) ret_5d_split_in_window = ${verifyFalse[0]?.ret_5d_split_in_window} -- expect false (restored)`);
}

async function db021checkB() {
  console.log('\n=== db/021 CHECK B: outcome_filler attempts signal_log.reference_price (NOT in any grant for this role), real row, self-write ===');
  const rowRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?select=id,reference_price&limit=1`, { headers: anonHeaders });
  const rows = await rowRes.json();
  if (!rows.length) { console.log('No signal_log rows exist -- cannot run this check meaningfully.'); return; }
  const { id, reference_price } = rows[0];
  console.log(`Using real signal_log row id=${id}, current reference_price=${reference_price} -- PATCHing this SAME value back (safe either way it lands)`);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
    method: 'PATCH', headers: roleHeaders, body: JSON.stringify({ reference_price }),
  });
  await dump('db/021 CHECK B: PATCH signal_log.reference_price (real row, same value)', res, {
    ok: 'UNEXPECTED -- if this succeeds, no column grant is narrowing this role\'s access to reference_price',
    jwtRejected401: 'JWT rejected outright, unrelated to reference_price specifically',
    requestRejected400: 'malformed request -- fix and re-run',
    permissionRejected: 'expected and informative -- reference_price is correctly outside every grant this role has',
    weakEmptyOrFiltered: 'ambiguous against a known-real id -- investigate before trusting either way',
  });
  const verify = await (await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}&select=reference_price`, { headers: anonHeaders })).json();
  console.log(`re-select (anon key) reference_price = ${verify[0]?.reference_price} -- expect ${reference_price} (unchanged)`);
}

async function main() {
  await db019checkB();
  await db021checkA();
  await db021checkB();
}

main().catch(e => { console.error('FAILED', e.message, e.stack); process.exit(1); });
