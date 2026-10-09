#!/usr/bin/env node
// db/023 grant boundary checks A-E (see db/023_workflow_runs.sql header).
// Runs as anon (the public key every workflow uses). Every refusal is
// proven BY RE-SELECT, never by status code alone -- a column-grant refusal
// is a different code path from RLS, and PostgREST's 200-with-empty-body
// has hidden this class of bug before. Exits non-zero on any failure.
//
// Leaves exactly one row behind, workflow_name='db023-verify' (anon has no
// delete path, by design). Delay queries filter it out.

const URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co/rest/v1/workflow_runs';
const KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const NAME = 'db023-verify';

let failed = false;
const pass = (m) => console.log(`PASS  ${m}`);
const fail = (m) => { console.log(`FAIL  ${m}`); failed = true; };

async function req(method, query, body, prefer) {
  const res = await fetch(`${URL}${query}`, { method, headers: { ...H, ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}
const reselect = async (id) => (await req('GET', `?id=eq.${id}&select=*`)).json?.[0];

const T = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();

// A -- insert with exactly the five granted columns.
const a = await req('POST', '', { workflow_name: NAME, trigger_type: 'workflow_dispatch', declared_cron: null, actual_fired_at: T, run_url: 'db023 verification' }, 'return=representation');
const id = a.json?.[0]?.id;
if (a.status >= 300 || !id) { fail(`A insert: HTTP ${a.status} ${a.text.slice(0, 200)}`); process.exit(1); }
const rowA = await reselect(id);
const skewSec = Math.abs(new Date(rowA.created_at) - Date.now()) / 1000;
const outcomesNull = rowA && rowA.completed_at == null && rowA.job_status == null && rowA.is_noop == null && rowA.noop_reason == null;
if (rowA && sameInstant(rowA.actual_fired_at, T) && skewSec < 120 && outcomesNull) pass(`A insert landed; created_at is server time (${skewSec.toFixed(1)}s from local clock); all four outcome columns NULL (none fabricated)`);
else fail(`A re-select: ${JSON.stringify(rowA)}`);

// B -- actual_fired_at alone must be refused.
const earlier = new Date(new Date(T).getTime() - 86400000).toISOString();
const b = await req('PATCH', `?id=eq.${id}`, { actual_fired_at: earlier });
const rowB = await reselect(id);
if (sameInstant(rowB.actual_fired_at, T)) pass(`B actual_fired_at unchanged by re-select (HTTP ${b.status}${b.json?.code ? ', ' + b.json.code : ''})`);
else fail(`B actual_fired_at MOVED to ${rowB.actual_fired_at} (HTTP ${b.status})`);
if (b.status < 400) fail(`B expected a refusal status, got HTTP ${b.status} -- re-select is what matters, but a silent 2xx means the grant is not what refused it`);

// C -- adversarial mixed body: the WHOLE statement must be refused.
const c = await req('PATCH', `?id=eq.${id}`, { completed_at: new Date().toISOString(), job_status: 'success', is_noop: true, noop_reason: 'check C', actual_fired_at: earlier });
const rowC = await reselect(id);
const untouched = rowC.completed_at == null && rowC.job_status == null && rowC.is_noop == null && rowC.noop_reason == null && sameInstant(rowC.actual_fired_at, T);
if (untouched) pass(`C mixed PATCH refused as a whole -- all five columns unchanged by re-select (HTTP ${c.status}${c.json?.code ? ', ' + c.json.code : ''})`);
else fail(`C PARTIAL OR FULL APPLICATION: ${JSON.stringify({ completed_at: rowC.completed_at, job_status: rowC.job_status, is_noop: rowC.is_noop, noop_reason: rowC.noop_reason, actual_fired_at: rowC.actual_fired_at })}`);

// D -- insert with a forged created_at must be refused.
const d = await req('POST', '', { workflow_name: NAME, trigger_type: 'workflow_dispatch', actual_fired_at: T, created_at: '2020-01-01T00:00:00Z' }, 'return=representation');
const forged = (await req('GET', `?workflow_name=eq.${NAME}&created_at=lt.2021-01-01&select=id`)).json || [];
if (forged.length === 0) pass(`D forged created_at refused -- no 2020 row by re-select (HTTP ${d.status}${d.json?.code ? ', ' + d.json.code : ''})`);
else fail(`D a row with created_at in 2020 EXISTS: ${JSON.stringify(forged)}`);
const extra = (await req('GET', `?workflow_name=eq.${NAME}&select=id`)).json || [];
if (extra.length !== 1) fail(`D expected exactly 1 ${NAME} row (A's), found ${extra.length}`);

// E -- the four outcome columns alone must still update (the workflows depend on it).
const doneAt = new Date().toISOString();
const e = await req('PATCH', `?id=eq.${id}`, { completed_at: doneAt, job_status: 'success', is_noop: true, noop_reason: 'db023 check E' });
const rowE = await reselect(id);
if (sameInstant(rowE.completed_at, doneAt) && rowE.job_status === 'success' && rowE.is_noop === true && rowE.noop_reason === 'db023 check E' && sameInstant(rowE.actual_fired_at, T))
  pass(`E outcome-only PATCH landed, actual_fired_at still intact (HTTP ${e.status})`);
else fail(`E outcome PATCH did not land: HTTP ${e.status} ${JSON.stringify(rowE)}`);

console.log(failed ? '\ndb/023 grant checks: FAILED' : '\ndb/023 grant checks: all passed');
process.exit(failed ? 1 : 0);
