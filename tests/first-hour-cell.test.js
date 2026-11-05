// tests/first-hour-cell.test.js — 2026-11-05. The 07:00-07:29 cell on the whole book, pinned. It first
// reproduces the published figure, so the method is the one that produced it.
'use strict';
const assert = require('assert');
const path = require('path');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');
const { readSource, run, REPO_ROOT } = require('./_lib');

const at = (rev) => { try { return JSON.parse(execSync(`git show ${rev}:data/backups/trades_v2.json`, { cwd: REPO_ROOT, maxBuffer: 2e9, encoding: 'utf8' })); } catch (_) { return null; } };
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 0.005, `${label}: ${a} vs ${b}`);

(async () => {
const m = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/audit-first-hour-cell.mjs')).href);
const old = at('b4620bc'), rows = at('164099a');
if (!old || !rows) { console.log('  (pinned backups not readable: shallow clone)'); await run('skipped: no history', () => {}); return; }

await run('it reproduces the published cell before saying anything new', () => {
  const c = m.cell(old.filter(r => !r.sell_price_unverified && r.buy_time).filter(r => m.inCell(r, '07:00', '07:30')));
  assert.strictEqual(c.n, 70);
  assert.strictEqual(c.days, 14);
  near(c.pnl, -377.03, 'P&L');
});

await run('the population is the timing analysis\'s: unverified and the resurrected pairs out', () => {
  assert.strictEqual(m.pairRows(rows).length, 18);
  assert.strictEqual(m.population(rows).length, 501);
  const v2 = r => r.code_version && r.code_version.scoring === 2;
  assert.strictEqual(m.population(rows).filter(r => !v2(r)).length, 252, 'the 252 the two documents agree on');
});

await run('the whole-book cell, pinned', () => {
  const pop = m.population(rows);
  const v2 = r => r.code_version && r.code_version.scoring === 2;
  const c = m.cell(pop.filter(r => m.inCell(r, '07:00', '07:30')));
  assert.deepStrictEqual([c.n, c.days, c.profitableDays], [118, 18, 5]);
  near(c.pnl, -400.28, 'P&L');
  near(c.minusBest, -440.28, 'minus best');
  assert.strictEqual(c.winRate.toFixed(1), '50.4', 'win rate');
  const n = m.cell(pop.filter(v2).filter(r => m.inCell(r, '07:00', '07:30')));
  assert.deepStrictEqual([n.n, n.days, n.profitableDays], [48, 4, 1]);
  near(n.pnl, -23.25, 'v2 P&L');
});

await run('the boundaries are the cell\'s, and a losing trade is not a win', () => {
  for (const [t, inside] of [['06:59', false], ['07:00', true], ['07:29', true], ['07:30', false]]) assert.strictEqual(m.inCell({ buy_time: t }, '07:00', '07:30'), inside, t);
  const c = m.cell([{ pnl_dollars: 10, pnl_pct: 1, buy_date: 'a' }, { pnl_dollars: -4, pnl_pct: -1, buy_date: 'a' }, { pnl_dollars: 0, pnl_pct: 0, buy_date: 'b' }]);
  assert.deepStrictEqual([c.wins, c.losses, c.days, c.profitableDays], [1, 1, 2, 1]);
  near(c.minusBest, -4, 'the best trade removed');
});

await run('the spec records it, with its limits', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('The 07:00–07:29 cell on the whole book'));
  assert.ok(spec.includes('| **118** | **18** | **50.4%** | **−0.95%** | **−$400.28** | **−$440.28** | **5 of 18** |'));
  assert.ok(spec.includes('v2 has not reversed it'));
  assert.ok(spec.includes('07:00–07:29 is not the only weak cell'));
  assert.ok(spec.includes("Roman's timing analysis calls unjudged at n=5"), 'the word is the timing analysis\'s, not this spec\'s');
});
})();
