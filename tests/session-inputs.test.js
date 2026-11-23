// tests/session-inputs.test.js -- 2026-11-23 (the reviewer: "build the coherent fix ... it changes once, deliberately,
// never in instalments"). core/market-data.js sessionInputs decides the price, the previous close and today's volume
// together from the daily bar's age. Each value has a source or is null with a reason; nothing is 0 or a substitute.
// Then scoring version 3 against version 2: IDENTICAL whenever every session input is measured, and different only in
// the declared way when one is not.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { execSync } = require('child_process');
const { run, readSource, REPO_ROOT } = require('./_lib');

const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');
const LEGACY = '\n;getLivePrice = function (snap) { if (!snap) return 0; return snap.dailyBar?.c || snap.latestTrade?.p || 0; };';
function context(scoringSrc) {
  const c = { console, Math, Date, JSON, Number, String, Array, Object, Infinity, NaN, isFinite, Intl, state: { settings: {}, macroContext: null } };
  vm.createContext(c);
  for (const f of ['core/indicators.js', 'core/clock.js', 'core/market-data.js']) vm.runInContext(strip(readSource(f)), c);
  if (scoringSrc && !/sessionInputs\(/.test(scoringSrc)) vm.runInContext(LEGACY, c);
  if (scoringSrc) vm.runInContext(strip(scoringSrc) + '\n;globalThis.__s = scoreStock;', c);
  vm.runInContext('globalThis.__si = sessionInputs; globalThis.__glp = getLivePrice; globalThis.__pt = ptDateTimeOf;', c);
  return c;
}
const C = context(null);
// Wednesday 2026-11-04 08:00 PST (regular session) and 05:00 PST (before the open)
const WED_0800 = Date.parse('2026-11-04T16:00:00Z'), WED_0500 = Date.parse('2026-11-04T13:00:00Z');
const bar = (date, c, v = 1000) => ({ t: `${date}T05:00:00Z`, c, v });
const trade = (iso, p) => ({ t: iso, p });

run('the current session\'s bar: price is the latest trade, prevClose the previous bar, volume the bar\'s', () => {
  const r = C.__si({ dailyBar: bar('2026-11-04', 10, 5000), prevDailyBar: bar('2026-11-03', 9.5), latestTrade: trade('2026-11-04T15:59:00Z', 10.2) }, WED_0800);
  assert.deepStrictEqual([r.price.value, r.price.source, r.prevClose.value, r.volume.value, r.dailyBarAgeTradingDays], [10.2, 'latestTrade', 9.5, 5000, 0]);
  assert.ok(Math.abs(r.todayChange.value - (10.2 - 9.5) / 9.5 * 100) < 1e-9);
});

run('the PREVIOUS session\'s bar (before the open): prevClose is that bar\'s close, volume NOT measured, a premarket trade gives the change', () => {
  const snap = { dailyBar: bar('2026-11-03', 10, 5000), prevDailyBar: bar('2026-11-02', 8), latestTrade: trade('2026-11-04T12:30:00Z', 10.5) };
  const r = C.__si(snap, WED_0500);
  assert.strictEqual(r.prevClose.value, 10, 'the bar\'s own close, not prevDailyBar (two sessions back)');
  assert.strictEqual(r.volume.value, null); assert.ok(/no daily bar for today on the feed yet/.test(r.volume.reason), r.volume.reason);
  assert.ok(Math.abs(r.todayChange.value - 5) < 1e-9, '10.5 against 10, not against 8');
});

run('the previous session\'s bar and no trade today: the change is NOT measured, never 0', () => {
  const r = C.__si({ dailyBar: bar('2026-11-03', 10), prevDailyBar: bar('2026-11-02', 8), latestTrade: trade('2026-11-03T20:59:00Z', 10) }, WED_0800);
  assert.strictEqual(r.price.value, 10, 'the price is still shown, with its date');
  assert.strictEqual(r.todayChange.value, null); assert.strictEqual(r.todayChange.reason, 'no trade on the feed yet today');
});

run('IPST\'s shape: a bar two sessions old: prevClose and volume not measured; the price is the latest trade', () => {
  const r = C.__si({ dailyBar: bar('2026-11-02', 2.665), prevDailyBar: bar('2026-10-30', 2.41), latestTrade: trade('2026-11-04T16:01:00Z', 2.08) }, WED_0800);
  assert.strictEqual(r.price.value, 2.08, 'not the stale 2.665');
  assert.strictEqual(r.prevClose.value, null); assert.ok(/2 trading days old/.test(r.prevClose.reason));
  assert.strictEqual(r.volume.value, null); assert.strictEqual(r.todayChange.value, null);
});

run('no daily bar, an undated one, or nothing at all: said, not substituted; getLivePrice is null, never 0', () => {
  const noBar = C.__si({ latestTrade: trade('2026-11-04T15:00:00Z', 7) }, WED_0800);
  assert.deepStrictEqual([noBar.price.value, noBar.prevClose.value, noBar.volume.value, noBar.todayChange.value], [7, null, null, null]);
  const undated = C.__si({ dailyBar: { c: 7, v: 10 }, prevDailyBar: { c: 6 } }, WED_0800);
  assert.strictEqual(undated.prevClose.value, null); assert.ok(/date is not known/.test(undated.prevClose.reason));
  assert.strictEqual(C.__glp(undefined), null); assert.strictEqual(C.__glp({}), null);
  assert.strictEqual(C.__glp({ dailyBar: { c: 4 }, latestTrade: { p: 0, t: '2026-11-04T15:00:00Z' } }), 4, 'a zero trade is no trade');
  const noPrev = C.__si({ dailyBar: bar('2026-11-04', 10), latestTrade: trade('2026-11-04T15:59:00Z', 10) }, WED_0800);
  assert.strictEqual(noPrev.prevClose.value, null, 'path (a): no previous bar is not the price itself');
  const noVol = C.__si({ dailyBar: { t: '2026-11-04T05:00:00Z', c: 10 }, prevDailyBar: bar('2026-11-03', 9), latestTrade: trade('2026-11-04T15:59:00Z', 10) }, WED_0800);
  assert.strictEqual(noVol.volume.value, null, 'path (b): no volume is not 0');
});

// Version 3 against version 2, on generated inputs, run NOW (the scorer reads the clock): a bar dated today is the
// current session's on any day, so every input is measured.
const V2 = context(execSync('git show 840e819:core/edge-scoring.js', { cwd: REPO_ROOT, maxBuffer: 1e8 }).toString());
const V3 = context(readSource('core/edge-scoring.js'));
const NEW_KEYS = ['priceSource', 'priceAsOf', 'prevCloseNotMeasured', 'volumeNotMeasured', 'volRatioNotMeasured', 'todayChangeNotMeasured'];
function gen(i) {
  let seed = 7919 * (i + 1); const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const len = 20 + Math.floor(rnd() * 80); let p = 1 + rnd() * 20; const bars = [];
  for (let k = 0; k < len; k++) { const o = p; p = Math.max(0.1, p * (1 + (rnd() - 0.5) * 0.1)); bars.push({ t: new Date(Date.UTC(2026, 5, 1) + k * 864e5).toISOString(), o, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99, c: p, v: Math.floor(1e5 + rnd() * 1e6) }); }
  const today = V3.__pt(Date.now()).date, price = p * (1 + (rnd() - 0.5) * 0.1);
  return { bars, today, price, prev: bars[len - 1].c, vol: Math.floor(rnd() * 3e6), spy: (rnd() - 0.5) * 4 };
}

run('version 3 is IDENTICAL to version 2 whenever every session input is measured (500 generated stocks)', () => {
  for (let i = 0; i < 500; i++) {
    const g = gen(i);
    const snap = { dailyBar: { t: `${g.today}T05:00:00Z`, c: g.price, v: g.vol }, prevDailyBar: { c: g.prev }, latestTrade: { t: new Date().toISOString(), p: g.price } };
    const a = V2.__s('T' + i, snap, g.bars, null, g.spy, 'OTHER'), b = V3.__s('T' + i, snap, g.bars, null, g.spy, 'OTHER');
    const strip3 = o => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !NEW_KEYS.includes(k))));
    assert.strictEqual(strip3(b), JSON.stringify(a), `T${i}: version 3 differs from version 2 on fully measured inputs`);
  }
});

