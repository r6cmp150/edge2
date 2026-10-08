// tests/analytics-metrics.test.js — app.js's computeTradeMetrics/
// computeBiggestContributor/renderMetricsSummaryGrid (Analytics tab,
// 2026-10). Extracts the three functions via regex (same technique
// tests/persist-quota.test.js already uses for core/store.js's persist())
// rather than eval'ing the whole of app.js, which would need a DOM/
// supabaseClient mock this test has no reason to care about.
//
// Two jobs, not one:
//   1. Prove the REFACTOR changed nothing — renderSoldTab used to compute
//      these four numbers inline; this diffs the NEW
//      computeTradeMetrics+renderMetricsSummaryGrid path against the OLD
//      inline code (frozen here verbatim, not re-derived) across several
//      trade sets, including the two edge cases most likely to be wrong
//      and least likely to come up while testing by hand: an empty set
//      and a single trade.
//   2. Prove the three-state contract Roman asked for: computeTradeMetrics
//      returns a NUMBER (0) for an empty set's winRate, matching the
//      original inline fallback exactly — count===0 is what a caller
//      must check to render "no trades yet" instead of "0%", never a
//      property of winRate itself (see app.js's own comment on this).
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

function loadAnalyticsFns() {
  const src = [
    extractFn('computeTradeMetrics'),
    extractFn('computeBiggestContributor'),
    extractFn('renderMetricsSummaryGrid'),
  ].join('\n\n');
  // eslint-disable-next-line no-eval
  eval(src + `
global.__computeTradeMetrics = computeTradeMetrics;
global.__computeBiggestContributor = computeBiggestContributor;
global.__renderMetricsSummaryGrid = renderMetricsSummaryGrid;
`);
  return {
    computeTradeMetrics: global.__computeTradeMetrics,
    computeBiggestContributor: global.__computeBiggestContributor,
    renderMetricsSummaryGrid: global.__renderMetricsSummaryGrid,
  };
}

// The ORIGINAL inline code renderSoldTab ran before this extraction —
// frozen here VERBATIM (copied, not re-derived from memory of what it
// did), so this test can never drift toward agreeing with a changed
// "new" version by accident. This is the ground truth the refactor must
// match exactly.
function oldInlineComputeAndRender(filteredSold) {
  const wins = filteredSold.filter(s => s.pnlPct > 0);
  const losses = filteredSold.filter(s => s.pnlPct <= 0);
  const winRate = filteredSold.length ? (wins.length / filteredSold.length * 100).toFixed(0) : 0;
  const totalPnL = filteredSold.reduce((sum, s) => sum + s.pnlDollar, 0);
  return `<div class="sold-summary-grid">
        <div class="summary-cell">
          <div class="summary-cell-val">${filteredSold.length}</div>
          <div class="summary-cell-label">Trades</div>
        </div>
        <div class="summary-cell">
          <div class="summary-cell-val">${winRate}%</div>
          <div class="summary-cell-label">Win Rate</div>
        </div>
        <div class="summary-cell">
          <div class="summary-cell-val ${totalPnL>=0?'pos':'neg'}">${totalPnL>=0?'+':''}$${totalPnL.toFixed(0)}</div>
          <div class="summary-cell-label">Total P&L</div>
        </div>
        <div class="summary-cell">
          <div class="summary-cell-val">${wins.length}W / ${losses.length}L</div>
          <div class="summary-cell-label">Record</div>
        </div>
      </div>`;
}

// Whitespace BETWEEN tags is cosmetic (indentation changed when the
// template moved from being nested inside renderSoldTab's own literal to
// its own function) and must not fail this diff; whitespace and text
// INSIDE a tag (the actual numbers/labels) must match exactly. Collapsing
// runs of whitespace between '>' and '<' is a semantic-HTML comparison,
// not a byte-for-byte one — the right comparison for "did the refactor
// change anything a user would see."
function normalize(html) {
  return html.replace(/>\s+</g, '><').trim();
}

function mk(pnlDollar, pnlPct, ticker = 'XXX') { return { pnlDollar, pnlPct, ticker }; }

const FIXTURES = {
  empty: [],
  singleWin: [mk(10, 5)],
  singleLoss: [mk(-7.5, -3)],
  singleBreakeven: [mk(0, 0)], // pnlPct === 0 must count as a LOSS (<=0), not a win -- the exact boundary the original inline filter used
  mixed: [mk(46.68, 92, 'TENX'), mk(-20.40, -15, 'BTDR'), mk(-31.50, -22, 'KEEL'), mk(12.00, 8, 'PGEN')],
  oneTradeDominates: [mk(38.20, 140, 'AEVA'), mk(2.10, 4, 'B'), mk(1.80, 3, 'C'), mk(-0.40, -2, 'D')],
};

async function testRenderedOutputMatchesOldInlineCodeAcrossFixtures() {
  const { computeTradeMetrics, renderMetricsSummaryGrid } = loadAnalyticsFns();
  for (const [name, trades] of Object.entries(FIXTURES)) {
    const oldHtml = normalize(oldInlineComputeAndRender(trades));
    const newHtml = normalize(renderMetricsSummaryGrid(computeTradeMetrics(trades)));
    console.log(`fixture "${name}": old=${JSON.stringify(oldHtml)}`);
    console.log(`fixture "${name}": new=${JSON.stringify(newHtml)}`);
    assert.strictEqual(newHtml, oldHtml, `fixture "${name}": refactored output must match the original inline code exactly`);
  }
}

