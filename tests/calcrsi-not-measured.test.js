// tests/calcrsi-not-measured.test.js -- 2026-11-14. calcRSI returned 50 below 15 closes, a neutral-looking reading
// nobody measured. It returns null now, and its reachable callers say "not measured", with the reason:
//   - the stock modal (an owned position's recommendation block and its AI PROMPT: the most consequential, because a
//     model reasons from the number and then speaks with the confidence of the rest of the prompt);
//   - the pre-market movers, their panel and their prompt.
// It changes NO scan score: scoreStock refuses fewer than 15 bars before it calls calcRSI (held below), so the scan
// never reached the 50. Checked 2026-11-14 against 24 stored rows of exactly 50, all genuine (125-126 closes each).
// A null must never reach a comparison in the core helpers: null < 35 and null < 50 are true. Measured that day, a
// null gave the under-35 band, a WEEK duration and 2 extra risk points. The display callers pass NaN (no band,
// 0 points). Each case below runs the real function.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');
const grab = n => { const i = app.search(new RegExp(`^(async )?function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
const constOf = n => {
  const i = app.search(new RegExp(`^const ${n} = `, 'm')); assert.ok(i >= 0, n);
  const line = app.slice(i, app.indexOf('\n', i));
  if (!/[{\[(]\s*$/.test(line)) return line.replace(/^const /, 'var ') + '\n';
  const ends = [app.indexOf('\n};\n', i), app.indexOf('\n];\n', i)].filter(x => x > 0).sort((a, b) => a - b);
  return app.slice(i, ends[0] + 4).replace(/^const /, 'var ');
};
// The real core files, then the named app.js functions and constants each target needs (listed, not discovered).
function load(fns, consts = [], extra = {}) {
  const ctx = { Math, Object, String, Number, Array, JSON, Date, console, isFinite, isNaN, Infinity, NaN, Intl, ...extra };
  vm.createContext(ctx);
  vm.runInContext(['core/clock.js', 'core/indicators.js', 'core/market-data.js', 'core/edge-scoring.js'].map(f => strip(readSource(f))).join('\n'), ctx);
  vm.runInContext(consts.map(constOf).join('\n') + fns.map(grab).join('\n')
    + `;globalThis.__f = { ${fns.join(', ')} }; globalThis.__core = { calcRSI, scoreStock };`, ctx);
  return ctx;
}
const closes = n => Array.from({ length: n }, (_, i) => 10 + ((i * 7) % 5) * 0.1);

run('calcRSI: below 15 closes it is null, not 50; from 15 it measures', () => {
  const { calcRSI } = load([]).__core;
  for (let n = 0; n < 15; n++) assert.strictEqual(calcRSI(closes(n)), null, `n=${n}`);
  for (const n of [15, 20, 126]) { const v = calcRSI(closes(n)); assert.ok(typeof v === 'number' && v >= 0 && v <= 100, `n=${n}: ${v}`); }
});

run('reachability: the scan cannot reach it. scoreStock refuses fewer than 15 bars BEFORE calling calcRSI', () => {
  const src = readSource('core/edge-scoring.js');
  const s = src.slice(src.indexOf('function scoreStock('));
  assert.ok(s.indexOf('if (bars.length < 15) return null;') >= 0 && s.indexOf('if (bars.length < 15) return null;') < s.indexOf('calcRSI(closes)'), 'the gate comes first');
  assert.ok(src.includes('closes.length >= 17 ? calcRSI(closes.slice(0, -3)) : rsi') && src.includes('closes.length >= 18 ? calcRSI(closes.slice(0, -3)) : rsi'), 'its other calls are guarded at 17 and 18');
  const { scoreStock } = load([]).__core;
  const bars = Array.from({ length: 14 }, (_, i) => ({ t: `2026-10-${String(i + 1).padStart(2, '0')}`, c: 5 + i * 0.01, v: 1e6, h: 5.1, l: 4.9, o: 5 }));
  assert.strictEqual(scoreStock('AAA', { dailyBar: { c: 5.2, v: 1e6 }, latestTrade: { p: 5.2 }, prevDailyBar: { c: 5.1 } }, bars, null), null);
});

run('the modal: the band and the breakdown say "not measured", never the under-35 band null would give', () => {
  const ctx = load(['rsiBandDescription', 'computeScoreBreakdown'], ['VOL_BAND_DESCRIPTIONS', 'RSI_BAND_DESCRIPTIONS']);
  assert.strictEqual(ctx.__f.rsiBandDescription(null), 'RSI not measured');
  const s = { ticker: 'AAA', price: 5, todayChange: 1, volRatio: 1.2, ma20: 4.8, rsi: null, rsiNotMeasured: '5 daily closes came back, 15 needed', spyChange: 0, consUpDays: 0 };
  const row = ctx.__f.computeScoreBreakdown(s).rows.find(r => r.key === 'rsi');
  assert.strictEqual(row.label, 'RSI not measured — 5 daily closes came back, 15 needed');
  assert.strictEqual(row.pts, 0);
  // positive control: a measured RSI keeps its band and points
  const m = ctx.__f.computeScoreBreakdown({ ...s, rsi: 58 }).rows.find(r => r.key === 'rsi');
  assert.ok(/^RSI position \(58\)/.test(m.label) && m.pts === 20, m.label);
});

run('the AI prompt says "not measured (reason)" and never substitutes the scan\'s older reading', () => {
  const ctx = load(['buildAIPrompt', 'deriveVolumeTrend'], ['MAX_HOLD_DAYS', 'AI_NO_MARKET_STATE_LINE'], { state: { macroContext: null, settings: {} } });
  const bars = Array.from({ length: 20 }, (_, i) => ({ c: 5 + i * 0.01, v: 1e6, t: `2026-11-${String(i + 1).padStart(2, '0')}` }));
  const stock = { company: 'AAA Inc', entry: 5, target: 5.5, stop: 4.6, ma20: 4.8, risk: 4, score: 60, bars, ticker: 'AAA', price: 5,
    rsi: 61, liveRsi: null, liveRsiNotMeasured: '5 daily closes came back, 15 needed', livePrice: 5, todayChange: 1, volRatio: 1.2, duration: 'WEEK', news: null, signal: 'WATCH' };
  const line = /RSI \(14-day\)[^\n]*/.exec(ctx.__f.buildAIPrompt(stock, null))[0];
  assert.strictEqual(line, 'RSI (14-day): not measured (5 daily closes came back, 15 needed)');
  // A stock with no live reading at all (liveRsi absent) still uses its own measured RSI.
  const { liveRsi, liveRsiNotMeasured, ...noLive } = stock;
  assert.strictEqual(/RSI \(14-day\)[^\n]*/.exec(ctx.__f.buildAIPrompt(noLive, null))[0], 'RSI (14-day): 61.0');
});

run('the pre-market movers: unmeasured below 15 closes, with the reason, in the panel and the prompt', async () => {
  const ctx = load(['computePreMarketMovers', 'buildPreMarketGroqPrompt', 'preMarketPrevClose', 'preMarketRsiLabel'], ['AI_NO_MARKET_STATE_LINE'], { state: { signals: [], settings: {} } });
  const snap = { minuteBar: { c: 5.15 }, prevDailyBar: { c: 5 } };
  const b = n => Array.from({ length: n }, (_, i) => ({ c: 5 + (i % 3) * 0.05 }));
  await ctx.__f.computePreMarketMovers({}, [['AAA', snap], ['BBB', snap], ['CCC', snap]], { AAA: b(5), BBB: [], CCC: b(20) }, {});
  const movers = ctx.state.preMarketMovers; // it writes the top five to state; it returns nothing
  assert.strictEqual(movers.length, 3);
  const by = Object.fromEntries(movers.map(m => [m.ticker, m]));
  assert.deepStrictEqual([by.AAA.rsi, by.AAA.rsiNotMeasured], [null, '5 daily closes came back, 15 needed']);
  assert.deepStrictEqual([by.BBB.rsi, by.BBB.rsiNotMeasured], [null, 'no daily bars came back']);
  assert.ok(typeof by.CCC.rsi === 'number' && by.CCC.rsiNotMeasured === null, 'measured from 15');
  const p = ctx.__f.buildPreMarketGroqPrompt(by.AAA);
  assert.ok(p.includes('not measured (5 daily closes came back, 15 needed)') && !/Neutral/.test(/RSI[^\n]*/.exec(p)[0]), /RSI[^\n]*/.exec(p)[0]);
  assert.ok(grab('buildPreMarketDetailPanel').includes("`not measured${m.rsiNotMeasured ? ` (${m.rsiNotMeasured})` : ''}`"), 'the panel says it too');
});

run('a buy with no signal stores null, never a 0 or 5 nobody computed; the card and sold list show "—"', () => {
  for (const l of ['scoreAtBuy:      sig?.score ?? null,', 'rsiAtBuy:        sig?.rsi   ?? null,', 'volRatioAtBuy:   sig?.volRatio ?? null,', 'riskAtBuy:       sig?.risk  ?? null,']) assert.ok(app.includes(l), l);
  assert.ok(!/(score|rsi|volRatio|risk)AtBuy:\s*sig\?\.\w+\s*\|\|/.test(app), 'no `|| <number>` substitute left at buy');
  assert.ok(app.includes("<div class=\"pf-grid-val\">${p.scoreAtBuy ?? '—'} <span"));
  assert.ok(app.includes("Score ${s.scoreAtBuy ?? '—'}/100 · RSI ${s.rsiAtBuy == null ? '—' : s.rsiAtBuy.toFixed(0)}"));
});