run('when an input is NOT measured, version 3 differs in the declared way: no volume or momentum points, never the top', () => {
  const g = gen(1);
  // the version-2 shape of path (c): a bar whose volume makes volRatio 1 by substitution (avgVol10 0)
  const zeroBars = g.bars.map(b => ({ ...b, v: 0 }));
  const snap = { dailyBar: { t: `${g.today}T05:00:00Z`, c: g.price, v: 0 }, prevDailyBar: { c: g.prev }, latestTrade: { t: new Date().toISOString(), p: g.price } };
  const a = V2.__s('Z', snap, zeroBars, null, g.spy, 'OTHER'), b = V3.__s('Z', snap, zeroBars, null, g.spy, 'OTHER');
  assert.strictEqual(a.volRatio, 1, 'version 2 substituted 1');
  assert.strictEqual(b.volRatio, null); assert.ok(/10-day average/.test(b.volRatioNotMeasured));
  // no previous close: version 2 made todayChange exactly 0; version 3 says not measured
  const noPrev = { ...snap, dailyBar: { ...snap.dailyBar, v: 5000 }, prevDailyBar: undefined };
  const a2 = V2.__s('P', noPrev, g.bars, null, g.spy, 'OTHER'), b2 = V3.__s('P', noPrev, g.bars, null, g.spy, 'OTHER');
  assert.strictEqual(a2.todayChange, 0); assert.strictEqual(b2.todayChange, null); assert.strictEqual(b2.rsVsSPY, null);
  // a missing SPY change: no relative strength, rather than the stock's own change standing in for it
  const b3 = V3.__s('S', { ...snap, dailyBar: { ...snap.dailyBar, v: 5000 } }, g.bars, null, null, 'OTHER');
  assert.strictEqual(b3.rsVsSPY, null); assert.strictEqual(b3.relStrengthPts, 0);
});

