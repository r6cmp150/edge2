// tests/workflow-health.test.js — 2026-11-01. Fill outcomes failed its first
// run on five evenings and the only report was an email. Two fixes, pinned:
// the re-select that failed is chunked (one URL holding every id overflowed
// at ~400 ids), and Settings → App Info shows job health from workflow_runs,
// with three outcomes per run (success / failure / no outcome recorded).
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { readSource, run: runNow } = require('./_lib');
const queue = []; const run = (n, f) => queue.push([n, f]);

const app = readSource('app.js');
const grab = name => { const i = app.indexOf(`function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i) + 2); };
const ci = app.indexOf('const WORKFLOW_NAMES');
// eslint-disable-next-line no-eval
eval(app.slice(ci, app.indexOf('function workflowHealthLines(')) + grab('workflowHealthLines') + '\nglobal.__lines = workflowHealthLines; global.__names = WORKFLOW_NAMES;');

const NOW = Date.parse('2026-11-01T18:00:00Z');
const at = h => new Date(NOW - h * 3600000).toISOString();
const ok = (name, h) => ({ workflow_name: name, actual_fired_at: at(h), job_status: 'success' });
const allOk = () => global.__names.map(n => ok(n, 30));

run('all six clean: one line, not red, with the run count', () => {
  const l = global.__lines(allOk(), NOW);
  assert.deepStrictEqual(l, [{ bad: false, text: 'All 6 jobs: no failures in 8 days (6 runs).' }]);
});

run("Fill outcomes' real pattern: first run failed, later ones succeeded -> shown, not red", () => {
  const runs = [...allOk(), { workflow_name: 'Fill outcomes', actual_fired_at: at(20), job_status: 'failure' }, ok('Fill outcomes', 19)];
  const l = global.__lines(runs, NOW);
  const fo = l.find(x => x.text.startsWith('Fill outcomes:'));
  assert.ok(fo, 'a failure with a later success is still shown');
  assert.ok(/1 of 3 runs failed, last /.test(fo.text), fo.text);
  assert.ok(/latest run succeeded/.test(fo.text) && fo.bad === false);
  assert.ok(l.some(x => x.text === 'The other 5: no failures in 8 days.'));
});

run('latest run failed -> red', () => {
  const runs = [...allOk(), { workflow_name: 'Log EDGE signals', actual_fired_at: at(2), job_status: 'failure' }];
  const e = global.__lines(runs, NOW).find(x => x.text.startsWith('Log EDGE signals:'));
  assert.ok(e.bad && /latest run: failure/.test(e.text));
});

run('no outcome recorded is its own state: never success, never failure', () => {
  const runs = [...allOk(), { workflow_name: 'Build float table', actual_fired_at: at(5), job_status: null }];
  const b = global.__lines(runs, NOW).find(x => x.text.startsWith('Build float table:'));
  assert.ok(b && /1 recorded no outcome/.test(b.text) && !/failed/.test(b.text) && b.bad);
  // ...but a run still inside its first hour is just running.
  const fresh = [...allOk(), { workflow_name: 'Build float table', actual_fired_at: at(0.5), job_status: null }];
  assert.strictEqual(global.__lines(fresh, NOW).length, 1);
});

run('a job with no run in the window is shown, red', () => {
  const runs = allOk().filter(r => r.workflow_name !== 'Capture movers/most-actives snapshot');
  const c = global.__lines(runs, NOW).find(x => x.text.startsWith('Capture movers'));
  assert.ok(c && c.bad && /no run recorded in 8 days/.test(c.text));
});

run('the six names match the workflow files exactly', () => {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  const names = fs.readdirSync(dir).filter(f => f.endsWith('.yml')).map(f => fs.readFileSync(path.join(dir, f), 'utf8').match(/^name: (.+)$/m)[1].trim());
  assert.deepStrictEqual([...names].sort(), [...global.__names].sort());
});

run('wired: App Info row, loaded on render, read failure says unknown', () => {
  assert.ok(app.includes('<div class="settings-hint" id="workflow-health">Loading…</div>'));
  assert.ok(app.includes('  loadWorkflowHealth();\n  renderBuildStatus();'));
  assert.ok(grab('loadWorkflowHealth').includes('job health unknown'));
  assert.ok(!grab('loadWorkflowHealth').includes('innerHTML'), 'text only');
});

run('re-select by ids is chunked: 597 ids (10-30\'s failing run) -> 6 short URLs, every row back', async () => {
  const { selectByIds, SELECT_BY_IDS_CHUNK } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'lib', 'select-by-ids.mjs')).href);
  const ids = Array.from({ length: 597 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
  const urls = [];
  const fake = async url => { urls.push(url); const got = url.match(/in\.\(([^)]*)\)/)[1].split(','); return { status: 200, json: async () => got.map(id => ({ id })) }; };
  const rows = await selectByIds('https://x.supabase.co', 'signal_log', ids, 'id', {}, fake);
  assert.strictEqual(rows.length, 597);
  assert.strictEqual(urls.length, Math.ceil(597 / SELECT_BY_IDS_CHUNK));
  assert.ok(urls.every(u => u.length < 4100), `longest ${Math.max(...urls.map(u => u.length))}; 371 ids (13,806 chars) was the largest that worked`);
  await assert.rejects(selectByIds('u', 't', ids, 'id', {}, async () => ({ status: 414, text: async () => 'too long' })), /re-select of 100 id\(s\) failed: 414/);
});

run('no unchunked id-list re-select left in the scripts', () => {
  for (const f of ['scripts/fill-outcomes.mjs', 'scripts/audit-signal-log-splits.mjs']) {
    const s = readSource(f);
    assert.ok(!/id=in\.\(\$\{/.test(s), f);
    assert.ok(s.includes("from './lib/select-by-ids.mjs'"), f);
  }
});

(async () => { for (const [n, f] of queue) await runNow(n, f); })();
