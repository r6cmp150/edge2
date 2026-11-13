// tests/sale-verdict-provenance.test.js — 2026-11-02, db/035, phase-10
// appendix "Decided: the at-sale verdict is not computed; stored ones are
// marked". The stored at-sale verdict was computed at RECORDING time from
// mixed-moment inputs (the buy's RSI, render state, a scan that can postdate
// the sale). From this change: no verdict is computed at sale; the record
// says so (verdict_provenance 'not_recorded', every verdict column an explicit
// null) and carries the last scan signal that PREDATES the sale, or why none
// can be established. The report's verdict sections read only sale_moment
// rows. And an unknown hold length is unknown, never 0.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run, columnValidatorsSrc } = require('./_lib');

const app = readSource('app.js');
const grab = name => {
  const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  assert.ok(i >= 0, name);
  return app.slice(i, app.indexOf('\n}\n', i) + 3);
};
const line = prefix => { const i = app.indexOf(prefix); assert.ok(i >= 0, prefix); return app.slice(i, app.indexOf('\n', i) + 1); };
const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');

// Monday 2026-11-02 10:00 PST.
const NOW = Date.parse('2026-11-02T18:00:00Z');
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const VERDICT_FIELDS = ['unifiedRecommendationAtSale', 'unifiedCompositeAtSale', 'topExitFactorsAtSale', 'topHoldFactorsAtSale',
  'lockInProfitsFired', 'peakRiskScoreAtSale', 'topPeakRiskFactorsAtSale', 'fullUreFactorsAtSale', 'fullPeakRiskFactorsAtSale'];

function saleCtx({ sig = null, ownedPeakRSI = {} } = {}) {
  const ctx = { Date: FakeDate, Math, JSON, Set, Intl, console, String, Number, Object, Array };
  vm.createContext(ctx);
  vm.runInContext(readSource('core/clock.js'), ctx);
  const boom = name => () => { throw new Error(`${name} must not run at sale`); };
  Object.assign(ctx, {
    state: { ownedPeakRSI, settings: {} },
    currentSignalForHolding: () => sig,
    calcUnifiedRecommendation: boom('calcUnifiedRecommendation'), calcPeakRiskScore: boom('calcPeakRiskScore'),
    getEngine: () => ({ evaluateExit: boom('evaluateExit') }), neutralEngineExitFallback: boom('neutralEngineExitFallback'),
  });
  vm.runInContext(line('const VERDICT_PROVENANCE = ') + grab('computeSaleVerdictFields') + grab('signalBeforeSale')
    + '\n;globalThis.__f = computeSaleVerdictFields; globalThis.__s = signalBeforeSale;', ctx);
  return ctx;
}
const plain = o => JSON.parse(JSON.stringify(o));

run('the sale computes NO verdict: provenance not_recorded, every verdict field an explicit null, no engine asked', () => {
  const ctx = saleCtx({ sig: null });
  for (const pos of [{ ticker: 'A', engineSource: 'EDGE', rsiAtBuy: 55 }, { ticker: 'W', engineSource: 'WARRIOR', rsiAtBuy: 70 }, { ticker: 'L', rsiAtBuy: 40 }]) {
    const f = ctx.__f(pos, '2026-11-02'); // the stubs throw if any verdict path runs
    assert.strictEqual(f.verdictProvenance, 'not_recorded', pos.ticker);
    for (const k of VERDICT_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(f, k), `${pos.ticker}: ${k} present`);
      assert.strictEqual(f[k], null, `${pos.ticker}: ${k} is null, never a default (lockInProfitsFired false would be a claim)`);
    }
    assert.strictEqual(f.peakRsiDuringHold, null, `${pos.ticker}: no render saw it -> null, NOT rsiAtBuy (${pos.rsiAtBuy})`);
  }
  assert.strictEqual(saleCtx({ ownedPeakRSI: { A: 71.5 } }).__f({ ticker: 'A', engineSource: 'EDGE', rsiAtBuy: 55 }, '2026-11-02').peakRsiDuringHold, 71.5, 'an observed peak is kept');
  // The provenance set the app knows matches db/035's CHECK, exactly.
  assert.deepStrictEqual([...saleCtx().VERDICT_PROVENANCE ?? vm.runInContext('VERDICT_PROVENANCE', saleCtx())], ['sale_moment', 'mixed_moment', 'not_recorded']);
  const sql = readSource('db/035_trades_v2_verdict_provenance.sql');
  assert.ok(sql.includes("verdict_provenance in ('sale_moment', 'mixed_moment', 'not_recorded')"));
});

