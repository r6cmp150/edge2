// tests/not-known-count.test.js — 2026-11-12. db/042's not_known count (ruled 2026-11-11): four states by the build
// stamp that wrote the row, never by a date; one classifier (core/execution-mode-count.js) shared by the Settings
// readout and the daily log; a denied read never reads as "no defects".
'use strict';
const assert = require('assert');
const path = require('path');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');
const { readSource, run, REPO_ROOT } = require('./_lib');

// eslint-disable-next-line no-eval
eval(readSource('core/execution-mode-count.js') + '\nglobal.__k = { FIRST_MODE_BUILD, executionModeBuildStamp, classifyNotKnown, countNotKnown, notKnownLines };');
const K = global.__k;
const pos = (o = {}) => ({ id: 1, ticker: 'P', execution_mode: 'not_known', execution_mode_source: null, code_version: { app: '20261111021700' }, ...o });
const sale = (o = {}) => ({ id: 2, ticker: 'S', execution_mode: 'not_known', execution_mode_source: null, sale_code_version: { app: '20261111021700' }, ...o });

(async () => {
await run('the first build that records the mode is the stamp e313349 shipped, read from that commit, not typed', () => {
  let html;
  try { html = execSync('git show e313349:index.html', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (_) { console.log('  (e313349 not in this checkout; skipped)'); return; }
  assert.strictEqual(html.match(/app\.js\?v=(\d{14})/)[1], K.FIRST_MODE_BUILD);
});

await run('four states by the writer\'s stamp: at or after the first build = defect, before = older, unreadable = unknown', () => {
  const F = K.FIRST_MODE_BUILD;
  assert.strictEqual(K.classifyNotKnown(pos({ code_version: { app: F } }), 'portfolio'), 'defect', 'the first build itself');
  assert.strictEqual(K.classifyNotKnown(pos({ code_version: { app: '20261112002001' } }), 'portfolio'), 'defect');
  assert.strictEqual(K.classifyNotKnown(pos({ code_version: { app: '20261112001959' } }), 'portfolio'), 'older_build', 'one second before');
  for (const cv of [null, undefined, {}, { app: 'unavailable' }, { app: '2026111200200' }, { app: 20261112002000 }]) {
    assert.strictEqual(K.classifyNotKnown(pos({ code_version: cv }), 'portfolio'), 'build_unknown', JSON.stringify(cv));
  }
  assert.strictEqual(K.classifyNotKnown(pos({ execution_mode: 'paper' }), 'portfolio'), null, 'not not_known: not counted at all');
});

await run('a sale is judged by the build that wrote the SALE, and one that carried its position\'s not_known is not counted', () => {
  const F = K.FIRST_MODE_BUILD;
  assert.strictEqual(K.classifyNotKnown(sale({ sale_code_version: { app: F }, code_version: { app: '20261001000000' } }), 'trades_v2'), 'defect', 'an old buy does not excuse a new sale with no mode');
  assert.strictEqual(K.classifyNotKnown(sale({ sale_code_version: { app: '20261101000000' }, code_version: { app: F } }), 'trades_v2'), 'older_build', 'the buy\'s stamp plays no part');
  assert.strictEqual(K.classifyNotKnown(sale({ sale_code_version: { app: F }, execution_mode_source: 'copied_from_position' }), 'trades_v2'), 'carried');
  assert.strictEqual(K.classifyNotKnown(pos({ code_version: { app: F }, execution_mode_source: 'copied_from_position' }), 'portfolio'), 'defect', 'carried exists only for sales');
});

await run('the readout: never blank, zero said as zero, a defect red with its examples', () => {
  const F = K.FIRST_MODE_BUILD;
  const clean = K.notKnownLines(K.countNotKnown({ portfolio: [pos()], trades: [sale(), sale({ id: 3, sale_code_version: null })] }));
  assert.deepStrictEqual(clean.map(l => l.bad), [false, false, false]);
  assert.ok(/^None recorded without Live\/Paper since build \d{14} \(expected 0\)\.$/.test(clean[0].text));
  assert.ok(/older builds.*1 position, 1 sale\./.test(clean[1].text));
  assert.ok(/Build not recorded.*0 positions, 1 sale\./.test(clean[2].text));
  const bad = K.notKnownLines(K.countNotKnown({ portfolio: [], trades: [sale({ ticker: 'ABC', id: 9, sale_code_version: { app: F } }), sale({ id: 4, execution_mode_source: 'copied_from_position' })] }));
  assert.strictEqual(bad[0].bad, true);
  assert.ok(bad[0].text.startsWith('1 recorded WITHOUT Live/Paper') && bad[0].text.includes('ABC (trades_v2 9)'));
  assert.ok(bad.some(l => /carried an older position's not_known \(expected, not counted\): 1\./.test(l.text) && !l.bad));
  const empty = K.notKnownLines(K.countNotKnown({ portfolio: [], trades: [] }));
  assert.ok(empty.length >= 2 && empty.every(l => l.text), 'nothing to count still says so');
});

// The daily script, against a fake PostgREST: GET only, the control first, every page and total checked.
const script = () => import(pathToFileURL(path.join(REPO_ROOT, 'scripts/count-not-known.mjs')).href);
function fakeFetch({ total = 700, rows = {}, status = 200, short = false }) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    const u = new URL(url), table = u.pathname.split('/').pop();
    const all = table === 'trades_v2' && u.searchParams.get('select') === 'id' ? null : (rows[table] || []);
    const body = all == null ? [] : all;
    const n = all == null ? total : body.length + (short ? 1 : 0);
    return { ok: status === 200, status, text: async () => 'err', json: async () => body, headers: { get: () => `0-${Math.max(0, body.length - 1)}/${n}` } };
  };
  f.calls = calls;
  return f;
}
await run('the script: clean = exit 0 with the counts; defect, denied control, HTTP error or a short read = exit 1; GET only', async () => {
  const { main } = await script();
  const F = K.FIRST_MODE_BUILD;
  const out = [];
  let f = fakeFetch({ rows: { portfolio: [pos()], trades_v2: [sale()] } });
  assert.strictEqual(await main([], { fetchImpl: f, log: l => out.push(l) }), 0);
  assert.ok(out.some(l => /None recorded without Live\/Paper/.test(l)) && out[0].startsWith('not_known count, live at '));
  assert.ok(f.calls.every(c => c.method === 'GET'), 'read-only');
  assert.ok(f.calls[0].url.includes('trades_v2?select=id'), 'the control runs first');
  const cases = [
    [fakeFetch({ rows: { trades_v2: [sale({ sale_code_version: { app: F } })] } }), /DEFECT 1 recorded WITHOUT/],
    [fakeFetch({ total: 0 }), /COULD NOT READ \(trades_v2 reads back empty/],
    [fakeFetch({ status: 503 }), /COULD NOT READ \(trades_v2 control: HTTP 503/],
    [fakeFetch({ rows: { trades_v2: [sale()] }, short: true }), /COULD NOT READ \((portfolio|trades_v2): read \d+ rows of \d+\)/],
  ];
  for (const [ff, re] of cases) {
    const o = [];
    assert.strictEqual(await main([], { fetchImpl: ff, log: l => o.push(l) }), 1, String(re));
    assert.ok(o.some(l => re.test(l)), `${re}: ${o.join(' | ')}`);
  }
});

await run('the app: a Settings row beside the other readouts, loaded on render, the control before the reads, failure in red', () => {
  const app = readSource('app.js');
  assert.ok(app.includes('<span class="settings-label">Trades without Live/Paper</span>\n        <div class="settings-hint" id="not-known-count">Loading…</div>'));
  assert.ok(app.includes('  loadNotKnownCount();\n  loadWorkflowHealth();'), 'loaded with the Settings render');
  const fn = app.slice(app.indexOf('async function loadNotKnownCount('), app.indexOf('const DB_ROW_LIMIT'));
  assert.ok(fn.indexOf("select('id', { count: 'exact', head: true })") < fn.indexOf('readAllRows('), 'the control first');
  assert.ok(fn.includes("if (!all.count) throw"), 'a zero total is a failed read');
  assert.ok(/whether any was recorded without Live\/Paper is unknown/.test(fn) && fn.includes("el.style.color = 'var(--red)'"));
  assert.ok(fn.includes('notKnownLines(countNotKnown('), 'the shared classifier, not a copy');
  assert.ok(/<script src="core\/execution-mode-count\.js\?v=\d{14}"><\/script>\n  <script src="core\/orders\.js/.test(readSource('index.html').replace(/<script src="core\/store\.js[^\n]*\n  /, '')), 'loaded before app.js');
});

await run('the workflow: a read-only step after the backup is committed, turned red by its own fail step, before the outcome is logged', () => {
  const y = readSource('.github/workflows/backup-tables.yml');
  const at = s => { const i = y.indexOf(s); assert.ok(i >= 0, s); return i; };
  const step = at('- name: Count trades recorded without Live/Paper (read-only; db/042)');
  assert.ok(at('- name: Commit and push whatever passed') < step, 'after the backup is committed: it can never cost one');
  const fail = at("if: always() && steps.not_known.outputs.exit_code != '0'");
  assert.ok(step < fail && fail < at('- name: Log workflow outcome (Phase 9 §2.7)'), 'and the outcome is still logged last');
  assert.ok(y.slice(step, fail).includes('node scripts/count-not-known.mjs\n'), 'live, no flags');
  assert.ok(!/count-not-known\.mjs[^\n]*(--write|SERVICE|secrets\.)/.test(y), 'no credential, no write');
});
})();
