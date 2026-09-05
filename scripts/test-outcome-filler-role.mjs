#!/usr/bin/env node
// Verification for db/009's throwaway outcome_filler_test role. Needs
// the JWT from sign-supabase-role-jwt.mjs, which needs the project's
// JWT secret -- neither the secret nor the resulting token is ever
// printed by this script. This script's own console output is meant to
// be pasted into chat for review, so anything it prints is disclosed --
// it only ever logs HTTP response status/body, never the request
// headers or either credential. The anon key used for insert/select/
// cleanup below is already public by design (embedded in
// core/store.js), so it isn't sensitive the same way.
//
// PRINTS RAW STATUS + BODY FOR EVERY CHECK, no pass/fail scoring. The
// distinction that actually matters here is 401 (JWT rejected outright --
// bad signature or malformed claims, checked before RLS/grants are ever
// consulted) versus 403, or a 200/206 with an empty/short result (JWT
// accepted, role switch happened, and RLS or the column grant is what
// blocked the request). A pass/fail summary would collapse exactly that
// distinction -- which is the whole point of running this before the
// real job gets built on top of it.
//
// Usage (PowerShell, after running db/009's role-creation SQL):
//   $env:SUPABASE_JWT_SECRET = '<from Supabase dashboard>'
//   $token = node scripts/sign-supabase-role-jwt.mjs outcome_filler_test 1
//   $env:OUTCOME_FILLER_TEST_JWT = $token
//   node scripts/test-outcome-filler-role.mjs
//
// Report back the FULL console output, not a summary. Then run
// db/009b_cleanup.sql regardless of the result.
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
const TEST_JWT = process.env.OUTCOME_FILLER_TEST_JWT;

if (!TEST_JWT) {
  console.error('Set OUTCOME_FILLER_TEST_JWT first (output of sign-supabase-role-jwt.mjs). This message intentionally does not echo the env var even if it were set wrong.');
  process.exit(1);
}

const anonHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
// apikey stays the anon key even for the role-scoped request -- Supabase
// uses apikey only to authorize reaching the project's PostgREST at all;
// Authorization's JWT is what determines the Postgres role for the query.
const roleHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${TEST_JWT}`, 'Content-Type': 'application/json' };

// Never pass `res` or any headers object to console.log directly --
// only ever status/statusText/body, extracted explicitly. Guards against
// an accidental `console.log(res)`-style change later dumping the
// Authorization header (and therefore the JWT) into output that gets
// pasted into chat.
async function dump(label, res, meaningIfOk, meaningIf401, meaningIfBlocked) {
  const body = await res.text();
  console.log(`\n--- ${label} ---`);
  console.log(`status: ${res.status} ${res.statusText}`);
  console.log(`body: ${body}`);
  if (res.status === 401) console.log(`READ AS: ${meaningIf401}`);
  else if (res.status >= 400) console.log(`READ AS: ${meaningIfBlocked}`);
  else console.log(`READ AS: ${meaningIfOk} (still confirm against the follow-up re-select below, not this status alone)`);
  return body;
}

async function main() {
  console.log('=== 1. INSERT dummy signal_log row via anon key (already-proven path) ===');
  const dummy = {
    signal_date: '2026-09-05', symbol: '__ROLE_TEST__', engine_source: 'EDGE', tier: 'TEST',
    first_shown_at: new Date().toISOString(), signal_snapshot: { test: true }, reference_price: 1.23,
  };
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log`, {
    method: 'POST', headers: { ...anonHeaders, Prefer: 'return=representation' }, body: JSON.stringify(dummy),
  });
  const insertBody = await insertRes.json();
  const id = Array.isArray(insertBody) && insertBody[0] ? insertBody[0].id : null;
  console.log(`status: ${insertRes.status}, id: ${id}`);
  if (!id) { console.error('Cannot continue without a row.'); process.exit(1); }

  console.log('\n=== CHECK A: outcome_filler_test JWT updates ret_5m (granted) ===');
  const okRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
    method: 'PATCH', headers: { ...roleHeaders, Prefer: 'return=representation' }, body: JSON.stringify({ ret_5m: 0.05 }),
  });
  await dump('CHECK A: PATCH ret_5m',
    okRes,
    'role switch happened AND ret_5m is genuinely writable by this role',
    'JWT itself was rejected -- signature/claims/role-doesn\'t-exist problem, nothing about RLS or grants was reached',
    'role switch may have happened but something (schema usage, the policy, or the column grant) still blocks this -- see whether Step 2 of db/009 was run completely');
  const verifyA = await (await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}&select=ret_5m`, { headers: anonHeaders })).json();
  console.log(`re-select (anon key) ret_5m = ${verifyA[0]?.ret_5m} -- expect 0.05 for this check to actually mean what CHECK A says it means`);

  console.log('\n=== CHECK B: same JWT updates ret_15m (NOT column-granted) ===');
  const badColRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
    method: 'PATCH', headers: { ...roleHeaders, Prefer: 'return=representation' }, body: JSON.stringify({ ret_15m: 0.09 }),
  });
  await dump('CHECK B: PATCH ret_15m',
    badColRes,
    'UNEXPECTED -- if this succeeds, the column grant is not actually narrowing anything and the whole design needs re-checking',
    'JWT rejected outright -- same meaning as check A\'s 401 case, unrelated to column scoping',
    'the column grant is doing real work -- this is the expected, informative result IF check A succeeded');
  const verifyB = await (await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}&select=ret_15m`, { headers: anonHeaders })).json();
  console.log(`re-select (anon key) ret_15m = ${verifyB[0]?.ret_15m} -- expect null (unchanged) for check B to mean what it claims`);

  console.log('\n=== CHECK C: same JWT attempts UPDATE on trades_v2 (different table) ===');
  const badTableRes = await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?limit=1`, {
    method: 'PATCH', headers: roleHeaders, body: JSON.stringify({ pnl_dollars: 999999 }),
  });
  await dump('CHECK C: PATCH trades_v2',
    badTableRes,
    'UNEXPECTED -- the role has reached a table it was never granted anything on',
    'JWT rejected outright, unrelated to trades_v2 specifically',
    'expected -- no grant, no policy, on this table for this role');

  console.log('\n=== CHECK D: same JWT attempts SELECT on trades_v2 (also not granted) ===');
  const badSelectRes = await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?limit=1`, { headers: roleHeaders });
  await dump('CHECK D: GET trades_v2',
    badSelectRes,
    'UNEXPECTED -- same concern as check C',
    'JWT rejected outright, unrelated to trades_v2 specifically',
    'expected -- no grant, no policy, on this table for this role');

  console.log(`\n=== cleanup needed via SQL editor (test row, then db/009b_cleanup.sql in full) ===`);
  console.log(`delete from signal_log where id = '${id}';`);
  console.log(`-- then run db/009b_cleanup.sql`);
}

main().catch(e => { console.error('FAILED', e.message, e.stack); process.exit(1); });
