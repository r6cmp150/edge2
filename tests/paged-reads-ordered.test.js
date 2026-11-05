// tests/paged-reads-ordered.test.js — 2026-11-04. Without an ORDER BY Postgres guarantees no
// order, so offset paging can skip or repeat rows, more so under concurrent writes, with the row
// count still matching. Every paged read has to order on a unique key of its own table. One read
// shipped ordered on a column its table doesn't have, so the key is checked per table.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { readSource, run, REPO_ROOT } = require('./_lib');

const UNIQUE_KEY = { signal_log: 'id', trades_v2: 'id', rating_snapshots: 'id', signal_snapshot_at_buy: 'position_id', macro_observations: 'id', portfolio: 'id', trades: 'id', settings: 'id', scan_runs: 'id' };
// Reads whose table is a variable: how each one gets its key.
const VARIABLE_TABLE = {
  'scripts/backup-tables.mjs': 'query built from WHOLE_FILE_KEY or shardApi order=id',
  'scripts/audit-unparseable-bar-dates.mjs': "order parameter, 'position_id' for signal_snapshot_at_buy",
  'scripts/count-portfolio-urgency-unknown.mjs': 'trades_v2 and portfolio only, both with id',
};
const list = (dir, re) => fs.readdirSync(path.join(REPO_ROOT, dir)).filter(f => re.test(f)).map(f => `${dir}/${f}`);
const strip = src => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const scripts = () => [...list('scripts', /\.(mjs|cjs|js)$/), ...list('scripts/lib', /\.(mjs|cjs|js)$/)];

