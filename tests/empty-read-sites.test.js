// tests/empty-read-sites.test.js — 2026-11-02. Row-level security answers a
// read it won't allow with an EMPTY LIST, not an error. Any code that reads
// a collection and treats empty as a meaningful state ("nothing migrated
// yet", "no positions", "not landed", "no trade followed this signal") will
// act on a denied read as if it were true. Under the auth plan's uid-keyed
// policies every session not signed in as Roman reads empty everywhere, so
// this is a prerequisite of auth step 5 (claude/db-exposure-and-auth-plan.md).
//
// This test enumerates every Supabase READ in the app (supabase-js chains
// with .select(, including write-then-select) and in every script the
// workflows run (plus the libs they import), and requires each to be
// classified below: what empty means today, what it would mean under a
// denied read, and a verdict. It fails both ways: a read nobody classified,
// and a classification whose read no longer exists. Keyed by file|table,
// not line, so ordinary edits don't break it; a NEW read on the same
// file|table changes the count and must be classified.
//
// Verdicts: OK (empty is handled, or a denied read can't mislead),
// SILENT (empty is shown or logged as "none" with no error: misleads, writes
// nothing), PASS_ON_EMPTY (a check that succeeds when it read nothing),
// WRITES_FROM_EMPTY (acts on the empty result by writing: the worst class).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSource, run, REPO_ROOT } = require('./_lib');