run('the components: a null volRatio, todayChange or rsVsSPY earns 0 and names no volume bucket', () => {
  const c = context(readSource('core/edge-scoring.js'));
  vm.runInContext('globalThis.__sc = scoreComponents; globalThis.__rs = relStrengthPoints;', c);
  const x = c.__sc({ volRatio: null, todayChange: null, rsi: 60, price: 20, ma20: 10, volBuild: false, meanReversion: false, catalystSetup: false, consUpDays: 0, rsVsSPY: null });
  assert.deepStrictEqual([x.volPts, x.volBucket, x.momPts, x.relStrengthPts], [0, null, 0, 0]);
  assert.strictEqual(c.__rs(null), 0);
});

run('the readers: SPY\'s change, the exit factor, the premarket movers and universe actives read the session, not prevDailyBar', () => {
  const app = readSource('app.js');
  assert.ok(app.includes('if (spy) spyChangePct = sessionInputs(spy).todayChange.value;'));
  assert.ok(app.includes('const sessionChange = snap ? sessionInputs(snap).todayChange.value : null;'));
  assert.ok(app.includes('    const prevClose = sessionInputs(snap).prevClose.value;'));
  assert.ok(!/prevDailyBar\?\.c \|\| (spyP|price|0)/.test(app), 'no prevDailyBar fallback to a price or 0 is left in app.js');
  assert.ok(readSource('core/universe.js').includes('changePct: inputs?.todayChange.value ?? null,'));
  assert.ok(readSource('scripts/log-signals-edge.mjs').includes('if (spy) spyChangePct = global.sessionInputs(spy).todayChange.value;'));
  assert.ok(readSource('scripts/log-signals-edge.mjs').includes('const signalRows = scoredAll.filter(r => global.getLivePrice(snapshots[r.ticker]) != null).map(r => ({'), 'an unpriced row is not written');
});
