// tests/empty-read-controls.test.js — 2026-11-02, auth step 4½. The
// classifications in tests/empty-read-sites.test.js say WHY each read is safe
// on an empty result; this checks that the reason is still true in the code:
// the positive control behaves, it runs BEFORE the reads it guards, every
// post-write re-read is asserted, and the app keeps its copy rather than
// overwrite it with nothing. Deleting a control fails here even though the
// read count (all the registry sees) is unchanged.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

run('assertReadable: a row passes; empty or an error throws, naming the table', async () => {
  const { assertReadable, assertReReadComplete } = await import('../scripts/lib/readable.mjs');
  const f = (status, rows) => async () => ({ status, json: async () => rows, text: async () => 'x' });
  await assertReadable('u', {}, 'trades_v2', f(200, [{ id: 1 }]));
  await assert.rejects(assertReadable('u', {}, 'trades_v2', f(200, [])), /trades_v2 reads back EMPTY/);
  await assert.rejects(assertReadable('u', {}, 'trades_v2', f(401, null)), /positive-control read failed/);
  assert.throws(() => assertReReadComplete('x', 3, 2), /found 2 of 3/);
  assertReReadComplete('x', 3, 3);
});

const before = (src, a, b, label) => {
  const i = src.indexOf(a), j = src.indexOf(b);
  assert.ok(i >= 0, `${label}: control not found`); assert.ok(j >= 0, `${label}: guarded read not found`);
  assert.ok(i < j, `${label}: the control must run before the read it guards`);
};
run('each script runs its control before the reads it guards', () => {
  const fo = readSource('scripts/fill-outcomes.mjs');
  for (const t of ['signal_log', 'trades_v2']) before(fo, `await assertReadable(SUPABASE_URL, anonHeaders, '${t}');`, 'const rowsRes = await fetch(', `fill-outcomes ${t}`);
  // ...and nothing in fill-outcomes reads before those controls
  const firstRead = fo.search(/fetch\(\s*`\$\{SUPABASE_URL\}\/rest\/v1\/[a-z_]+\?select=/);
  assert.ok(fo.indexOf("assertReadable(SUPABASE_URL, anonHeaders, 'trades_v2')") < firstRead, 'fill-outcomes: a read precedes the controls');
  const sg = readSource('scripts/lib/scan-gate.mjs');
  before(sg, "'scan_runs');", '/rest/v1/scan_runs?engine_source=eq.', 'scan gate');
  const sp = readSource('scripts/audit-signal-log-splits.mjs');
  before(sp, "await assertReadable(SUPABASE_URL, anonHeaders, 'signal_log');", '/rest/v1/signal_log?select=${selectCols}&or=', 'splits audit');
  for (const [f, t, verify] of [['scripts/log-signals-edge.mjs', 'signal_log', 'const verifyBody = await verifyRes.json();'],
    ['scripts/log-signals-warrior.mjs', 'signal_log', 'const verifyBody = await verifyRes.json();'],
    ['scripts/log-signals-warrior.mjs', 'setup_triggers', 'const triggerVerifyBody = await triggerVerifyRes.json();']]) {
    const src = readSource(f);
    before(src, `await assertReadable(SUPABASE_URL, headers, '${t}');`, verify, `${f} ${t}`);
  }
});

// A positive control that can legitimately be empty is not a control. Every table one
// is used on, and why it can't be empty. Live counts when this was written, read-only,
// 2026-11-04 04:39Z: signal_log 2175, trades_v2 492, scan_runs 114, rating_snapshots
// 3324, setup_triggers 0. Add a table only with evidence the test below can check.
const CONTROLS = {
  signal_log: { kind: 'FLOOR' },
  trades_v2: { kind: 'FLOOR' },
  rating_snapshots: { kind: 'FLOOR', appOnly: true }, // retryRatingWrites
  scan_runs: { kind: 'HELD_BY_FOREIGN_KEY' }, // no backup, so no floor: signal_log rows reference it
  setup_triggers: { kind: 'AFTER_INSERT' },
};
run('every positive control\'s table has evidence it cannot be empty, and the evidence still holds', async () => {
  const { pathToFileURL } = require('url');
  const fs = require('fs');
  const path = require('path');
  const { REPO_ROOT } = require('./_lib');
  const { MIN_ROWS } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'backup-rules.mjs')).href);
  const walk = d => fs.readdirSync(path.join(REPO_ROOT, d), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.mjs$/.test(e.name) ? [path.join(d, e.name)] : []));
  const used = new Set();
  for (const f of walk('scripts')) {
    if (f.endsWith('readable.mjs')) continue;
    for (const m of readSource(f).matchAll(/assertReadable\([^)]*'([a-z_0-9]+)'\)/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 4, 'the enumerator found ' + used.size);
  for (const t of used) assert.ok(CONTROLS[t] && !CONTROLS[t].appOnly, `${t}: a positive control with no evidence the table can't be empty`);
  for (const [t, c] of Object.entries(CONTROLS)) {
    if (!c.appOnly) assert.ok(used.has(t), `${t}: listed, no control uses it`);
    if (c.kind === 'FLOOR') assert.ok(MIN_ROWS[t] > 0, `${t}: no backup floor`);
  }
  const schema = fs.readdirSync(path.join(REPO_ROOT, 'db')).filter(f => f.endsWith('.sql')).map(f => readSource(`db/${f}`)).join('\n');
  assert.ok(/foreign key \(scan_session\) references scan_runs\(id\)/.test(schema), 'scan_runs is held by the foreign key');
  for (const t of ['signal_log', 'trades_v2', 'scan_runs']) {
    assert.ok(!new RegExp(`create policy [^;]*on ${t} for delete`, 'i').test(schema), `${t}: a delete policy would end "never empty"`);
  }
});

run('setup_triggers can truly be empty, so its control runs only after this run inserted', () => {
  const src = readSource('scripts/log-signals-warrior.mjs');
  const block = src.indexOf('if (setupTriggerRows.length) {'), failed = src.indexOf('setup_triggers insert failed');
  const control = src.indexOf("assertReadable(SUPABASE_URL, headers, 'setup_triggers')");
  assert.ok(block >= 0 && failed > block && control > failed, 'outside the insert block, the control fails every run on an empty table');
});

run('every post-write re-read is asserted, never just printed', () => {
  for (const f of ['scripts/fill-outcomes.mjs', 'scripts/audit-signal-log-splits.mjs']) {
    const src = readSource(f);
    const reads = (src.match(/= await selectByIds\(/g) || []).length;
    const asserted = (src.match(/assertReReadComplete\(/g) || []).length;
    assert.ok(reads > 0 && asserted >= reads, `${f}: ${reads} re-read(s), ${asserted} asserted`);
  }
  assert.strictEqual((readSource('scripts/log-signals-edge.mjs').match(/assertReReadComplete\(/g) || []).length, 1);
  assert.strictEqual((readSource('scripts/log-signals-warrior.mjs').match(/assertReReadComplete\(/g) || []).length, 2);
  const g = readSource('scripts/test-db019-db021-grants.mjs');
  assert.ok(!/cannot run this check|Skipped\.'\); return;/.test(g), 'the grant test no longer skips to a pass');
  assert.ok(!/console\.log\(`re-select \(anon key\)[^`]*-- expect/.test(g), 'no "expect X" that is only printed');
  assert.ok(/if \(failures\.length\) \{.*process\.exit\(1\); \}/.test(g), 'a failed expectation fails the run');
  assert.ok((g.match(/expect\('/g) || []).length >= 7, 'every check asserts');
});

run('the Sold list and analysis periods keep this phone\'s copy on an empty read, and say so', async () => {
  const app = readSource('app.js');
  const grab = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
  const mk = rows => {
    const c = { state: { sold: [{ ticker: 'KEEP' }], analysisPeriods: [{ name: 'p1' }], activeTab: 'x' }, persisted: [], banner: 0, console };
    c.persist = k => c.persisted.push(k);
    c.updateMarketBanner = () => { c.banner++; };
    c.mapTradesV2ToSoldShape = r => ({ ticker: r.ticker });
    c.supabaseClient = { from: () => ({ select: () => ({ order: async () => ({ data: rows, error: null }) }) }) };
    vm.createContext(c);
    vm.runInContext(['noteDataReadProblem', 'clearDataReadProblem', 'loadSoldFromSupabase', 'loadAnalysisPeriodsFromSupabase'].map(grab).join('\n')
      + ';Object.assign(globalThis, { loadSoldFromSupabase, loadAnalysisPeriodsFromSupabase });', c);
    return c;
  };
  const e = mk([]);
  await e.loadSoldFromSupabase(); await e.loadAnalysisPeriodsFromSupabase();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e.state.sold)), [{ ticker: 'KEEP' }], 'sold kept');
  assert.strictEqual(e.state.analysisPeriods.length, 1, 'periods kept');
  assert.ok(!e.persisted.length, 'nothing overwritten');
  assert.ok(e.state.dataReadProblems.trades_v2 && e.state.dataReadProblems.analysis_periods && e.banner >= 2, 'said on the banner');
  const ok = mk([{ ticker: 'NEW', name: 'p2' }]);
  await ok.loadSoldFromSupabase();
  assert.strictEqual(ok.state.sold[0].ticker, 'NEW'); assert.ok(ok.persisted.includes('sold'));
});

run('no read site may write on, or pass on, an empty read (auth step 5 does not start otherwise)', () => {
  const src = readSource('tests/empty-read-sites.test.js');
  const reg = src.slice(src.indexOf('const REGISTRY'), src.indexOf('\n};', src.indexOf('const REGISTRY')));
  const bad = [...reg.matchAll(/verdict: (W|P)\b/g)].length;
  assert.strictEqual(bad, 0, `${bad} read site(s) still WRITES_FROM_EMPTY or PASS_ON_EMPTY`);
});
