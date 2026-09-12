#!/usr/bin/env node
// Verification for db/017's PRODUCTION outcome_filler role -- not the
// throwaway outcome_filler_test from db/009 (that one only ever proved
// zero access to trades_v2; this role legitimately has SELECT there, so
// the interesting boundary is read-yes/write-no, not table-level
// presence/absence). Needs the JWT from sign-supabase-role-jwt.mjs signed
// for role="outcome_filler".
//
// PRINTS RAW STATUS + BODY FOR EVERY CHECK, no pass/fail scoring -- same
// four-bucket reading as scripts/test-outcome-filler-role.mjs, copied
// rather than imported since these two scripts test different roles with
// different grant shapes and shouldn't share a code path that could drift
// out of sync with either one's actual grants.
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
const ROLE_JWT = process.env.OUTCOME_FILLER_JWT;

if (!ROLE_JWT) {
  console.error('Set OUTCOME_FILLER_JWT first (output of sign-supabase-role-jwt.mjs outcome_filler). This message intentionally does not echo the env var even if it were set wrong.');
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

async function setup() {
  // signal_log.scan_session is NOT NULL with a real FK to scan_runs(id)
  // (db/010) -- a dummy signal_log row needs a real scan_runs row to
  // point at first, or the insert 400s on the NOT NULL/FK constraint
  // before any check ever runs. Found live (2026-09-10): the first
  // version of this script omitted scan_session entirely, the insert
  // 400'd, and the setup step printed status+id but not body -- exactly
  // the swallowed-diagnostic-information mistake this project keeps
  // catching elsewhere, just in a test script instead of application
  // code. Both inserts below go through dump() now, same as every real
  // check, so a failure here is as legible as a failure anywhere else.
  console.log('\n=== SETUP 1: INSERT dummy scan_runs row via anon key ===');
  const dummyRun = {
    id: crypto.randomUUID(),
    engine_source: 'EDGE',
    session: 'AH',
    scan_date: '2026-09-10',
    started_at: new Date().toISOString(),
    universe_source: 'static-universe-list',
    universe_count: 1,
    evaluated_count: 0,
  };
  const runRes = await fetch(`${SUPABASE_URL}/rest/v1/scan_runs`, {
    method: 'POST', headers: { ...anonHeaders, Prefer: 'return=representation' }, body: JSON.stringify(dummyRun),
  });
  const runBody = await dump('SETUP 1: POST scan_runs', runRes, {
    ok: 'disposable parent row created -- proceeding to the child signal_log row',
    requestRejected400: 'the dummy scan_runs payload itself violates a constraint -- read the body above for which column, this is not evidence about outcome_filler at all',
    permissionRejected: 'UNEXPECTED -- anon should have insert on scan_runs (db/010); check the anon insert policy',
  });
  let runParsed;
  try { runParsed = JSON.parse(runBody); } catch { runParsed = null; }
  const scanRunId = Array.isArray(runParsed) && runParsed[0] ? runParsed[0].id : null;
  if (!scanRunId) throw new Error('Cannot continue without a scan_runs row -- see body above.');

  console.log('\n=== SETUP 2: INSERT dummy signal_log row via anon key (scan_session = the scan_runs row above) ===');
  const dummy = {
    signal_date: '2026-09-10', symbol: '__ROLE_TEST__', engine_source: 'EDGE', tier: 'TEST',
    first_shown_at: new Date().toISOString(), signal_snapshot: { test: true }, reference_price: 1.23,
    scan_session: scanRunId,
  };
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log`, {
    method: 'POST', headers: { ...anonHeaders, Prefer: 'return=representation' }, body: JSON.stringify(dummy),
  });
  const insertBody = await dump('SETUP 2: POST signal_log', insertRes, {
    ok: 'disposable child row created -- proceeding to the role checks',
    requestRejected400: 'the dummy signal_log payload violates a constraint -- read the body above for which column (this is where the missing-scan_session bug showed up before the fix)',
    permissionRejected: 'UNEXPECTED -- anon should have insert on signal_log (db/001); check the anon insert policy',
  });
  let insertParsed;
  try { insertParsed = JSON.parse(insertBody); } catch { insertParsed = null; }
  const id = Array.isArray(insertParsed) && insertParsed[0] ? insertParsed[0].id : null;
  if (!id) throw new Error('Cannot continue without a signal_log row -- see body above. (Disposable scan_runs row ' + scanRunId + ' still needs cleanup either way.)');

  return { id, scanRunId };
}

async function checkA(id) {
  console.log('\n=== CHECK A: outcome_filler updates ret_5m (granted, filtered by id) ===');
  const okRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
    method: 'PATCH', headers: { ...roleHeaders, Prefer: 'return=representation' }, body: JSON.stringify({ ret_5m: 0.05 }),
  });
  await dump('CHECK A: PATCH signal_log.ret_5m', okRes, {
    ok: 'role switch happened AND ret_5m is genuinely writable by this role',
    jwtRejected401: 'JWT itself was rejected -- signature/claims/role-doesn\'t-exist problem',
    requestRejected400: 'the request itself was malformed -- fix and re-run, not evidence about the role',
    permissionRejected: 'role switch may have happened but something (schema usage, the policy, or the column grant) still blocks this -- check db/017 was run completely',
    weakEmptyOrFiltered: 'the row was invisible to this role (RLS filtered it) rather than the update being denied outright',
  });
  const verifyA = await (await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}&select=ret_5m`, { headers: anonHeaders })).json();
  console.log(`re-select (anon key) ret_5m = ${verifyA[0]?.ret_5m} -- expect 0.05`);
}

