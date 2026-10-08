// tests/analytics-tab-render.test.js — app.js's Analytics tab (db/025
// analysis_periods). Extracts the pure rendering/attribution functions
// via regex (same technique tests/analytics-metrics.test.js and
// tests/persist-quota.test.js already use) rather than eval'ing the
// whole of app.js, which would need a DOM/supabaseClient mock this test
// has no reason to care about. Real core/clock.js is loaded for real
// getPT/ptDateStr — no reimplemented timezone math.
//
// Roman's explicit ask: show the LITERAL rendered strings for the two
// states most likely to be wrong and least likely to occur naturally
// while testing by hand — a period with zero trades, and a period where
// one trade is >60% of P&L. Both are asserted on exact substrings below,
// and both are printed in full so they can be read directly, not just
// trusted because the assertion passed.
'use strict';
const assert = require('assert');
const { readSource, evalModule, run } = require('./_lib');

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

function loadAnalyticsTabFns() {
  global.state = { settings: {} }; // core/clock.js's getPT doesn't need more than this
  evalModule(readSource('core/clock.js'), { expose: ['getPT', 'ptDateStr'] });
  // eslint-disable-next-line no-eval
  eval(extractConst('ANALYTICS_CONTRIBUTOR_DOMINANCE_PCT') + '\nglobal.ANALYTICS_CONTRIBUTOR_DOMINANCE_PCT = ANALYTICS_CONTRIBUTOR_DOMINANCE_PCT;');
  // computeTradeMetrics (below) references these as free top-level
  // variables, not self-contained -- same shared win/loss/breakeven
  // classification generateClaudeReport uses (app.js §18). Each exposed
  // onto global explicitly, in the SAME eval() call that declares it —
  // direct eval()'s const/let bindings don't survive past the call that
  // declared them otherwise (see tests/_lib.js's own comment on this).
  // eslint-disable-next-line no-eval
  eval([extractConst('PNL_EPSILON'), extractConst('isWin'), extractConst('isLoss'), extractConst('isBreakeven')].join('\n')
    + '\nglobal.PNL_EPSILON = PNL_EPSILON; global.isWin = isWin; global.isLoss = isLoss; global.isBreakeven = isBreakeven;');

  const names = [
    'computeTradeMetrics', 'computeBiggestContributor', 'renderMetricsSummaryGrid',
    '_buildAnalyticsSlots', '_analyticsSlotKey', '_tradeInAnalyticsSlot',
    '_countAnalyticsBoundarySpanning', '_analyticsSlotLabel', '_analyticsSlotDateLabel',
    '_renderAnalyticsPeriodCard', '_renderAnalyticsTrendsRow',
  ];
  const src = names.map(extractFn).join('\n\n');
  const exposeLine = names.map(n => `global.${n} = ${n};`).join(' ');
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeLine);
  const fns = {};
  for (const n of names) fns[n] = global[n];
  return fns;
}

function mkTrade({ ticker, pnlDollar, pnlPct, buyDate, sellDate }) {
  return { ticker, pnlDollar, pnlPct, buyDate, sellDate: sellDate || buyDate };
}

async function testZeroTradePeriodRendersNoTradesYetNotZeroPercent() {
  const fns = loadAnalyticsTabFns();
  const period = { id: 'p1', name: 'Tighter stop-loss (v2.19)', change_description: 'Tightened the same-day stop from 8% to 5%.', started_at: '2026-10-01T18:00:00Z' };
  const slots = fns._buildAnalyticsSlots([period]);
  const currentSlot = slots[0]; // newest-first -> [0] is current
  assert.strictEqual(currentSlot.kind, 'real');

  const html = fns._renderAnalyticsPeriodCard(currentSlot, /* allTrades */ [], /* isNewest */ true);
  console.log('\n--- ZERO-TRADE PERIOD CARD (literal rendered HTML) ---\n' + html + '\n--- end ---\n');

  assert.ok(html.includes('No trades yet.'), 'must say "No trades yet," not a numeric 0%/NaN%');
  assert.ok(!html.includes('summary-cell-label">Win Rate'), 'the three-state empty card must never reach the Win Rate tile — no 0%, no NaN%');
  assert.ok(!html.includes('sold-summary-grid'), 'the metrics grid must not even be reached for an empty slot');
  assert.ok(html.includes('Tighter stop-loss (v2.19)'), 'the period name must still show even with zero trades');
}

