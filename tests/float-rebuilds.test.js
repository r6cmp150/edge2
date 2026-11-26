// tests/float-rebuilds.test.js -- 2026-11-26. The float table is DATA, not instrument (the reviewer): its builder is
// frozen, its contents refresh on schedule, every rebuild is recorded on the daily line (floats changed, crossings of
// the float line each way), and a rebuild that is not the scheduled builder's is an intervention, red and named.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const F = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/float-rebuilds.mjs')).href);
const D = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/check-instrument-freeze.mjs')).href);
const X = 10_000_000, v = n => ({ status: 'value', impliedFloatShares: n });

await run('passes: a usable value strictly under the line, as the Warrior float pillar decides it', () => {
  assert.strictEqual(F.passes(v(9_999_999), X), true);
  assert.strictEqual(F.passes(v(10_000_000), X), false, 'the pillar is impliedFloatShares < threshold');
  assert.strictEqual(F.passes({ status: 'no-filing' }, X), false);
  assert.strictEqual(F.passes(undefined, X), false);
  assert.ok(readSource('engines/warrior/gate.js').includes('const pass = floatInput.impliedFloatShares < thresholdShares;'), 'the pillar still reads that way');
});

await run('one rebuild: floats changed, and crossings of the line counted each way', () => {
  const prev = { bySymbol: { UP: v(12e6), DOWN: v(8e6), SAME: v(5e6), MOVED: v(20e6), LOST: v(3e6), GONE: v(1e6) } };
  const next = { bySymbol: { UP: v(9e6), DOWN: v(11e6), SAME: v(5e6), MOVED: v(30e6), LOST: { status: 'discarded' }, NEW: v(2e6) } };
  assert.deepStrictEqual(F.floatDiff(prev, next, X), { changed: 6, nowPassing: 2, noLongerPassing: 3, added: 1, removed: 1, symbols: 6 });
  // the guard discards a value but keeps the number: a status change alone, and it no longer passes
  const kept = F.floatDiff({ bySymbol: { K: v(3e6) } }, { bySymbol: { K: { status: 'discarded', impliedFloatShares: 3e6 } } }, X);
  assert.deepStrictEqual([kept.changed, kept.noLongerPassing], [1, 1]);
  assert.strictEqual(F.passes({ status: 'discarded', impliedFloatShares: 3e6 }, X), false, 'only a usable value passes');
});

await run('interventions: only the scheduled builder may change the table, and only the schedule may run the builder', () => {
  const start = '2026-11-23T20:42:43.124Z';
  const bot = { sha: 'a'.repeat(40), author: 'float-table-bot', subject: 'Float table rebuild 2026-11-29T15:00:00Z' };
  const hand = { sha: 'b'.repeat(40), author: 'r6cmp150', subject: 'fix one float' };
  const runs = [{ databaseId: 1, event: 'schedule', createdAt: '2026-11-29T14:00:00Z' }, { databaseId: 2, event: 'workflow_dispatch', createdAt: '2026-11-20T10:00:00Z' }];
  assert.deepStrictEqual(F.interventions({ commits: [bot], runs, startLine: start }), [], 'scheduled, and a dispatch BEFORE the start line is not this test\'s');
  const got = F.interventions({ commits: [bot, hand], runs: [...runs, { databaseId: 3, event: 'workflow_dispatch', createdAt: '2026-11-30T09:00:00Z' }], startLine: start });
  assert.strictEqual(got.length, 2);
  assert.ok(/commit bbbbbbb .*not the scheduled builder/.test(got[0]) && /run 3 .*workflow_dispatch, not the schedule/.test(got[1]));
  const lookalike = { ...hand, sha: 'c'.repeat(40), subject: 'Float table rebuild 2026-11-30T00:00:00Z' };
  const wrongSubject = { ...bot, sha: 'd'.repeat(40), subject: 'tidy the table' };
  assert.strictEqual(F.interventions({ commits: [lookalike, wrongSubject], runs: [], startLine: start }).length, 2, 'both marks are required: the bot as author AND its subject');
  assert.ok(readSource('scripts/check-instrument-freeze.mjs').includes('const fl = rev ? { code: 0 } : floatRecord(manifest.start_line, Number(manifest.settings.float_threshold_shares));'), 'the daily run records the rebuilds, against the frozen threshold');
});