run('signal_before_sale: the last scan signal that PREDATES the sale (by PT date), or why none can be established', () => {
  const at = iso => Date.parse(iso);
  const sigAt = (ms, extra = {}) => ({ ticker: 'A', score: 80, signal: 'SOFT BUY', scannedAt: ms, scoringVersion: 2, scoringHash: 'h', ...extra });
  const pos = { ticker: 'A', engineSource: 'EDGE' };
  // Friday 10-30 14:00 PT scan, sale Monday 11-02: predates.
  const r = plain(saleCtx({ sig: sigAt(at('2026-10-30T21:00:00Z')) }).__s(pos, '2026-11-02'));
  assert.strictEqual(r.state, 'PREDATES_SALE');
  assert.strictEqual(r.scanned_at, '2026-10-30T21:00:00.000Z');
  assert.deepStrictEqual([r.scan_date, r.scan_hhmm, r.score, r.label, r.scoring_version, r.scoring_hash], ['2026-10-30', '14:00', 80, 'SOFT BUY', 2, 'h']);
  assert.strictEqual(r.signal.score, 80, 'the signal itself is kept');
  // Same day, the sale's time not known: it can't be placed before the fill.
  for (const iso of ['2026-11-02T14:00:00Z', '2026-11-02T23:59:00Z']) {
    const s = saleCtx({ sig: sigAt(at(iso)) }).__s(pos, '2026-11-02');
    assert.strictEqual(s.state, 'NOT_ESTABLISHED', iso);
    assert.ok(/is not before the sale date 2026-11-02; the sale's time isn't known/.test(s.reason), s.reason);
  }
  // Same day, the fill known: the scan's own instant places it, either way.
  const same = sigAt(at('2026-11-02T15:00:00Z'));
  assert.strictEqual(saleCtx({ sig: same }).__s(pos, '2026-11-02', at('2026-11-02T16:00:00Z')).state, 'PREDATES_SALE', 'scanned before the fill');
  const after = saleCtx({ sig: same }).__s(pos, '2026-11-02', at('2026-11-02T14:00:00Z'));
  assert.strictEqual(after.state, 'NOT_ESTABLISHED', 'scanned after the fill');
  assert.ok(after.reason.includes("is not before the sale's fill"), after.reason);
  assert.strictEqual(saleCtx({ sig: same }).__s(pos, '2026-11-02', at('2026-11-02T15:00:00Z')).state, 'NOT_ESTABLISHED', 'the same instant is not before');
  // A scan AFTER the sale (recorded late): never stored as the sale's signal.
  const late = saleCtx({ sig: sigAt(at('2026-11-03T15:00:00Z')) }).__s(pos, '2026-10-30');
  assert.strictEqual(late.state, 'NOT_ESTABLISHED');
  assert.ok(late.reason.includes('2026-11-03') && late.reason.includes('earlier scans aren\'t kept'));
  const reasonOf = (sig, p = pos, d = '2026-11-02') => saleCtx({ sig }).__s(p, d).reason;
  assert.strictEqual(reasonOf(null), 'no scan has scored this ticker');
  assert.ok(/not evaluated \(v1\)/.test(reasonOf({ score: null, notEvaluatedReason: 'v1' })));
  assert.strictEqual(reasonOf(sigAt(null)), 'the retained scan has no recorded scan time');
  assert.ok(/not an EDGE position/.test(reasonOf(sigAt(at('2026-10-30T21:00:00Z')), { ticker: 'W', engineSource: 'WARRIOR' })));
  assert.strictEqual(reasonOf(sigAt(at('2026-10-30T21:00:00Z')), pos, 'x'), 'the sale date is not a date');
  // Every result satisfies db/035's shape CHECK.
  for (const v of [r, late]) {
    assert.ok(v.state === 'PREDATES_SALE' ? typeof v.scanned_at === 'string' : v.state === 'NOT_ESTABLISHED' && typeof v.reason === 'string');
  }
});

