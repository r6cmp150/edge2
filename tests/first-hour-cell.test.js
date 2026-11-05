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
  assert.deepStrictEqual([c.largestDay.date, c.largestDay.pnl, c.largestDay.sharePct], ['a', 6, 100], 'the share from its largest day');
  const lose = m.cell([{ pnl_dollars: -8, pnl_pct: -1, buy_date: 'a' }, { pnl_dollars: -2, pnl_pct: -1, buy_date: 'b' }, { pnl_dollars: 5, pnl_pct: 1, buy_date: 'c' }]);
  assert.deepStrictEqual([lose.largestDay.date, lose.largestDay.sharePct], ['a', 160], 'for a loss, the worst day, in the total\'s direction');
});

await run('the split: the Sunday orders are out of the time cells, and they are counted', () => {
  const pop = m.population(rows), firm = pop.filter(r => !m.notAtThatTime(r));
  const v2 = r => r.code_version && r.code_version.scoring === 2;
  const c = (list, a, b) => m.cell(list.filter(r => m.inCell(r, a, b)));
  assert.strictEqual(pop.filter(m.notAtThatTime).length, 24);
  near(m.cell(pop.filter(m.notAtThatTime)).pnl, -213.25, 'the Sunday orders');
  const morning = c(firm, '07:30', '10:00');
  assert.deepStrictEqual([morning.n, morning.days, morning.profitableDays], [231, 20, 12]);
  near(morning.pnl, 734.15, 'morning');
  near(morning.minusBest, 604.15, 'morning minus best');
  const oldMorning = c(firm.filter(r => !v2(r)), '07:30', '10:00');
  assert.deepStrictEqual([oldMorning.n, oldMorning.days, oldMorning.profitableDays], [65, 13, 7]);
  near(oldMorning.pnl, 87.10, 'morning before v2');
  near(oldMorning.minusBest, -42.90, 'and it loses without its best trade');
  const late = c(firm, '10:00', '13:00');
  assert.deepStrictEqual([late.n, late.days, late.profitableDays], [96, 15, 8]);
  near(late.pnl, -41.65, 'late morning');
  const after = c(firm, '13:00', '24:00');
  assert.deepStrictEqual([after.n, after.days, after.profitableDays], [27, 10, 3]);
  near(after.pnl, -177.85, 'after the close');
  assert.strictEqual(c(firm.filter(v2), '13:00', '24:00').n, 0, 'and none under v2');
});

await run('the same days: 07:30-09:59 against 07:00-07:29 is not clearly better', () => {
  const pop = m.population(rows);
  const s = m.sameDay(pop, ['07:00', '07:30'], ['07:30', '10:00']);
  assert.deepStrictEqual([s.days, s.better], [12, 7]);
  assert.strictEqual(s.p.toFixed(3), '0.387');
  near(s.meanDiff, 0.96, 'mean difference');
  const l = m.sameDay(pop, ['10:00', '13:00'], ['07:30', '10:00']);
  assert.deepStrictEqual([l.days, l.better], [10, 4]);
  // A check on the test itself: every day better gives (1/2)^n.
  const fake = ['a', 'b', 'c'].flatMap(d => [{ buy_date: d, buy_time: '07:10', pnl_pct: 0 }, { buy_date: d, buy_time: '08:00', pnl_pct: 1 }]).map(x => ({ ...x, buy_date: '2026-10-0' + (x.buy_date.charCodeAt(0) - 96 + 4) }));
  const f = m.sameDay(fake, ['07:00', '07:30'], ['07:30', '10:00']);
  assert.deepStrictEqual([f.days, f.better, f.p], [3, 3, 0.125]);
  // A CLOSED row isn't a trade at its stamp, so it can't make a day count or move its average.
  const withClosed = [...fake, { buy_date: '2026-10-05', buy_time: '08:00', pnl_pct: -99, buy_session: 'CLOSED' }];
  assert.deepStrictEqual(m.sameDay(withClosed, ['07:00', '07:30'], ['07:30', '10:00']).better, 3);
});

await run('the spec records it, with its limits', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('The 07:00–07:29 cell on the whole book'));
  assert.ok(spec.includes('| **118** | **18** | **50.4%** | **−0.95%** | **−$400.28** | **−$440.28** | **5 of 18** |'));
  assert.ok(spec.includes('v2 has not reversed them'));
  assert.ok(spec.includes('Compared on the same days, it is not clearly better'), 'the correction');
  assert.ok(spec.includes('never as evidence that early entries are bad'), 'and §3.4 still says so');
  assert.ok(spec.includes('BEKE and AGNT'), 'why the next run\'s n differs');
  assert.ok(spec.includes('Nothing about time of day is established.'), 'the wording for Roman');
  assert.ok(spec.indexOf("ANY FIGURE FOR ROMAN GOES THROUGH ITS SOURCE DOCUMENT'S OWN METHOD") > spec.indexOf('### 7.7'), 'the rule, in §7.7');
  assert.ok(spec.includes('This binds the reviewer as well as the implementer.'));
  assert.ok(spec.includes("A PUSH ISN'T DONE UNTIL ITS CI RUN HAS BEEN READ"));
  assert.ok(spec.includes("Roman's timing analysis calls unjudged at n=5"), 'the word is the timing analysis\'s, not this spec\'s');
});
})();