await run('the daily record: each rebuild on its own line; an intervention is red (1); unreadable runs are named (2)', () => {
  const lines = [], log = console.log; console.log = l => lines.push(l);
  const table = n => JSON.stringify({ bySymbol: { A: v(n), B: v(4e6) } });
  const git = (...a) => a[0] === 'log' ? 'c1|float-table-bot|2026-11-29T15:00:00Z|Float table rebuild 2026-11-29T15:00:00Z\n' : a[1].startsWith('c1^') ? table(12e6) : table(9e6);
  try {
    const ok = D.floatRecord('2026-11-23T20:42:43.124Z', X, git, () => '[{"databaseId":7,"event":"schedule","createdAt":"2026-11-29T14:00:00Z"}]');
    assert.strictEqual(ok.code, 0);
    assert.ok(lines.some(l => /^FLOAT TABLE REBUILDS since the start line: 1/.test(l)));
    assert.ok(lines.some(l => /2026-11-29 \(commit c1\): 2 tickers; 1 floats changed .* 1 now pass, 0 no longer pass/.test(l)), lines.join('\n'));
    assert.strictEqual(D.floatRecord('2026-11-23T20:42:43.124Z', X, git, () => '[{"databaseId":8,"event":"workflow_dispatch","createdAt":"2026-11-30T09:00:00Z"}]').code, 1);
    assert.strictEqual(D.floatRecord('2026-11-23T20:42:43.124Z', X, git, () => { throw new Error('HTTP 403'); }).code, 2);
    assert.ok(lines.some(l => /^::error::FLOAT TABLE TRIGGERS NOT CHECKED: .*HTTP 403/.test(l)));
  } finally { console.log = log; }
});

await run('the builder and everything it runs are FROZEN; the table is OUT with the principle', () => {
  const spec = JSON.parse(readSource(D.SPEC)), manifest = JSON.parse(readSource(D.MANIFEST));
  const b = readSource('scripts/build-float-table.mjs');
  const imports = [...b.matchAll(/from '\.\/([^']+)'/g)].map(m => `scripts/${m[1]}`);
  const evals = [...b.matchAll(/path\.join\(REPO_ROOT, 'core', '([^']+)'\)/g)].map(m => `core/${m[1]}`);
  assert.ok(imports.length >= 1 && evals.length >= 4, `${imports} ${evals}`);
  for (const p of ['scripts/build-float-table.mjs', '.github/workflows/build-float-table.yml', ...imports, ...evals]) assert.ok(p in spec.files.frozen && p in manifest.files, `${p} is frozen`);
  const runs = [...readSource('.github/workflows/build-float-table.yml').matchAll(/run: (node [^\n]+)/g)].map(m => m[1]);
  assert.deepStrictEqual(runs, ['node scripts/build-float-table.mjs'], 'the workflow runs the frozen builder and nothing else');
  assert.ok(!('data/float-table.json' in manifest.files));
  assert.ok(/THIRD-PARTY DATA CACHED IN THE REPO.*different rule.*BUILDER is frozen.*intervention/.test(spec.files.out['data/float-table.json']));
});

await run('the daily run can see history and runs: full checkout, actions: read, a token for the check step', () => {
  const y = readSource('.github/workflows/backup-tables.yml');
  assert.ok(/actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0/.test(y));
  assert.ok(/permissions:\n\s+contents: write\n\s+actions: read/.test(y));
  const step = y.slice(y.indexOf("name: Check the forward test's frozen instrument"), y.indexOf('node scripts/check-instrument-freeze.mjs'));
  assert.ok(step.includes('GH_TOKEN: ${{ github.token }}'));
});
})();