const W = 'WRITES_FROM_EMPTY', S = 'SILENT', P = 'PASS_ON_EMPTY', OK = 'OK';
const REGISTRY = {
  'app.js|settings': [
    { verdict: OK, empty: 'testSupabaseConnection: only the error is read; empty = connected', denied: 'connected (true), which it is' }],
  'app.js|rating_snapshots': [
    { verdict: OK, empty: 'retryRatingWrites positive control: the table is never empty, so an empty read = CANNOT TELL', denied: 'CANNOT TELL: nothing retried, every batch kept, banner says why (fixed 2026-11-02; was WRITES_FROM_EMPTY)' },
    { verdict: OK, empty: 'retryRatingWrites landed check: no rows at that captured_at = not landed', denied: 'only reached once the control has read a row, so an empty here is a real "not landed"' },
    { verdict: S, empty: 'score-history report: "no data"', denied: 'report says no history exists' },
    { verdict: S, empty: 'quota panel count = 0', denied: 'shows 0 rows used' },
    { verdict: S, empty: 'archive report: snapshot read swallowed (catch {})', denied: 'archive silently omits snapshots' }],
  'app.js|trades_v2': [
    { verdict: S, empty: 'sale insert ... .select(\'id\') (4,161 chars after .from: the read a 400-char window missed): no error and no row back = ZERO rows inserted (only a BEFORE INSERT trigger returning NULL does that; none live on trades_v2), yet recorded WRITTEN: the sale is not in the database and nothing says so (corrected 2026-11-08; fix carried in change 2)', denied: 'a denied RETURNING row is not an empty body: it is a 42501 error and nothing is inserted (harness, Postgres 18.6, 2026-11-08), so the sale is SALE_FAILED and queued for Retry. This entry used to say "WRITTEN (correct)", which was false' },
    { verdict: S, empty: 'checkPositionsStillOpen: per open position, .eq + .limit(1); no row = its sale is not in trades_v2, no "still open" line (2026-11-08)', denied: 'every position reads back empty: no line, and a ghost goes unreported; an ERROR is reported as a read problem, never as "none found"' },
    { verdict: OK, empty: 'loadSoldFromSupabase: trades_v2 is never empty, so empty = cannot tell', denied: 'keeps the phone\'s copy, banner says the Sold list read back empty' + ' (fixed 2026-11-02; was WRITES_FROM_EMPTY: overwrote the cache)' },
    { verdict: S, empty: 'report: falls back to state.sold', denied: 'report runs on whatever local copy is left' },
    { verdict: S, empty: 'quota panel count = 0', denied: 'shows 0 trades' },
    { verdict: S, empty: 'archive: "No trades in Supabase to archive yet."', denied: 'says no trades exist' },
    { verdict: S, empty: 'export: writes a file with sold = []', denied: 'a backup file with no trades, downloaded as if complete' }],
  'app.js|analysis_periods': [
    { verdict: OK, empty: 'load: empty with periods already on this phone = cannot tell', denied: 'keeps the phone\'s periods, banner says so (fixed 2026-11-02; was WRITES_FROM_EMPTY)' },
    { verdict: S, empty: 'start period: insert().select() then data[0]', denied: 'insert lands, select reads empty, data[0] is undefined: throws after the write succeeded' }],
  'app.js|workflow_runs': [
    { verdict: OK, empty: 'health panel: every job red, "no run recorded"', denied: 'loud false alarm, misleads nobody into acting as if healthy' }],
  'core/store.js|portfolio': [
    { verdict: S, empty: 'loadPortfolioFromSupabase: no positions', denied: 'portfolio shown empty; the add form and sale flow carry on as if he holds nothing' },
    { verdict: OK, empty: 'savePositionToSupabase: update().select() matched no row -> existence check', denied: 'goes to the existence check (next entry)' },
    { verdict: S, empty: 'existence check: no row = POSITION_MISSING, "closed in another session"', denied: 'refuses safely, but names the wrong cause' },
    { verdict: OK, empty: 'deletePositionFromSupabase: delete().select() removed no row -> existence check (2026-11-08; was "no error = deleted")', denied: 'goes to the existence check (next entry)' },
    { verdict: S, empty: 'delete existence check: no row = ALREADY_GONE; the sale goes on to the insert, where trades_v2_position_id_once refuses a second copy', denied: 'reads as ALREADY_GONE: no sale is lost or doubled (the index decides), but a row still there would go unreported' }],
  'core/store.js|settings': [
    { verdict: S, empty: 'loadSettingsFromSupabase: no row = "nothing migrated yet", runs on defaults', denied: 'budget 500, sub-$2 hidden, overlay ON, nothing on screen' },
    { verdict: OK, empty: 'saveSettingsToSupabase: update of the loaded row id, .select(\'id\') must return it; none = refuse', denied: 'refuses: "Setting NOT saved ... Reload the app", nothing written; the insert branch is gone (67308c3, 2026-11-02; was WRITES_FROM_EMPTY)' }],
  'scripts/audit-signal-log-splits.mjs|signal_log': [
    { verdict: OK, empty: 'guarded by assertReadable(signal_log) first', denied: 'the control throws: the audit fails instead of passing on nothing (fixed 2026-11-02; was PASS_ON_EMPTY)' }],
  'scripts/backup-tables.mjs|${table}': [
    { verdict: OK, empty: 'judged by backup-rules floors and the portfolio rule', denied: 'refused: below the floor' },
    { verdict: OK, empty: 'month-file tables: the count the rows we hold must equal; no count at all throws', denied: 'a count of 0 against the rows we hold: refused, nothing written' }],
  'scripts/fill-outcomes.mjs|signal_log': [
    { verdict: OK, empty: 'pending rows: guarded by assertReadable(signal_log) at the start of the run', denied: 'the control throws first: the run fails red (fixed 2026-11-02; was SILENT)' },
    { verdict: OK, empty: 'later-signal query: same run, same control', denied: 'the control throws first (fixed 2026-11-02; was WRITES_FROM_EMPTY: credited the wrong day)' },
    { verdict: OK, empty: 'stale-unresolved assertion: same control', denied: 'the control throws first (fixed 2026-11-02; was PASS_ON_EMPTY)' }],
  'scripts/fill-outcomes.mjs|trades_v2': [
    { verdict: OK, empty: 'taken-resolution: guarded by assertReadable(trades_v2) at the start of the run', denied: 'the control throws: nothing is resolved (fixed 2026-11-02; was WRITES_FROM_EMPTY: permanently resolved signals as not-taken)' },
    { verdict: OK, empty: 'sell-timing: same control', denied: 'the control throws first (fixed 2026-11-02; was SILENT)' }],
  'scripts/lib/scan-gate.mjs|scan_runs': [
    { verdict: OK, empty: 'no scan today yet -> allow, but only after assertReadable(scan_runs)', denied: 'the control throws: no scan, the job goes red (fixed 2026-11-02; was WRITES_FROM_EMPTY: every cron fired a scan)' }],
  'scripts/lib/readable.mjs|${table}': [
    { verdict: OK, empty: 'assertReadable: the positive control itself; empty = a denied read', denied: 'throws, naming the table: the run stops' }],
  'scripts/lib/schema-check.mjs|${table}': [
    { verdict: OK, empty: 'limit=0 probe: empty is the expected answer; only the status is judged', denied: 'still judged on status' }],
  'scripts/lib/select-by-ids.mjs|${table}': [
    { verdict: OK, empty: 're-select after a write: every caller asserts it found all of them (assertReReadComplete)', denied: 'fewer than written = a failed verification (fixed 2026-11-02; was PASS_ON_EMPTY)' }],
  'scripts/log-signals-edge.mjs|signal_log': [
    { verdict: OK, empty: 'post-insert re-select: control first, then it must equal the rows the insert returned', denied: 'the control throws: the job fails red (fixed 2026-11-02; was PASS_ON_EMPTY: logged 0 and exited 0)' }],
  'scripts/log-signals-warrior.mjs|signal_log': [
    { verdict: OK, empty: 'post-insert re-select: control first, then it must equal the rows the insert returned', denied: 'the control throws: the job fails red (fixed 2026-11-02; was PASS_ON_EMPTY: logged 0 and exited 0)' }],
  'scripts/log-signals-warrior.mjs|setup_triggers': [
    { verdict: OK, empty: 'post-insert re-select: control first, then it must equal the rows the insert returned', denied: 'the control throws: the job fails red (fixed 2026-11-02; was PASS_ON_EMPTY: logged 0 and exited 0)' }],
  'scripts/test-db019-db021-grants.mjs|trades_v2': [
    { verdict: OK, empty: 'row pick: firstRow() requires exactly one row', denied: 'throws: the grant test fails (fixed 2026-11-02; was PASS_ON_EMPTY: exited 0 having tested nothing)' },
    { verdict: OK, empty: 're-read after PATCH: firstRow() then expect() the value', denied: 'throws (fixed 2026-11-02; was PASS_ON_EMPTY: printed "expect X" and never compared)' }],
  'scripts/test-db019-db021-grants.mjs|signal_log': [
    { verdict: OK, empty: 'row pick / re-read: firstRow() then expect()', denied: 'throws (fixed 2026-11-02; was PASS_ON_EMPTY)' },
    { verdict: OK, empty: 'row pick / re-read: firstRow() then expect()', denied: 'throws (fixed 2026-11-02; was PASS_ON_EMPTY)' },
    { verdict: OK, empty: 'row pick / re-read: firstRow() then expect()', denied: 'throws (fixed 2026-11-02; was PASS_ON_EMPTY)' },
    { verdict: OK, empty: 'row pick / re-read: firstRow() then expect()', denied: 'throws (fixed 2026-11-02; was PASS_ON_EMPTY)' },
    { verdict: OK, empty: 'row pick / re-read: firstRow() then expect()', denied: 'throws (fixed 2026-11-02; was PASS_ON_EMPTY)' }],
};