async function testEmptyArrayIsTheOriginalZeroFallbackNotNull() {
  const { computeTradeMetrics } = loadAnalyticsFns();
  const m = computeTradeMetrics([]);
  assert.strictEqual(m.count, 0);
  assert.strictEqual(m.totalPnL, 0);
  assert.strictEqual(m.winRate, 0, 'winRate must be the number 0 for an empty set -- identical to the pre-extraction `filteredSold.length ? ... : 0` fallback, not null (callers distinguish "no trades" from "a real 0%" via count===0, never via winRate\'s value)');
  assert.strictEqual(m.wins, 0);
  assert.strictEqual(m.losses, 0);
}

async function testSingleTradeArray() {
  const { computeTradeMetrics } = loadAnalyticsFns();
  const win = computeTradeMetrics([mk(10, 5)]);
  assert.deepStrictEqual(win, { count: 1, totalPnL: 10, winRate: 100, wins: 1, losses: 0 });
  const loss = computeTradeMetrics([mk(-7.5, -3)]);
  assert.deepStrictEqual(loss, { count: 1, totalPnL: -7.5, winRate: 0, wins: 0, losses: 1 });
  const breakeven = computeTradeMetrics([mk(0, 0)]);
  assert.strictEqual(breakeven.winRate, 0, 'pnlPct === 0 is a loss, not a win -- <=0, preserved from the original filter');
  assert.strictEqual(breakeven.losses, 1);
}

async function testBiggestContributorEmptyAndSingle() {
  const { computeBiggestContributor } = loadAnalyticsFns();
  assert.strictEqual(computeBiggestContributor([]), null);
  const one = computeBiggestContributor([mk(10, 5, 'ONLY')]);
  assert.deepStrictEqual(one, { ticker: 'ONLY', pnlDollar: 10, pctOfTotal: 100 });
}

async function testBiggestContributorByAbsoluteDollarsNotBestPct() {
  const { computeBiggestContributor } = loadAnalyticsFns();
  // B has the better % return, but A moved the total P&L more in dollar
  // terms -- A must win. Mirrors the real floor-analysis finding this is
  // modeled on: the biggest DOLLAR mover, not the biggest percentage.
  const r = computeBiggestContributor([mk(100, 5, 'A'), mk(50, 200, 'B')]);
  assert.strictEqual(r.ticker, 'A');
}

async function testBiggestContributorNegativeContributorReportsNegativePct() {
  const { computeBiggestContributor } = loadAnalyticsFns();
  // Total is POSITIVE ($20: -30 + 25 + 25) while the biggest mover is a
  // LOSS -- that sign mismatch is what must surface as a negative
  // percentage. (A biggest-loss-with-an-also-negative-total, e.g.
  // -30/-10, would wrongly look "positive" by this same arithmetic --
  // not this test's case, just the reason the fixture is built this way
  // rather than assumed.)
  const r = computeBiggestContributor([mk(-30, -40, 'PACB'), mk(25, 10, 'X'), mk(25, 10, 'Y')]);
  assert.strictEqual(r.ticker, 'PACB');
  assert.ok(r.pctOfTotal < 0, 'a loss that dominates a POSITIVE-total set must report a NEGATIVE percentage, not be hidden or reported positive');
}

async function testBiggestContributorZeroTotalPnlIsNullNotInfinity() {
  const { computeBiggestContributor } = loadAnalyticsFns();
  const r = computeBiggestContributor([mk(50, 100, 'A'), mk(-50, -100, 'B')]);
  assert.strictEqual(r.ticker, 'A'); // tie on |pnlDollar| -- reduce() keeps the first seen, deterministic
  assert.strictEqual(r.pctOfTotal, null, 'a $0 total has no computable "share of total" -- must be null, never Infinity/NaN');
}

(async () => {
  await run('analytics-metrics: refactored summary grid matches the original inline code across every fixture (the before/after diff)', testRenderedOutputMatchesOldInlineCodeAcrossFixtures);
  await run('analytics-metrics: empty array -> winRate is the number 0, matching the original fallback exactly', testEmptyArrayIsTheOriginalZeroFallbackNotNull);
  await run('analytics-metrics: single-trade array (win/loss/breakeven)', testSingleTradeArray);
  await run('analytics-metrics: computeBiggestContributor on empty/single-trade sets', testBiggestContributorEmptyAndSingle);
  await run('analytics-metrics: biggest contributor is by absolute dollars, not best percent return', testBiggestContributorByAbsoluteDollarsNotBestPct);
  await run('analytics-metrics: a dominant LOSS reports a negative percentage, not hidden', testBiggestContributorNegativeContributorReportsNegativePct);
  await run('analytics-metrics: a $0 total set reports pctOfTotal as null, never Infinity/NaN', testBiggestContributorZeroTotalPnlIsNullNotInfinity);
})();
