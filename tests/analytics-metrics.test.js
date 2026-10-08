// tests/analytics-metrics.test.js — app.js's computeTradeMetrics/
// computeBiggestContributor/renderMetricsSummaryGrid (Analytics tab,
// Sold tab). Extracts via regex (same technique tests/persist-quota.test.js
// already uses) rather than eval'ing the whole of app.js.
//
// CORRECTION (2026-10, separate commit from the original extraction):
// win/loss/breakeven now matches generateClaudeReport's own three-bucket,
// pnlDollar-based, epsilon-tolerant definition — Roman's explicit call:
// "a trade that returns exactly your money is not a loss." This file
// used to diff the refactor against the OLD two-bucket pnlPct-based test
// to prove the extraction changed nothing; that was correct for THAT
// commit, but asserting it today would just pin the bug back in place.
// These tests now assert the NEW, corrected contract instead, plus a
// static guard (testOnlyOneSharedDefinitionExists) against the exact
// failure this correction fixed — the same classification logic had
// drifted into three separate copies before this.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

function extractFn(name) {
  const src = readSource('app.js');
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name}() from app.js`);
  return m[0];
}
function extractConst(name) {
  const src = readSource('app.js');
  const re = new RegExp(`const ${name} = [^;]+;`);
  const m = src.match(re);
  if (!m) throw new Error(`could not extract const ${name} from app.js`);
  return m[0];
}

function loadAnalyticsFns() {
  const constSrc = [extractConst('PNL_EPSILON'), extractConst('isWin'), extractConst('isLoss'), extractConst('isBreakeven')].join('\n');
  const fnNames = ['computeTradeMetrics', 'computeBiggestContributor', 'renderMetricsSummaryGrid'];
  const fnSrc = fnNames.map(extractFn).join('\n\n');
  const exposeLine = ['PNL_EPSILON', 'isWin', 'isLoss', 'isBreakeven', ...fnNames].map(n => `global.${n} = ${n};`).join(' ');
  // eslint-disable-next-line no-eval
  eval(constSrc + '\n' + fnSrc + '\n' + exposeLine);
  const out = {};
  for (const n of ['computeTradeMetrics', 'computeBiggestContributor', 'renderMetricsSummaryGrid']) out[n] = global[n];
  return out;
}

function mk(pnlDollar, pnlPct, ticker = 'XXX', sellPriceUnverified = false) { return { pnlDollar, pnlPct, ticker, sellPriceUnverified }; }
function normalize(html) { return html.replace(/>\s+</g, '><').trim(); }

// Regression guard for the exact failure this correction fixes: the
// classification (PNL_EPSILON/isWin/isLoss/isBreakeven) existed as THREE
// independent copies in app.js before this commit (buildSellTooEarlySection,
// generateClaudeReport, and computeTradeMetrics' own pre-correction
// pnlPct test) — found only because Roman asked why Sold/Analytics
// disagreed with the report. A static count, not a behavioral test: if
// someone reintroduces a second `const isWin = ` anywhere in app.js,
// this fails immediately, before the two copies have a chance to drift.
async function testOnlyOneSharedDefinitionExists() {
  const src = readSource('app.js');
  for (const name of ['PNL_EPSILON', 'isWin', 'isLoss', 'isBreakeven']) {
    const count = (src.match(new RegExp(`const ${name} = `, 'g')) || []).length;
    assert.strictEqual(count, 1, `expected exactly one top-level "const ${name} = " in app.js, found ${count} — a second copy is how this drifts again`);
  }
}

async function testEmptyArray() {
  const { computeTradeMetrics } = loadAnalyticsFns();
  const m = computeTradeMetrics([]);
  assert.deepStrictEqual(m, { count: 0, totalPnL: 0, winRate: null, wins: 0, losses: 0, breakeven: 0, excluded: 0 });
}

async function testSingleWinLossBreakeven() {
  const { computeTradeMetrics } = loadAnalyticsFns();
  assert.deepStrictEqual(computeTradeMetrics([mk(10, 5)]), { count: 1, totalPnL: 10, winRate: 100, wins: 1, losses: 0, breakeven: 0, excluded: 0 });
  assert.deepStrictEqual(computeTradeMetrics([mk(-7.5, -3)]), { count: 1, totalPnL: -7.5, winRate: 0, wins: 0, losses: 1, breakeven: 0, excluded: 0 });
  // The core of Roman's correction: a $0.00 trade is its own bucket, not
  // a loss, and winRate is null (no decided trades), not 0%.
  const breakeven = computeTradeMetrics([mk(0, 0, 'CCRN')]);
  assert.deepStrictEqual(breakeven, { count: 1, totalPnL: 0, winRate: null, wins: 0, losses: 0, breakeven: 1, excluded: 0 });
}

// db/026: sellPriceUnverified is "outcome unknown," not a breakeven and
// not a zero -- must never enter count/totalPnL/wins/losses/breakeven,
// and the exclusion itself must be visible on the returned object (so
// every caller can STATE it), not just silently shrink n.
async function testSellPriceUnverifiedExcludedEntirely() {
  const { computeTradeMetrics } = loadAnalyticsFns();
  const trades = [
    mk(10, 5, 'A'),
    mk(-5, -2, 'B'),
    mk(0, 0, 'REAL_BREAKEVEN'),           // genuine breakeven, NOT excluded
    mk(0, 0, 'FAKE1', true),              // fabricated $0.00 -- excluded
    mk(0, 0, 'FAKE2', true),              // fabricated $0.00 -- excluded
  ];
  const m = computeTradeMetrics(trades);
  assert.deepStrictEqual(m, { count: 3, totalPnL: 5, winRate: 50, wins: 1, losses: 1, breakeven: 1, excluded: 2 });
}

async function testAllTradesUnverifiedLeavesCountZeroNotCrash() {
  const { computeTradeMetrics } = loadAnalyticsFns();
  const m = computeTradeMetrics([mk(0, 0, 'FAKE1', true), mk(0, 0, 'FAKE2', true)]);
  assert.deepStrictEqual(m, { count: 0, totalPnL: 0, winRate: null, wins: 0, losses: 0, breakeven: 0, excluded: 2 });
}

async function testComputeBiggestContributorAlsoExcludesUnverified() {
  const { computeBiggestContributor } = loadAnalyticsFns();
  // FAKE's $0.00 must never be eligible to win (trivially wouldn't here
  // anyway, by magnitude) NOR dilute totalPnL used for pctOfTotal.
  const r = computeBiggestContributor([mk(10, 100, 'REAL'), mk(0, 0, 'FAKE', true)]);
  assert.deepStrictEqual(r, { ticker: 'REAL', pnlDollar: 10, pctOfTotal: 100 });
  assert.strictEqual(computeBiggestContributor([mk(0, 0, 'ONLY_FAKE', true)]), null);
}

async function testRenderMetricsSummaryGridStatesExcludedCountNotSilent() {
  const { computeTradeMetrics, renderMetricsSummaryGrid } = loadAnalyticsFns();
  const withExcluded = renderMetricsSummaryGrid(computeTradeMetrics([mk(10, 5), mk(0, 0, 'FAKE', true)]));
  console.log('grid with 1 excluded:', normalize(withExcluded));
  assert.ok(withExcluded.includes('1 trade excluded — sell price unverified, outcome unknown'), 'must STATE the excluded count, not silently show a smaller Trades tile with no explanation');
  const noExcluded = renderMetricsSummaryGrid(computeTradeMetrics([mk(10, 5)]));
  assert.ok(!noExcluded.includes('excluded'), 'no note at all when nothing was excluded');
}

async function testBreakevenExcludedFromWinRateDenominatorNotJustRelabeled() {
  const { computeTradeMetrics } = loadAnalyticsFns();
  // 2 wins, 1 loss, 2 breakeven -- decided = 3, winRate = 2/3, NOT 2/5.
  const m = computeTradeMetrics([mk(10, 5), mk(20, 8), mk(-5, -2), mk(0, 0), mk(0, 0)]);
  assert.strictEqual(m.breakeven, 2);
  assert.strictEqual(m.wins, 2);
  assert.strictEqual(m.losses, 1);
  assert.ok(Math.abs(m.winRate - (2 / 3 * 100)) < 1e-9, `winRate must be over DECIDED trades only (66.7%), got ${m.winRate}`);
}

async function testEpsilonCatchesAFloatThatDisplaysAsZeroButIsnt() {
  const { computeTradeMetrics } = loadAnalyticsFns();
  // A float a hair off zero (e.g. 4.9999999999999999999e-10, below the
  // epsilon) must still land as breakeven, not win/loss by a dust amount.
  const m = computeTradeMetrics([mk(1e-12, 0.0001)]);
  assert.strictEqual(m.breakeven, 1);
  assert.strictEqual(m.wins, 0);
}

async function testRenderMetricsSummaryGridNullWinRateIsNA() {
  const { computeTradeMetrics, renderMetricsSummaryGrid } = loadAnalyticsFns();
  const html = renderMetricsSummaryGrid(computeTradeMetrics([mk(0, 0, 'CCRN')]));
  console.log('all-breakeven grid:', normalize(html));
  assert.ok(html.includes('>N/A<'), 'a null winRate must render "N/A", never be toFixed()\'d into "NaN%"');
  assert.ok(!html.includes('NaN'));
}

async function testRenderMetricsSummaryGridShowsBreakevenBucketOnlyWhenNonzero() {
  const { computeTradeMetrics, renderMetricsSummaryGrid } = loadAnalyticsFns();
  const noBE = renderMetricsSummaryGrid(computeTradeMetrics([mk(10, 5), mk(-5, -2)]));
  assert.ok(/\d+W \/ \d+L<\/div>/.test(normalize(noBE)), 'zero breakeven must not clutter Record with "/ 0BE"');
  const withBE = renderMetricsSummaryGrid(computeTradeMetrics([mk(10, 5), mk(-5, -2), mk(0, 0)]));
  console.log('with-breakeven record:', normalize(withBE).match(/summary-cell-val">([^<]*)<\/div><div class="summary-cell-label">Record/)?.[1]);
  assert.ok(/1W \/ 1L \/ 1BE/.test(withBE), 'a nonzero breakeven count must show as its own bucket in Record');
}

async function testBiggestContributorEmptyAndSingle() {
  const { computeBiggestContributor } = loadAnalyticsFns();
  assert.strictEqual(computeBiggestContributor([]), null);
  const one = computeBiggestContributor([mk(10, 5, 'ONLY')]);
  assert.deepStrictEqual(one, { ticker: 'ONLY', pnlDollar: 10, pctOfTotal: 100 });
}

async function testBiggestContributorByAbsoluteDollarsNotBestPct() {
  const { computeBiggestContributor } = loadAnalyticsFns();
  const r = computeBiggestContributor([mk(100, 5, 'A'), mk(50, 200, 'B')]);
  assert.strictEqual(r.ticker, 'A');
}

async function testBiggestContributorNegativeContributorReportsNegativePct() {
  const { computeBiggestContributor } = loadAnalyticsFns();
  const r = computeBiggestContributor([mk(-30, -40, 'PACB'), mk(25, 10, 'X'), mk(25, 10, 'Y')]);
  assert.strictEqual(r.ticker, 'PACB');
  assert.ok(r.pctOfTotal < 0);
}

async function testBiggestContributorZeroTotalPnlIsNullNotInfinity() {
  const { computeBiggestContributor } = loadAnalyticsFns();
  const r = computeBiggestContributor([mk(50, 100, 'A'), mk(-50, -100, 'B')]);
  assert.strictEqual(r.ticker, 'A');
  assert.strictEqual(r.pctOfTotal, null);
}

(async () => {
  await run('analytics-metrics: exactly one shared win/loss/breakeven definition exists in app.js (regression guard)', testOnlyOneSharedDefinitionExists);
  await run('analytics-metrics: empty array', testEmptyArray);
  await run('analytics-metrics: single win/loss/breakeven', testSingleWinLossBreakeven);
  await run('analytics-metrics: breakeven excluded from the win-rate DENOMINATOR, not just relabeled', testBreakevenExcludedFromWinRateDenominatorNotJustRelabeled);
  await run('analytics-metrics: epsilon catches a near-zero float, not just exact 0', testEpsilonCatchesAFloatThatDisplaysAsZeroButIsnt);
  await run('analytics-metrics: renderMetricsSummaryGrid shows "N/A" for a null winRate, never NaN%', testRenderMetricsSummaryGridNullWinRateIsNA);
  await run('analytics-metrics: Record shows the breakeven bucket only when nonzero', testRenderMetricsSummaryGridShowsBreakevenBucketOnlyWhenNonzero);
  await run('analytics-metrics: computeBiggestContributor on empty/single-trade sets', testBiggestContributorEmptyAndSingle);
  await run('analytics-metrics: biggest contributor is by absolute dollars, not best percent return', testBiggestContributorByAbsoluteDollarsNotBestPct);
  await run('analytics-metrics: a dominant LOSS reports a negative percentage, not hidden', testBiggestContributorNegativeContributorReportsNegativePct);
  await run('analytics-metrics: a $0 total set reports pctOfTotal as null, never Infinity/NaN', testBiggestContributorZeroTotalPnlIsNullNotInfinity);
  await run('analytics-metrics: sellPriceUnverified trades are excluded entirely, not just relabeled', testSellPriceUnverifiedExcludedEntirely);
  await run('analytics-metrics: all trades unverified leaves count 0, not a crash', testAllTradesUnverifiedLeavesCountZeroNotCrash);
  await run('analytics-metrics: computeBiggestContributor also excludes unverified trades', testComputeBiggestContributorAlsoExcludesUnverified);
  await run('analytics-metrics: renderMetricsSummaryGrid STATES the excluded count, never silent', testRenderMetricsSummaryGridStatesExcludedCountNotSilent);
})();