const list = (dir, re) => fs.readdirSync(path.join(REPO_ROOT, dir)).filter(f => re.test(f)).map(f => `${dir}/${f}`);
const strip = src => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

function appReads() {
  const files = ['app.js', ...list('core', /\.js$/), ...list('shell', /\.js$/),
    ...fs.readdirSync(path.join(REPO_ROOT, 'engines')).flatMap(d => list(`engines/${d}`, /\.js$/))];
  const out = [];
  for (const f of files) {
    const src = strip(readSource(f));
    // The chain's .select( can sit far from .from(...): a write-then-select
    // after a long object literal. The longest real chain is the sale insert
    // (~2,900 chars), so the window is the whole statement (to the first
    // ';', capped at 20,000), not a fixed short span (2026-11-02: a 400-char
    // window would have missed .select() appended to that insert).
    for (const m of src.matchAll(/\.from\('([a-z_0-9]+)'\)/g)) {
      const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 20000).split(';')[0];
      if (/\.select\(/.test(tail)) out.push(`${f}|${m[1]}`);
    }
  }
  return out;
}
function workflowScripts() {
  const wf = fs.readdirSync(path.join(REPO_ROOT, '.github/workflows')).map(f => readSource(`.github/workflows/${f}`)).join('\n');
  const s = new Set([...wf.matchAll(/node (scripts\/[A-Za-z0-9_./-]+\.mjs)/g)].map(m => m[1]));
  for (const f of [...s]) for (const m of readSource(f).matchAll(/from '\.\/(lib\/[a-z0-9-]+\.mjs)'/g)) s.add(`scripts/${m[1]}`);
  return [...s].sort();
}
function scriptReads() {
  const out = [];
  for (const f of workflowScripts()) {
    const src = strip(readSource(f));
    for (const m of src.matchAll(/fetch(?:Impl|AllRows)?\(\s*`[^`]*\/rest\/v1\/(\$\{[a-zA-Z]+\}|[a-z_0-9]+)/g)) {
      const call = src.slice(m.index, m.index + 600);
      const end = call.indexOf(');');
      if (/method:\s*'(POST|PATCH|DELETE)'/.test(end > 0 ? call.slice(0, end) : call)) continue;
      out.push(`${f}|${m[1]}`);
    }
  }
  return out;
}
const count = keys => keys.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});

run('enumeration finds the known reads (a blind enumerator would pass everything)', () => {
  const found = new Set([...appReads(), ...scriptReads()]);
  for (const k of ['core/store.js|settings', 'core/store.js|portfolio', 'app.js|trades_v2', 'scripts/fill-outcomes.mjs|trades_v2', 'scripts/lib/scan-gate.mjs|scan_runs'])
    assert.ok(found.has(k), `enumerator did not find ${k}`);
});

run('every Supabase read is classified, and every classification still has its read', () => {
  const found = count([...appReads(), ...scriptReads()]);
  const declared = Object.fromEntries(Object.entries(REGISTRY).map(([k, v]) => [k, v.length]));
  const problems = [];
  for (const [k, n] of Object.entries(found)) if ((declared[k] || 0) !== n) problems.push(`${k}: ${n} read(s) in code, ${declared[k] || 0} classified`);
  for (const [k, n] of Object.entries(declared)) if (!found[k]) problems.push(`${k}: ${n} classified, no such read in code any more`);
  assert.deepStrictEqual(problems, [], 'classify each read in REGISTRY (what empty means, what a denied read would do) or remove the stale entry:\n  ' + problems.join('\n  '));
});

run('every classification states its verdict and both meanings', () => {
  for (const [k, v] of Object.entries(REGISTRY)) for (const e of v) {
    assert.ok([OK, S, P, W].includes(e.verdict), `${k}: verdict ${e.verdict}`);
    assert.ok(e.empty && e.denied, `${k}: needs both 'empty' and 'denied'`);
  }
});
