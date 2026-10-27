// tests/scorer-clock-free.test.js — phase-10 §7.7 (2026-10-27). A stored
// signal snapshot re-scores exactly (tests/signal-snapshot-at-buy.test.js)
// BECAUSE the score never reads the clock. That's a property, not an
// observation, and it's the thing that would quietly break if a future
// scoring term ever read the time: the snapshot would still look
// reproducible, and wouldn't be. Pinned here:
//   - the scoring code reads the clock in exactly ONE place, the news-age
//     line in scoreStock;
//   - that value feeds only risk (calcRiskScore), never the score;
//   - the point function (scoreComponents) and the indicators read no
//     clock at all.
// A new clock read in core/edge-scoring.js or core/indicators.js fails
// this test. If one is ever genuinely needed, the snapshot must store its
// value (the §7.7 rule), and this test is changed in the same commit, on
// purpose.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

// Clock access: Date.now(), new Date() with no argument (parsing a stored
// timestamp, new Date(x), is not a clock read), getPT(), ptDateStr(getPT
// ...), performance.now(), and the PT-wall-clock helpers.
const CLOCK = /Date\.now\s*\(|new Date\s*\(\s*\)|\bgetPT\s*\(|performance\.now\s*\(|\bisMarketHoursNow\s*\(|\bisAfternoonMode\s*\(|\bisPreMarketHours\s*\(|\bgetMarketStatus\s*\(/;
const code = src => src.split('\n').map((l, i) => ({ n: i + 1, l: l.replace(/\/\/.*$/, '') })).filter(x => x.l.trim());

run('the scoring code reads the clock in exactly one place: the news age', () => {
  const lines = code(readSource('core/edge-scoring.js')).filter(x => CLOCK.test(x.l));
  console.log('clock reads in core/edge-scoring.js:', lines.map(x => `${x.n}: ${x.l.trim()}`));
  assert.strictEqual(lines.length, 1, `expected exactly 1 clock read, found ${lines.length}`);
  assert.ok(/const newsAgeH = newsItem \? \(Date\.now\(\) - new Date\(newsItem\.created_at\)\.getTime\(\)\) \/ 3600000 : Infinity;/.test(lines[0].l), lines[0].l);
});

run('the one clock-derived value feeds risk only, never the score', () => {
  const src = readSource('core/edge-scoring.js');
  const i = src.indexOf('function scoreStock('); const body = src.slice(i, src.indexOf('\n}\n', i));
  const uses = body.split('\n').filter(l => /hasRecentNegNews|newsAgeH/.test(l.replace(/\/\/.*$/, '')));
  // Defined from newsAgeH, then used once: as calcRiskScore's argument.
  assert.deepStrictEqual(uses.map(l => l.trim()), [
    'const newsAgeH = newsItem ? (Date.now() - new Date(newsItem.created_at).getTime()) / 3600000 : Infinity;',
    'const hasRecentNegNews = hasNegNews && newsAgeH <= 24;',
    'const risk = calcRiskScore(price, atr, rsi, volRatio, hasRecentNegNews);',
  ]);
  const sc = src.slice(src.indexOf('function scoreComponents('), src.indexOf('\n}\n', src.indexOf('function scoreComponents(')));
  assert.ok(!/newsAgeH|hasRecentNegNews|newsItem/.test(sc), 'the point function never sees the news age');
});

run('the point function and the indicators read no clock', () => {
  const src = readSource('core/edge-scoring.js');
  const sc = src.slice(src.indexOf('function scoreComponents('), src.indexOf('\n}\n', src.indexOf('function scoreComponents(')));
  assert.ok(sc.length > 200);
  assert.ok(!code(sc).some(x => CLOCK.test(x.l)), 'scoreComponents reads the clock');
  const ind = code(readSource('core/indicators.js')).filter(x => CLOCK.test(x.l));
  assert.deepStrictEqual(ind, [], 'core/indicators.js reads the clock');
});