run('the sale write sends verdict_provenance and signal_before_sale, and the verdict columns as the record holds them (null)', async () => {
  let inserted = null;
  const ctx = {
    console, Math, JSON, Date, Number, String,
    scoreLabel: () => 'WATCH', currentCodeVersion: () => ({ app: 'x', scoring: 2 }), persist() {},
    // CHANGED 2026-11-12, declared: the scan price history adds hooks these functions now call; stubbed here, held by tests/scan-history.test.js.
    invalidateSessionRead() {},
    noteSaleWrite: (p, outcome) => outcome,
    supabaseClient: { from: () => ({ insert: rows => { inserted = rows[0]; return { select: async () => ({ data: [{ id: 1 }], error: null }) }; } }) },
  };
  vm.createContext(ctx);
  // CHANGED 2026-11-12, declared: the sale row also carries db/042's mode, through saleModeColumns.
  // CHANGED 2026-11-12, declared (carve of (c)): the writers call core/store.js's column validators; loaded here for real (tests/_lib.js columnValidatorsSrc), never stubbed.
  vm.runInContext(columnValidatorsSrc() + '\n' + grab('saleVerdictProvenance') + grab('saleModeColumns') + grab('writeTradeToSupabase') + '\n;globalThis.__w = writeTradeToSupabase;', ctx);
  const f = saleCtx({ sig: null }).__f({ ticker: 'A', engineSource: 'EDGE' }, '2026-11-02');
  const record = { ...plain(f), sellTime: '10:00', sellDayOfWeek: 'Monday', source: 'Own Decision' };
  const outcome = await ctx.__w({ ticker: 'A', buyDate: '2026-10-30', shares: 1, buyPrice: 1, id: 'p1' }, record, '2026-11-02', 1.1, 0.1, 10);
  assert.strictEqual(outcome, 'WRITTEN');
  assert.strictEqual(inserted.verdict_provenance, 'not_recorded');
  assert.deepStrictEqual(inserted.signal_before_sale, { state: 'NOT_ESTABLISHED', reason: 'no scan has scored this ticker' });
  for (const col of ['unified_recommendation_at_sale', 'unified_composite_at_sale', 'top_exit_factors_at_sale', 'top_hold_factors_at_sale',
    'lock_in_profits_fired', 'peak_risk_score_at_sale', 'top_peak_risk_factors_at_sale', 'full_ure_factors_at_sale', 'full_peak_risk_factors_at_sale']) {
    assert.ok(Object.prototype.hasOwnProperty.call(inserted, col), `${col} sent`);
    assert.strictEqual(inserted[col], null, `${col} sent as null, so the column default (lock_in false) can't fill it`);
  }
  // db/035's other CHECK: not_recorded <=> no label.
  assert.strictEqual(inserted.verdict_provenance === 'not_recorded', inserted.unified_recommendation_at_sale == null);

  // A record an OLDER build made, retried now (saleWriteFailures): it names
  // neither column. Classified by db/036's rule, so the retry still inserts
  // once both columns are NOT NULL, instead of losing the trade.
  const oldWithVerdict = { sellTime: '10:00', sellDayOfWeek: 'Friday', source: 'App Signal', unifiedRecommendationAtSale: 'HOLD STRONG', lockInProfitsFired: false };
  await ctx.__w({ ticker: 'B', buyDate: '2026-10-28', shares: 1, buyPrice: 1, id: 'p2' }, oldWithVerdict, '2026-10-30', 1, 0, 0);
  assert.strictEqual(inserted.verdict_provenance, 'mixed_moment');
  assert.deepStrictEqual(plain(inserted.signal_before_sale), { state: 'NOT_RECORDED', reason: 'recorded by a build before db/035' });
  assert.strictEqual(inserted.lock_in_profits_fired, false, 'a mixed-moment row keeps the value its verdict computed');
  const oldNoVerdict = { sellTime: '10:00', sellDayOfWeek: 'Friday', source: 'App Signal', unifiedRecommendationAtSale: null, lockInProfitsFired: false };
  await ctx.__w({ ticker: 'C', buyDate: '2026-10-28', shares: 1, buyPrice: 1, id: 'p3' }, oldNoVerdict, '2026-10-30', 1, 0, 0);
  assert.strictEqual(inserted.verdict_provenance, 'not_recorded');
  assert.strictEqual(inserted.lock_in_profits_fired, null, 'no verdict: a stored false would be a claim (db/035 CHECK)');
});