function pagedScriptReads() {
  const out = [];
  for (const f of scripts()) {
    if (f === 'scripts/lib/read-all.mjs') continue;
    const src = strip(readSource(f));
    for (const m of src.matchAll(/(fetchAllRows|fetch)\(\s*`[^`]*\/rest\/v1\/(\$\{[a-zA-Z]+\}|[a-z_0-9]+)\?([^`]*)`/g)) {
      const paged = m[1] === 'fetchAllRows' || /Range:/.test(src.slice(m.index, m.index + 400).split(');')[0]);
      if (paged) out.push({ file: f, table: m[2], query: m[3] });
    }
  }
  return out;
}
function pagedAppReads() {
  const out = [];
  for (const f of ['app.js', ...list('core', /\.js$/)]) {
    const src = strip(readSource(f));
    for (const m of src.matchAll(/\.from\('([a-z_0-9]+)'\)/g)) {
      const tail = src.slice(m.index, m.index + 700).split(';')[0];
      const wrapped = /readAllRows\(\(\) =>\s*(supabaseClient\s*)?$/.test(src.slice(Math.max(0, m.index - 60), m.index));
      if (wrapped || /\.range\(/.test(tail)) out.push({ file: f, table: m[1], chain: tail });
    }
  }
  return out;
}

// In sequence: some of these capture console output, which concurrent tests would write into.
(async () => {

await run('the enumeration sees the paged reads, in scripts and the app', () => {
  const s = pagedScriptReads(), a = pagedAppReads();
  for (const f of ['scripts/fill-outcomes.mjs', 'scripts/audit-signal-log-splits.mjs', 'scripts/measure-iex-vs-sip-scoring.mjs', 'scripts/backup-tables.mjs', 'scripts/report-forward-test.mjs'])
    assert.ok(s.some(r => r.file === f), `did not find ${f}`);
  assert.ok(a.filter(r => r.table === 'trades_v2').length >= 4 && a.filter(r => r.table === 'rating_snapshots').length >= 2, 'app reads');
});

await run('every paged script read ends its order on its table\'s unique key', () => {
  const bad = [];
  for (const { file, table, query } of pagedScriptReads()) {
    if (table.startsWith('${')) { if (!VARIABLE_TABLE[file]) bad.push(`${file}: a variable table nobody has explained`); continue; }
    const key = UNIQUE_KEY[table];
    const order = (query.match(/(?:^|&)order=([^&]*)/) || [])[1];
    if (!key) bad.push(`${file}|${table}: no unique key known`);
    else if (!order) bad.push(`${file}|${table}: no order=`);
    else if (order.split(',').pop().split('.')[0] !== key) bad.push(`${file}|${table}: order=${order} doesn't end on ${key}`);
  }
  assert.deepStrictEqual(bad, []);
});

await run('every paged app read ends its order on its table\'s unique key, and selects it', () => {
  const bad = [];
  for (const { file, table, chain } of pagedAppReads()) {
    const orders = [...chain.matchAll(/\.order\('([a-z_]+)'/g)].map(m => m[1]);
    const select = (chain.match(/\.select\('([^']*)'/) || [])[1] || '';
    if (orders[orders.length - 1] !== UNIQUE_KEY[table]) bad.push(`${file}|${table}: orders end on ${orders[orders.length - 1]}`);
    if (select !== '*' && !select.split(/,\s*/).includes(UNIQUE_KEY[table])) bad.push(`${file}|${table}: doesn't select ${UNIQUE_KEY[table]}`);
  }
  assert.deepStrictEqual(bad, []);
});

await run('the backup orders every table, and refuses a read that repeats a key', async () => {
  const { WHOLE_FILE_KEY, TABLE_RULES, repeatedKeys } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/backup-rules.mjs')).href);
  const { SHARDED } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/backup-shards.mjs')).href);
  assert.deepStrictEqual(Object.keys(TABLE_RULES).filter(t => !SHARDED[t] && !WHOLE_FILE_KEY[t]), [], 'every whole-file table has a key');
  for (const [t, k] of Object.entries(WHOLE_FILE_KEY)) assert.strictEqual(k, UNIQUE_KEY[t], t);
  assert.strictEqual(repeatedKeys([{ id: 1 }, { id: 2 }], 'id'), 0);
  assert.strictEqual(repeatedKeys([{ id: 1 }, { id: 1 }, { id: 2 }], 'id'), 1);
  const src = strip(readSource('scripts/backup-tables.mjs'));
  assert.ok(src.includes('fetchTable(table, `select=*&order=${key}`)'), 'whole-file read ordered');
  assert.ok(src.includes('select=*&order=id'), 'month-file read ordered');
  assert.ok(/if \(repeated\) \{[\s\S]{0,500}failures\.push/.test(src), 'a repeat fails the table');
  assert.ok(!/fetchTable\(table\)/.test(src), 'no unordered read left');
});

await run('fetchAllRows refuses no order, and drops a row a write repeated without hiding a short read', async () => {
  const { fetchAllRows } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/read-all.mjs')).href);
  const res = (body, range) => ({ status: 206, json: async () => body, headers: { get: () => range }, text: async () => '' });
  await assert.rejects(fetchAllRows('https://x/rest/v1/t?select=*', {}, 'L', async () => res([], '*/0')), /needs an order=/);
  const log = console.log; console.log = () => {};
  try {
    // An insert sorting before the second page: its first row repeats, and the count rises by one.
    const a = Array.from({ length: 1000 }, (_, i) => ({ id: i })), b = [{ id: 999 }, { id: 1000 }, { id: 1001 }];
    let call = 0;
    const out = await fetchAllRows('u?order=id', {}, 'L', async () => (call++ ? res(b, '1000-1002/1002') : res(a, '0-999/1001')));
    assert.strictEqual(out.length, 1002, 'each row once');
    let c2 = 0;
    await assert.rejects(fetchAllRows('u?order=id', {}, 'L', async () => (c2++ ? res(b, '1000-1002/1003') : res(a, '0-999/1003'))), /read 1002 rows of 1003/, 'a repeat can\'t cover for a missing row');
    const k = await fetchAllRows('u?order=position_id', {}, 'L', async () => res([{ position_id: 'a' }, { position_id: 'b' }], '0-1/2'), 'position_id');
    assert.strictEqual(k.length, 2, 'the table\'s own key');
  } finally { console.log = log; }
});

await run('a mutation run refuses a failing baseline, and its report states the baseline', () => {
  const { runMutants } = require('../scripts/lib/mutants.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge2-mut-'));
  fs.writeFileSync(path.join(dir, 'x.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'good.test.js'), "process.exit(require('./x.js') === 1 ? 0 : 1);\n");
  fs.writeFileSync(path.join(dir, 'bad.test.js'), 'process.exit(1);\n');
  const M = [['x.js', 'module.exports = 1;', 'module.exports = 2;', 'changes it']];
  const lines = [];
  const failed = runMutants('bad.test.js', M, { cwd: dir, print: l => lines.push(l) });
  assert.strictEqual(failed.baseline, false);
  assert.strictEqual(failed.killed, 0, 'a failing baseline kills nothing');
  assert.match(lines[0], /^BASELINE: FAILED/);
  lines.length = 0;
  const ok = runMutants('good.test.js', M, { cwd: dir, print: l => lines.push(l) });
  assert.strictEqual(ok.killed, 1);
  assert.match(lines[0], /^BASELINE: passed/, 'the first line, always');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'x.js'), 'utf8'), 'module.exports = 1;\n', 'the file is restored');
});

await run('both rules are in the spec', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('EVERY MUTATION REPORT STATES THAT ITS BASELINE PASSED'));
  assert.ok(spec.includes('A PAGED READ NEEDS A TOTAL ORDER'));
});

})();
