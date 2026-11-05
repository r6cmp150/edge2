// tests/job-counts.test.js — 2026-11-04. A mechanism that fails must leave behind the
// evidence needed to explain it (phase-10 §7.7). fill-outcomes went red on 11-03 and
// 11-05 without logging whether Pass 2 had seen the rows it named, so the cause was an
// inference, not a reading. Every scheduled job now logs the counts its assertions
// depend on, and any read that lands on the page limit says so.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { readSource, run, REPO_ROOT } = require('./_lib');

const lib = f => import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib', f)).href);
const captured = async fn => {
  const out = [], { log, warn } = console;
  console.log = console.warn = (...a) => out.push(a.join(' '));
  try { await fn(); } finally { console.log = log; console.warn = warn; }
  return out.join('\n');
};

// In sequence: some of these capture console output, which concurrent tests would write into.
(async () => {

await run('a stale failure says whether Pass 2 saw the rows', async () => {
  const { describeStale } = await lib('stale-unresolved.mjs');
  const stuck = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.strictEqual(describeStale(stuck, [{ id: 'c' }, { id: 'x' }]), "2 of them weren't in this run's pending read of 2 row(s), so Pass 2 never saw them; 1 were read and not resolved");
  assert.ok(/0 of them weren't/.test(describeStale(stuck, stuck)), 'all read');
  assert.ok(/3 of them weren't/.test(describeStale(stuck, [])), 'none read');
});

await run('a read on the page limit says so, and one under it stays quiet', async () => {
  const { warnIfAtPageLimit, fetchAllRows } = await lib('read-all.mjs');
  const n = k => Array.from({ length: k }, (_, i) => ({ id: i }));
  assert.ok((await captured(() => warnIfAtPageLimit('L', n(1000)))).includes('L: READ AT PAGE LIMIT -- 1000 row(s)'));
  assert.ok((await captured(() => warnIfAtPageLimit('L', n(1500)))).includes('READ AT PAGE LIMIT'), 'over it too: the cap could change');
  assert.strictEqual(await captured(() => warnIfAtPageLimit('L', n(999))), '');
  assert.strictEqual(warnIfAtPageLimit('L', n(3)).length, 3, 'and it hands the rows back');
  const res = { status: 206, json: async () => n(5), headers: { get: () => '0-4/5' } };
  assert.ok((await captured(() => fetchAllRows('u?order=id', {}, 'L', async () => res))).includes("L: read 5 row(s), matching Postgres's count of 5."), 'paged reads log their count');
});

await run('fill-outcomes logs every count its assertions depend on', () => {
  const src = readSource('scripts/fill-outcomes.mjs');
  for (const s of ['candidate row(s) since', ' EDGE, ', ' WARRIOR.', 'Pass 1 -- ${needIntraday.length}', '${needDaily.length} need daily bars', 'Pass 2 -- ${unresolvedRows.length} unresolved row(s) read, in ${groups.size} group(s), ${closedWindowGroups} with a closed window, ${takenResolvedCount} transition(s)', 'none of the ${unresolved.length}', '${describeStale(stuck, rows)}'])
    assert.ok(src.includes(s), `not logged: ${s}`);
  assert.ok(/select=id,symbol,signal_date,engine_source,tier&taken_resolution=eq\.unresolved/.test(src), 'the check reads ids, or it cannot compare them with the pending read');
});

await run('every read a scheduled job leaves unpaged warns at the limit', () => {
  const wf = fs.readdirSync(path.join(REPO_ROOT, '.github/workflows')).map(f => readSource(`.github/workflows/${f}`)).join('\n');
  const jobs = new Set([...wf.matchAll(/node (scripts\/[A-Za-z0-9_./-]+\.mjs)/g)].map(m => m[1]));
  for (const f of [...jobs]) for (const m of readSource(f).matchAll(/from '\.\/(lib\/[a-z0-9-]+\.mjs)'/g)) jobs.add(`scripts/${m[1]}`);
  const missing = [];
  for (const f of jobs) {
    const src = readSource(f).split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    const reads = [...src.matchAll(/fetch\(\s*`[^`]*\/rest\/v1\/[a-z_0-9]+\?([^`]*)`/g)].filter(m => !/[?&]?limit=/.test(m[1]) && !/^id=(eq|in)\./.test(m[1]))
      .filter(m => { const c = src.slice(m.index, m.index + 700); const end = c.indexOf(');'); return !/method:\s*'(POST|PATCH|DELETE|HEAD)'/.test(end > 0 ? c.slice(0, end) : c); });
    const warned = (src.match(/warnIfAtPageLimit\(/g) || []).length;
    if (reads.length && warned < reads.length) missing.push(`${f}: ${reads.length} unpaged read(s), ${warned} warning(s)`);
  }
  assert.deepStrictEqual(missing, []);
});

await run('the rule is in §7.7, with its three instances', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  const a = spec.indexOf('### 7.7'), rule = spec.indexOf('A MECHANISM THAT FAILS MUST LEAVE BEHIND THE EVIDENCE NEEDED TO EXPLAIN IT');
  assert.ok(a >= 0 && rule > a, 'in §7.7');
  assert.ok(spec.includes('ANY SCHEDULED JOB LOGS THE COUNTS ITS ASSERTIONS DEPEND ON'));
});

})();
