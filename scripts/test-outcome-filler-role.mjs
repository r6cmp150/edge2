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
// PRINTS RAW STATUS + BODY FOR EVERY CHECK, no pass/fail scoring.
//
// READ-AS BUCKETS, and why there are four of them, not two (fixed
// 2026-09-05 after check C's first run: an unfiltered PATCH tripped
// PostgREST's own "UPDATE requires a WHERE clause" guard -- HTTP 400,
// code 21000 -- and the old two-bucket logic (401 vs "anything else >=
// 400 means blocked as expected") reported that as a correct rejection.
// It wasn't evidence of anything: the request never reached Postgres's
// permission layer at all, so grants/RLS/the role were never consulted.
// A right-looking result for a reason that has nothing to do with what
// the check claims to measure -- same family as the schema-usage gap
// 009 itself already went through one review round for):
//   - 400  : PostgREST's OWN request-validation rejected this before
//            Postgres ever saw it (e.g. an unfiltered mutation). NOT
//            evidence about grants/RLS/the role either way. The check is
//            malformed, not informative -- fix the request, don't trust
//            the status.
//   - 401  : the JWT itself was rejected (signature/claims/role-doesn't-
//            exist) -- also before RLS/grants are consulted, but this
//            IS informative: it means the credential mechanism failed.
//   - 403 / a body naming a specific error code (e.g. 42501 permission
//     denied) : the JWT was honored, the role switch happened, and
//     Postgres's permission layer (missing grant, or RLS with no
//     matching policy) is what blocked the request. This is the real,
//     informative rejection these checks are looking for.
//   - 404, or a 2xx with an empty body/result : weaker than the above --
//     the role reached the table and RLS silently filtered the row from
//     view, rather than the request being denied outright. Still means
//     the role couldn't act on that row, but it's a DIFFERENT claim than
//     "permission denied," and reporting it as an ordinary rejection
//     would hide that difference.
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

async function checkA() {
  console.log('\n=== 1. INSERT dummy signal_log row via anon key (already-proven path) ===');
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

  console.log('\n=== CHECK A: outcome_filler_test JWT updates ret_5m (granted, filtered by id) ===');
  const okRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
    method: 'PATCH', headers: { ...roleHeaders, Prefer: 'return=representation' }, body: JSON.stringify({ ret_5m: 0.05 }),
  });
  await dump('CHECK A: PATCH ret_5m', okRes, {
    ok: 'role switch happened AND ret_5m is genuinely writable by this role',
    jwtRejected401: 'JWT itself was rejected -- signature/claims/role-doesn\'t-exist problem, nothing about RLS or grants was reached',
    requestRejected400: 'the request itself was malformed -- not evidence about the role at all, fix the request and re-run',
    permissionRejected: 'role switch may have happened but something (schema usage, the policy, or the column grant) still blocks this -- check whether Step 2 of db/009 was run completely',
    weakEmptyOrFiltered: 'the row was invisible to this role (RLS filtered it) rather than the update being denied outright -- weaker than a real permission check for this specific case',
  });
  const verifyA = await (await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}&select=ret_5m`, { headers: anonHeaders })).json();
  console.log(`re-select (anon key) ret_5m = ${verifyA[0]?.ret_5m} -- expect 0.05 for this check to actually mean what CHECK A says it means`);

  return id;
}

async function checkB(id) {
  console.log('\n=== CHECK B: same JWT updates ret_15m (NOT column-granted, filtered by id) ===');
  const badColRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
    method: 'PATCH', headers: { ...roleHeaders, Prefer: 'return=representation' }, body: JSON.stringify({ ret_15m: 0.09 }),
  });
  await dump('CHECK B: PATCH ret_15m', badColRes, {
    ok: 'UNEXPECTED -- if this succeeds, the column grant is not actually narrowing anything and the whole design needs re-checking',
    jwtRejected401: 'JWT rejected outright -- same meaning as check A\'s 401 case, unrelated to column scoping',
    requestRejected400: 'the request itself was malformed -- not evidence about column scoping, fix the request and re-run',
    permissionRejected: 'the column grant is doing real work -- this is the expected, informative result IF check A succeeded',
    weakEmptyOrFiltered: 'the row was invisible to this role rather than the column update being denied outright -- weaker evidence than an explicit permission error',
  });
  const verifyB = await (await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}&select=ret_15m`, { headers: anonHeaders })).json();
  console.log(`re-select (anon key) ret_15m = ${verifyB[0]?.ret_15m} -- expect null (unchanged) for check B to mean what it claims`);
}

async function checkC() {
  console.log('\n=== CHECK C: same JWT attempts UPDATE on trades_v2 (different table), filtered by a random id ===');
  // 2026-09-05 fix: the first version used `?limit=1` with no actual
  // filter, which PostgREST's own unfiltered-mutation guard rejects with
  // 400/code 21000 ("UPDATE requires a WHERE clause") before Postgres's
  // permission layer is ever consulted -- a right-looking rejection for a
  // reason that has nothing to do with grants or RLS. A filter on a
  // RANDOM, almost-certainly-nonexistent id is enough: what matters is
  // that the request is well-formed enough to REACH the permission
  // layer, not that it matches a real row.
  const randomId = crypto.randomUUID();
  const badTableRes = await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?id=eq.${randomId}`, {
    method: 'PATCH', headers: roleHeaders, body: JSON.stringify({ pnl_dollars: 999999 }),
  });
  await dump('CHECK C: PATCH trades_v2 (filtered)', badTableRes, {
    ok: 'UNEXPECTED -- the role has reached a table it was never granted anything on',
    jwtRejected401: 'JWT rejected outright, unrelated to trades_v2 specifically',
    requestRejected400: 'STILL malformed even with a filter -- check the filter syntax, this result is still not evidence about the role',
    permissionRejected: 'expected and informative -- no grant, no policy, on this table for this role, and the permission layer is what said so',
    weakEmptyOrFiltered: 'ambiguous for this specific check, since the id is random and the row was never expected to exist -- a 404/empty result here does NOT distinguish "no such row" from "row exists but RLS hid it," so this outcome doesn\'t confirm or refute the permission block the way check B\'s does. Not strong evidence either way.',
  });
}

async function checkD() {
  console.log('\n=== CHECK D: same JWT attempts SELECT on trades_v2 (also not granted) ===');
  const badSelectRes = await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?limit=1`, { headers: roleHeaders });
  await dump('CHECK D: GET trades_v2', badSelectRes, {
    ok: 'UNEXPECTED -- same concern as check C',
    jwtRejected401: 'JWT rejected outright, unrelated to trades_v2 specifically',
    requestRejected400: 'not expected for a plain SELECT -- investigate before trusting this result',
    permissionRejected: 'expected -- no grant, no policy, on this table for this role',
    weakEmptyOrFiltered: 'trades_v2 genuinely has rows, so an empty result here would mean RLS hid them rather than an outright denial -- still means the role can\'t read them, but note the distinction',
  });
}

const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];

async function main() {
  if (ONLY === 'C') {
    await checkC();
    return;
  }
  const id = await checkA();
  await checkB(id);
  await checkC();
  await checkD();

  console.log(`\n=== cleanup needed via SQL editor (test row, then db/009b_cleanup.sql in full) ===`);
  console.log(`delete from signal_log where id = '${id}';`);
  console.log(`-- then run db/009b_cleanup.sql`);
}

main().catch(e => { console.error('FAILED', e.message, e.stack); process.exit(1); });