run("db/035 touches no other table's write-once trigger, and its states are values", () => {
  const sql = readSource('db/035_trades_v2_verdict_provenance.sql');
  const code = sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  assert.ok(!/create\s+or\s+replace\s+function/i.test(code), 'plain CREATE FUNCTION: an existing name errors and rolls back instead of being rewritten');
  const fns = [...code.matchAll(/create\s+function\s+(\w+)/gi)].map(m => m[1]);
  assert.deepStrictEqual(fns, ['trades_v2_reject_provenance_change'], 'one new, trades_v2-only function');
  assert.ok(!/reject_code_version_change/.test(code), 'the shared db/028 function is not referenced, let alone replaced');
  assert.ok(!/\b(portfolio|signal_log|scan_runs|signal_snapshot_at_buy)\b/.test(code), 'no other table is named in executable SQL');
  assert.ok(/state' in \('NOT_ESTABLISHED', 'NOT_RECORDED'\)/.test(code), 'three signal states, NOT_RECORDED a value');
  assert.ok(code.includes(`set signal_before_sale = '{"state":"NOT_RECORDED","reason":"predates db/035"}'::jsonb`));
  assert.ok(/set lock_in_profits_fired = null\s+where verdict_provenance = 'not_recorded'/.test(code));
  assert.ok(code.includes("and (verdict_provenance <> 'not_recorded' or lock_in_profits_fired is null)"));
  // The backfills come before the trigger exists (NULL -> value is allowed anyway).
  assert.ok(code.indexOf('update trades_v2') < code.indexOf('create trigger'));
});

run('read back, three states survive: null stays null (no !! or || [] collapse), provenance carried', () => {
  const ctx = { console, Math, JSON, Date, holdSpan: () => ({ closes: 1, basis: 'fill' }), marketDaysLabel: String };
  vm.createContext(ctx);
  vm.runInContext(grab('mapTradesV2ToSoldShape') + '\n;globalThis.__m = mapTradesV2ToSoldShape;', ctx);
  const m = ctx.__m({ id: 1, ticker: 'A', buy_date: '2026-10-30', sell_date: '2026-11-02', verdict_provenance: 'not_recorded',
    lock_in_profits_fired: null, top_exit_factors_at_sale: null, top_hold_factors_at_sale: null, top_peak_risk_factors_at_sale: null,
    full_ure_factors_at_sale: null, signal_before_sale: { state: 'NOT_ESTABLISHED', reason: 'r' } });
  for (const k of ['lockInProfitsFired', 'topExitFactorsAtSale', 'topHoldFactorsAtSale', 'topPeakRiskFactorsAtSale', 'fullUreFactorsAtSale']) {
    assert.strictEqual(m[k], null, `${k}: not recorded reads back as null`);
  }
  assert.strictEqual(m.verdictProvenance, 'not_recorded');
  assert.deepStrictEqual(plain(m.signalBeforeSale), { state: 'NOT_ESTABLISHED', reason: 'r' });
  const old = ctx.__m({ id: 2, ticker: 'B', buy_date: '2026-10-01', sell_date: '2026-10-02', lock_in_profits_fired: true, verdict_provenance: 'mixed_moment' });
  assert.strictEqual(old.lockInProfitsFired, true);
  assert.strictEqual(ctx.__m({ id: 3, ticker: 'C', buy_date: '2026-10-01', sell_date: '2026-10-02', lock_in_profits_fired: false }).lockInProfitsFired, false, 'a real false stays false');
});

// ── The report: gated on sale_moment ───────────────────────────────────
function reportCtx() {
  const ctx = { console, Math, JSON, Date, Number, String, Object, Array, Promise, fetchNextDayClose: async () => null };
  vm.createContext(ctx);
  vm.runInContext(grab('saleMomentVerdicts') + grab('verdictGateNote') + grab('buildWinnerExitTimingSection') + grab('buildUreFactorAccuracySection')
    + '\n;globalThis.__x = buildWinnerExitTimingSection; globalThis.__u = buildUreFactorAccuracySection; globalThis.__g = saleMomentVerdicts;', ctx);
  return ctx;
}
const trade = (prov, label, pnlPct, extra = {}) => ({ verdictProvenance: prov, unifiedRecommendationAtSale: label, lockInProfitsFired: label === 'LOCK IN PROFITS',
  pnlPct, buyPrice: 10, peakPrice: 12, peakRsiDuringHold: 80, sellDate: '2026-10-30', ticker: 'T', sellPrice: 10,
  fullUreFactorsAtSale: [{ name: 'RSI declining from peak (92 → 92)', points: -30 }], topPeakRiskFactorsAtSale: ['RSI declining from peak (92 → 92)'], ...extra });

run('WINNER EXIT TIMING: mixed-moment verdicts are excluded and counted; sale-moment ones are used; peak-RSI blocks left out with the reason', async () => {
  const ctx = reportCtx();
  const mixed = [trade('mixed_moment', 'LOCK IN PROFITS', 5), trade('mixed_moment', 'HOLD STRONG', -2), trade(null, 'HOLD STRONG', 3), trade('not_recorded', null, 1)];
  const out = await ctx.__x(mixed);
  assert.ok(out.includes('Trades where LOCK IN PROFITS was showing at time of sale:\n  No qualifying trades. 3 recorded verdicts excluded: computed from mixed-moment inputs'), out);
  assert.ok(out.includes('Trades where HOLD STRONG was showing at time of sale:\n  No qualifying trades.'));
  assert.ok(out.includes('Most common peak risk factors at time of LOCK IN PROFITS exits:\n  No qualifying trades.'));
  assert.ok(!out.includes('RSI declining from peak (92 → 92)'), 'no mixed-moment factor reaches the report');
  assert.ok(out.includes('Not shown. peak_rsi_during_hold is the highest RSI the Portfolio tab'), 'the peak-RSI blocks are left out, and say why');
  assert.ok(!/Peak RSI <65 during hold|held PAST a LOCK IN PROFITS signal:\n  \(approximated/.test(out));
  // The gate opens by itself once sale-moment rows exist.
  const open = await ctx.__x([...mixed, trade('sale_moment', 'LOCK IN PROFITS', 6, { topPeakRiskFactorsAtSale: ['Clean factor'] })]);
  assert.ok(/LOCK IN PROFITS was showing at time of sale:\n  Total: 1 \| win rate 100%/.test(open), open);
  assert.ok(open.includes('1. Clean factor: fired in 1 of 1 LOCK IN PROFITS exits'));
  assert.ok(open.includes('Not shown. peak_rsi_during_hold'), 'still left out: the gate on provenance alone does not clear render dependence');
});

run('URE FACTOR ACCURACY: gated hardest; says so with the count instead of vanishing', () => {
  const ctx = reportCtx();
  const mixed = Array.from({ length: 30 }, (_, i) => trade('mixed_moment', 'HOLD', i % 2 ? 3 : -3));
  const out = ctx.__u(mixed);
  assert.ok(out.includes('=== URE FACTOR ACCURACY ===\nNo qualifying trades (0 of the 10 needed). 30 recorded verdicts excluded'), out);
  const clean = Array.from({ length: 10 }, (_, i) => trade('sale_moment', 'HOLD', i % 2 ? 3 : -3, { fullUreFactorsAtSale: [{ name: 'Clean', points: 5 }] }));
  const opened = ctx.__u([...mixed, ...clean]);
  assert.ok(!opened.includes('No qualifying trades') && opened.includes('Clean'), 'ten sale-moment rows open it');
  assert.ok(!opened.includes('RSI declining from peak'), 'and only they are counted');
});

run('generateClaudeReport: both in-report verdict readers go through the gate', () => {
  const g = grab('generateClaudeReport');
  assert.ok(g.includes('saleMomentVerdicts(sold).forEach(s => {'), 'recommendation-at-sale counts');
  assert.ok(g.includes("const withUnified = saleMomentVerdicts(sold).filter(s => s.unifiedRecommendationAtSale);"), 'UNIFIED RECOMMENDATION AT TIME OF SALE');
  const code = g.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/sold\.(?:filter|forEach)\(s => !?s\.(?:unifiedRecommendationAtSale|lockInProfitsFired|fullUreFactorsAtSale|topExitFactorsAtSale|peakRsiDuringHold)/.test(code), 'no ungated read of a verdict field over all sales');
});

// ── An unknown hold length is unknown, never 0 ─────────────────────────
run('marketClosesHeld / holdSpan: a start date that is not a date gives null closes, never 0 ("same day")', () => {
  const ctx = { Date, Math, JSON, Set, Intl, console, state: { settings: {} } };
  vm.createContext(ctx);
  vm.runInContext(readSource('core/clock.js'), ctx);
  assert.strictEqual(ctx.marketClosesHeld('2026-10-30', '2026-11-02'), 1, 'valid: unchanged');
  assert.strictEqual(ctx.marketClosesHeld('2026-11-02', '2026-11-02'), 0, 'a real 0');
  for (const bad of ['x', '', null, undefined, '2026-02-30']) {
    assert.strictEqual(ctx.marketClosesHeld(bad, '2026-11-02'), null, `start ${JSON.stringify(bad)}`);
    assert.strictEqual(ctx.marketClosesHeld('2026-10-30', bad), null, `end ${JSON.stringify(bad)}`);
  }
  const h = ctx.holdSpan({ filledAt: 'garbage', buyDate: '2026-10-30', orderType: 'market' }, '2026-11-02');
  assert.ok(h.startDate === null && h.closes === null, JSON.stringify(h));
  assert.strictEqual(ctx.holdSpan({ buyDate: 'nope' }, '2026-11-02').closes, null);
  assert.strictEqual(ctx.holdSpan({ filledAt: '2026-10-30T16:00:00Z', buyDate: '2026-10-30' }, '2026-11-02').closes, 1);
});

run('the exit verdict on an unknown hold: "not evaluated", never +20 "within window" and +10 "early"', () => {
  const ctx = { Date: FakeDate, Math, JSON, Set, Intl, console, Number, String, Object, Array };
  vm.createContext(ctx);
  vm.runInContext(readSource('core/clock.js'), ctx);
  vm.runInContext(strip(readSource('core/edge-scoring.js')), ctx);
  Object.assign(ctx, { state: { settings: {} }, calcPeakRiskScore: () => ({ score: 0, factors: [], topFactors: [] }) });
  vm.runInContext([line('const MAX_HOLD_DAYS = '), line('const DEFAULT_MAX_LOSS_PCT = '), line('const MACRO_TAILWIND_CONDITIONS = '), line('const DURATION_WINDOW_LABEL = '),
    grab('calcUnifiedRecommendation')].join('\n') + '\n;globalThis.__ur = calcUnifiedRecommendation;', ctx);
  const pos = d => ({ ticker: 'A', buyPrice: 10, currentPrice: 10.2, stop: 8, target: 13, duration: 'WEEK', buyDate: d, rsi: 50, scoreAtBuy: 70 });
  const names = r => r.factors.map(f => f.name);
  const known = ctx.__ur(pos('2026-10-30'), null, null);
  assert.ok(names(known).some(n => /^Within intended/.test(n)) && names(known).includes('Early in hold window'), 'a known hold still scores the window');
  const unknown = ctx.__ur(pos('not-a-date'), null, null);
  assert.ok(names(unknown).includes('Hold length not evaluated — the start date is not a date'), JSON.stringify(names(unknown)));
  assert.ok(!names(unknown).some(n => /intended .* window|Early in hold window|past intended hold window/i.test(n)), JSON.stringify(names(unknown)));
  assert.strictEqual(unknown.factors.find(f => /not evaluated/.test(f.name)).points, 0);
});

run('the other hold readers: the default sort key, the stale-order check, the notification, the report average', () => {
  // isStalePendingOrder: unknown age asks Roman (stale), never "fresh".
  const ctx = { Date, Math, JSON, Set, Intl, console, state: { settings: {}, portfolio: [] } };
  vm.createContext(ctx);
  vm.runInContext(readSource('core/clock.js') + '\n' + readSource('core/orders.js'), ctx);
  assert.strictEqual(ctx.isStalePendingOrder({ orderType: 'limit', filledAt: null, buyDate: 'nope' }), true, 'unknown age -> stale (ask)');
  assert.strictEqual(ctx.isStalePendingOrder({ orderType: 'limit', filledAt: null, buyDate: ctx.ptDateStr(ctx.getPT()) }), false, 'placed today -> not stale');
  assert.strictEqual(ctx.isStalePendingOrder({ orderType: null, filledAt: null, buyDate: 'nope' }), false, 'a holding is never a stale order');
  // The default sort key and the notification guard (source: both live inside larger functions).
  const tab = grab('renderPortfolioTab');
  assert.ok(tab.includes('if (daysHeld == null) return null; // unknown hold: the unknown bucket, never null/n = 0'));
  assert.ok(tab.includes('Hold length unknown · ${durLabel}'), 'the card says so');
  assert.ok(app.includes('if (daysHeld != null && daysHeld > threshold && !isDuplicateAlert(ticker, \'TIME_LIMIT\')) {'));
  const appCode = app.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/daysHeld\s*\|\|\s*0/.test(appCode), 'no average counts an unknown hold as 0');
  assert.ok(!/maxDays - daysHeld\)/.test(app.replace('daysHeld == null ? null : Math.max(1, maxDays - daysHeld)', '')), 'the AI prompt never computes a window from an unknown hold');
});