async function testDominantTradePeriodRendersWordedWarning() {
  const fns = loadAnalyticsTabFns();
  const period = { id: 'p1', name: 'Tighter stop-loss (v2.19)', change_description: 'Tightened the same-day stop from 8% to 5%.', started_at: '2026-10-01T18:00:00Z' };
  const slots = fns._buildAnalyticsSlots([period]);
  const currentSlot = slots[0];

  // 8 trades, AEVA alone is 91% of the period's P&L -- mirrors the exact
  // scenario shown in the approved mock.
  const trades = [
    mkTrade({ ticker: 'AEVA', pnlDollar: 38.20, pnlPct: 140, buyDate: '2026-10-01' }),
    mkTrade({ ticker: 'B', pnlDollar: 2.10, pnlPct: 4, buyDate: '2026-10-01' }),
    mkTrade({ ticker: 'C', pnlDollar: 1.80, pnlPct: 3, buyDate: '2026-10-02' }),
    mkTrade({ ticker: 'D', pnlDollar: -0.40, pnlPct: -2, buyDate: '2026-10-02' }),
    mkTrade({ ticker: 'E', pnlDollar: 1.00, pnlPct: 2, buyDate: '2026-10-03' }),
    mkTrade({ ticker: 'F', pnlDollar: -0.50, pnlPct: -3, buyDate: '2026-10-03' }),
    mkTrade({ ticker: 'G', pnlDollar: 0.30, pnlPct: 1, buyDate: '2026-10-04' }),
    mkTrade({ ticker: 'H', pnlDollar: -0.30, pnlPct: -1, buyDate: '2026-10-04' }),
  ];

  const html = fns._renderAnalyticsPeriodCard(currentSlot, trades, true);
  console.log('\n--- DOMINANT-TRADE (>60%) PERIOD CARD (literal rendered HTML) ---\n' + html + '\n--- end ---\n');

  assert.ok(html.includes('AEVA'), 'the dominant ticker must be named');
  assert.ok(/is 91% of this period's result/.test(html), 'the warning must state the real percentage in words, not just a number in a column');
  assert.ok(html.includes('this is one trade, not yet a trend'), 'must use Roman\'s own framing, not a generic warning');
  assert.ok(html.includes('n=8 is too small'), 'n must be stated alongside the warning, same card, not a separate lookup');
  assert.ok(html.includes('class="analytics-dominance-warning"'), 'must render as the dedicated warning block, not folded into the contributor line silently');
}

async function testBelowThresholdContributorRendersNoWarning() {
  const fns = loadAnalyticsTabFns();
  const period = { id: 'p1', name: 'Baseline', change_description: 'x', started_at: '2026-08-01T18:00:00Z' };
  const slots = fns._buildAnalyticsSlots([period]);
  const trades = [
    mkTrade({ ticker: 'KEEL', pnlDollar: 31, pnlPct: 20, buyDate: '2026-08-05' }),
    mkTrade({ ticker: 'A', pnlDollar: 20, pnlPct: 10, buyDate: '2026-08-06' }),
    mkTrade({ ticker: 'B', pnlDollar: 33, pnlPct: 15, buyDate: '2026-08-07' }),
  ];
  const html = fns._renderAnalyticsPeriodCard(slots[0], trades, true);
  console.log('\n--- BELOW-THRESHOLD CONTRIBUTOR (37%, no warning) ---\n' + html + '\n--- end ---\n');
  assert.ok(!html.includes('analytics-dominance-warning'), 'a contributor under 60% must NOT trigger the dominance warning');
  assert.ok(html.includes('B +$33.00'), 'the contributor line itself must still show (B is the biggest by absolute dollars here, not KEEL), just without the warning');
}

async function testDerivedBaselinePartitionsExactlyWithNoOverlap() {
  const fns = loadAnalyticsTabFns();
  const period = { id: 'p1', name: 'RVOL threshold raise (v2.18)', change_description: 'x', started_at: '2026-09-15T18:00:00Z' };
  const trades = [
    mkTrade({ ticker: 'A', pnlDollar: 10, pnlPct: 5, buyDate: '2026-08-01' }), // before the marker -> baseline
    mkTrade({ ticker: 'B', pnlDollar: 20, pnlPct: 8, buyDate: '2026-09-14' }), // last day before the marker -> baseline
    mkTrade({ ticker: 'C', pnlDollar: 30, pnlPct: 9, buyDate: '2026-09-15' }), // same day the period starts -> real period (PT calendar-day granularity)
    mkTrade({ ticker: 'D', pnlDollar: 40, pnlPct: 11, buyDate: '2026-10-01' }), // well after -> real period
  ];
  const slots = fns._buildAnalyticsSlots([period]);
  assert.strictEqual(slots.length, 2);
  const [real, baseline] = slots;
  assert.strictEqual(baseline.kind, 'baseline');

  const inReal = trades.filter(t => fns._tradeInAnalyticsSlot(t, real));
  const inBaseline = trades.filter(t => fns._tradeInAnalyticsSlot(t, baseline));
  console.log('real period trades:', inReal.map(t => t.ticker), '| baseline trades:', inBaseline.map(t => t.ticker));
  assert.deepStrictEqual(inReal.map(t => t.ticker).sort(), ['C', 'D']);
  assert.deepStrictEqual(inBaseline.map(t => t.ticker).sort(), ['A', 'B']);
  // Partition, not overlap or drop: every trade attributed exactly once.
  assert.strictEqual(inReal.length + inBaseline.length, trades.length);
}

async function testBoundarySpanningTradeIsCountedOnTheClosedSlot() {
  const fns = loadAnalyticsTabFns();
  const periods = [
    { id: 'p1', name: 'Period 1', change_description: 'x', started_at: '2026-09-01T18:00:00Z' },
    { id: 'p2', name: 'Period 2', change_description: 'y', started_at: '2026-10-01T18:00:00Z' },
  ];
  const slots = fns._buildAnalyticsSlots(periods); // [p2 (current), p1 (closed), baseline]
  const p1Slot = slots.find(s => s.kind === 'real' && s.period.id === 'p1');
  const spanning = mkTrade({ ticker: 'SPAN', pnlDollar: 5, pnlPct: 2, buyDate: '2026-09-20', sellDate: '2026-10-05' });
  const clean = mkTrade({ ticker: 'CLEAN', pnlDollar: 5, pnlPct: 2, buyDate: '2026-09-20', sellDate: '2026-09-25' });
  const tradesInSlot = [spanning, clean].filter(t => fns._tradeInAnalyticsSlot(t, p1Slot));
  const count = fns._countAnalyticsBoundarySpanning(tradesInSlot, p1Slot);
  console.log('boundary-spanning count for period 1:', count);
  assert.strictEqual(count, 1, 'only the trade sold AFTER period 1 ended should count as spanning');

  const html = fns._renderAnalyticsPeriodCard(p1Slot, [spanning, clean], false);
  assert.ok(html.includes('1 trade bought in this period but sold in a later one'));
}

(async () => {
  await run('analytics-tab: a zero-trade period renders "No trades yet," never 0%/NaN%', testZeroTradePeriodRendersNoTradesYetNotZeroPercent);
  await run('analytics-tab: a >60%-dominant trade renders the worded warning', testDominantTradePeriodRendersWordedWarning);
  await run('analytics-tab: a <60% contributor renders no warning', testBelowThresholdContributorRendersNoWarning);
  await run('analytics-tab: the derived baseline partitions trades exactly, no overlap/drop', testDerivedBaselinePartitionsExactlyWithNoOverlap);
  await run('analytics-tab: a boundary-spanning trade is counted on its own (closed) slot', testBoundarySpanningTradeIsCountedOnTheClosedSlot);
})();