async function checkB(id) {
  console.log('\n=== CHECK B: outcome_filler attempts reference_price (NOT column-granted, filtered by id) ===');
  const badColRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}`, {
    method: 'PATCH', headers: { ...roleHeaders, Prefer: 'return=representation' }, body: JSON.stringify({ reference_price: 999.99 }),
  });
  await dump('CHECK B: PATCH signal_log.reference_price', badColRes, {
    ok: 'UNEXPECTED -- if this succeeds, the column grant is not narrowing anything and db/017 needs re-checking',
    jwtRejected401: 'JWT rejected outright, unrelated to column scoping',
    requestRejected400: 'the request itself was malformed -- fix and re-run',
    permissionRejected: 'the column grant is doing real work -- expected, informative result',
    weakEmptyOrFiltered: 'the row was invisible to this role rather than the column update being denied outright',
  });
  const verifyB = await (await fetch(`${SUPABASE_URL}/rest/v1/signal_log?id=eq.${id}&select=reference_price`, { headers: anonHeaders })).json();
  console.log(`re-select (anon key) reference_price = ${verifyB[0]?.reference_price} -- expect 1.23 (unchanged)`);
}

async function checkTradesV2Select() {
  console.log('\n=== POSITIVE CONTROL: outcome_filler reads trades_v2 (needed for taken-resolution fallback matching) ===');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?limit=1&select=id,ticker,buy_date,source,engine_source`, { headers: roleHeaders });
  await dump('trades_v2 SELECT', res, {
    ok: 'expected -- the fallback-match read path actually works',
    jwtRejected401: 'JWT rejected outright',
    permissionRejected: 'UNEXPECTED -- db/017\'s trades_v2 select grant/policy is missing or wrong; the fallback-match step in the fill script cannot work without this',
    weakEmptyOrFiltered: 'either trades_v2 genuinely has no rows, or RLS hid them -- if trades_v2 is known non-empty, this is the same concern as permissionRejected',
  });
}

async function checkE() {
  console.log('\n=== CHECK E (db/017): outcome_filler attempts UPDATE on trades_v2, a REAL row, a column it has no grant on ===');
  const rowRes = await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?limit=1&select=id,pnl_dollars`, { headers: anonHeaders });
  const rows = await rowRes.json();
  if (!rows.length) {
    console.log('No trades_v2 rows exist to test against -- cannot run check E meaningfully. Report this, not a false pass.');
    return;
  }
  const { id: realId, pnl_dollars: originalPnl } = rows[0];
  console.log(`Using real trades_v2 row id=${realId}, current pnl_dollars=${originalPnl}`);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?id=eq.${realId}`, {
    method: 'PATCH', headers: roleHeaders, body: JSON.stringify({ pnl_dollars: 999999 }),
  });
  await dump('CHECK E: PATCH trades_v2.pnl_dollars (real row)', res, {
    ok: 'UNEXPECTED AND SERIOUS -- this role just rewrote a real trade record it should have zero write access to. Do not proceed to the fill script until this is understood.',
    jwtRejected401: 'JWT rejected outright, unrelated to trades_v2 specifically',
    requestRejected400: 'malformed request -- fix and re-run, this result is not evidence about the role',
    permissionRejected: 'expected and informative -- this role has SELECT but no UPDATE grant on trades_v2, and the permission layer is what said so. This is the check db/009\'s check C never completed.',
    weakEmptyOrFiltered: 'ambiguous -- should not happen against a known-real id, investigate before trusting either way',
  });
  const verify = await (await fetch(`${SUPABASE_URL}/rest/v1/trades_v2?id=eq.${realId}&select=pnl_dollars`, { headers: anonHeaders })).json();
  console.log(`re-select (anon key) pnl_dollars = ${verify[0]?.pnl_dollars} -- expect ${originalPnl} (unchanged)`);
}

async function main() {
  const { id, scanRunId } = await setup();
  await checkA(id);
  await checkB(id);
  await checkTradesV2Select();
  await checkE();

  // Neither table has a delete policy for anon (by design -- see db/001
  // and db/010's own RLS comments), so cleanup goes through the SQL
  // editor, same as db/009's dummy row. FK order matters: signal_log
  // (child, references scan_runs via scan_session) must be deleted
  // before scan_runs (parent), or the delete on scan_runs fails against
  // its own FK.
  console.log(`\n=== cleanup needed via SQL editor (child before parent) ===`);
  console.log(`delete from signal_log where id = '${id}';`);
  console.log(`delete from scan_runs where id = '${scanRunId}';`);
}

main().catch(e => { console.error('FAILED', e.message, e.stack); process.exit(1); });
