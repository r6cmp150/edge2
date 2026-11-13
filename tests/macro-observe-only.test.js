// tests/macro-observe-only.test.js — 2026-11-02, db/038. The macro condition
// is OBSERVE-ONLY: fetched every scan, shown, recorded, and it affects
// nothing (not the score, not the display cut, not what's shown). Scoring
// stays v2 with its hash unmoved, so the overlay branch is still INSIDE
// scoreStock; it must be unreachable by construction:
//   - the setting is pinned true at every place settings are made (the
//     defaults, the Supabase load, the logger), and nothing can unpin it;
//   - no non-zero macro adjustment ever reaches a score;
//   - the display cut is the base line for every condition and category.
// Plus the inputs (a missing quote is missing, never 0%), the Groq rule
// (daily + on a pattern change, temperature 0, everything recorded), and
// the banner (always shown, both answers when they disagree).
//
// WHY THE PREVENT-AND-OBSERVE TESTS AT THE END EXIST, AND MUST NOT BE REMOVED AS REDUNDANT (2026-11-12, the reviewer):
// the pre-registered sign-test (scripts/run-macro-sign-test.mjs) measures whether the macro reading predicts the
// market WHILE THE READING AFFECTS NOTHING. That is its independent variable. If the reading began affecting scores,
// the scan's cut or the logger's tiers part-way through its 20 labelled days (one edit to core/edge-scoring.js is
// enough), the recommendations and the outcomes would change, and the test would be measuring something other than
// what it was registered to measure, with nothing to say when it changed: contaminated data that looks fine. The
// switch tests above did not hold this. Mutants that applied the reading while leaving the switch alone survived them,
// because the reported adjustment and the applied one happen to be the same variable today. Observe-only was true by
// accident of implementation, not by construction. A measurement that depends on something staying fixed holds that
// thing fixed by test, not by intention.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run, columnValidatorsSrc } = require('./_lib');

const app = readSource('app.js');
const grab = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
const grabConst = name => {
  const i = app.search(new RegExp(`^const ${name} = `, 'm')); assert.ok(i >= 0, name);
  const lineEnd = app.indexOf('\n', i);
  const first = app.slice(i, lineEnd);
  if (/[[{]\s*$/.test(first)) { const close = app.slice(lineEnd).search(/\n[\]}];/); return app.slice(i, lineEnd + close + 3); }
  return first;
};

// The scorer and the app's macro code, in one context.
function ctx(over = {}) {
  const c = {
    console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Object, Array, String, Number, Promise, RegExp, Error, Set, Infinity, NaN, isFinite,
    state: { settings: { disableMacroOverlay: true, groqKey: 'k' }, selectedUniverse: 'TECH', macroGroqLast: null },
    persisted: [], inserted: [],
    ...over,
  };
  c.persist = k => c.persisted.push(k);
  c.currentCodeVersion = () => ({ app: 't', scoring: 2 });
  vm.createContext(c);
  vm.runInContext(readSource('core/clock.js'), c); // scanFreshness and the session calendar, for real
  c.getPT = d => d; c.ptDateStr = d => new Date(d).toISOString().slice(0, 10);
  const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');
  for (const f of ['core/indicators.js', 'core/market-data.js', 'core/edge-scoring.js']) vm.runInContext(strip(readSource(f)), c);
  // CHANGED 2026-11-12, declared (carve of (c)): the writers call core/store.js's column validators; loaded here for real (tests/_lib.js columnValidatorsSrc), never stubbed.
  vm.runInContext([
    columnValidatorsSrc(),
    grabConst('GROQ_MODEL'), grabConst('MACRO_ETFS'), grabConst('MACRO_OVERLAY_PINNED_OFF'), grabConst('MACRO_OVERLAY_SOURCE'), grabConst('MACRO_CONDITIONS'),
    grabConst('MACRO_REQUIRED_ETFS'), grabConst('MACRO_GROQ_TEMPERATURE'), grabConst('MACRO_HEADLINE_HOURS'), grabConst('MACRO_HEADLINE_LIMIT'), grabConst('fmtMove'),
    grabConst('BASE_SCORE_THRESHOLD'), grabConst('ELEVATED_SCORE_THRESHOLD'), grabConst('SECTOR_WEAKNESS_THRESHOLD_CATEGORIES'), grabConst('BROAD_ELEVATED_CONDITIONS'),
    grabConst('MACRO_INTERPRETATIONS'),
    ...['classifyMacroCondition', 'getDisplayThreshold', 'wouldBeDisplayThreshold', 'macroMovesFromSnapshots', 'macroBarState', 'decideMacroPath', 'macroGroqAskReason',
      'fetchMacroHeadlines', 'buildMacroGroqPrompt', 'askMacroGroq', 'macroWouldAdjust', 'observeMacro', 'macroBannerAge', 'buildMacroBanner'].map(grab),
    ';Object.assign(globalThis, { classifyMacroCondition, getDisplayThreshold, wouldBeDisplayThreshold, macroMovesFromSnapshots, macroBarState, decideMacroPath, macroGroqAskReason, observeMacro, buildMacroBanner, MACRO_OVERLAY_PINNED_OFF, MACRO_CONDITIONS, BASE_SCORE_THRESHOLD });',
  ].join('\n'), c);
  return c;
}
const CATEGORIES = ['HEALTHCARE', 'ENERGY', 'TECH', 'RETAIL', 'FINANCIAL', 'INDUSTRIAL', 'REAL_ESTATE', 'CONSUMER', 'OTHER'];

run('the pin is true, and every place settings are made pins it: defaults, Supabase load, logger', () => {
  const c = ctx();
  assert.strictEqual(c.MACRO_OVERLAY_PINNED_OFF, true);
  const ls = app.slice(app.indexOf('state.settings = Object.assign({'), app.indexOf('state.settingsSource = Object.fromEntries'));
  assert.ok(/\n  state\.settings\.disableMacroOverlay = MACRO_OVERLAY_PINNED_OFF;\n/.test(ls), 'loadState pins it AFTER the defaults are merged');
  assert.ok(!/disableMacroOverlay:\s*false/.test(ls), 'no fail-open default in the defaults object');
  // nothing assigns it anything but the pin, and no control writes it
  const assigns = [...app.matchAll(/settings\.disableMacroOverlay\s*=(?!=)\s*([^;\n]+)/g)].map(m => m[1].trim());
  assert.deepStrictEqual(assigns, ['MACRO_OVERLAY_PINNED_OFF'], `assignments: ${assigns.join(' | ')}`);
  assert.ok(!/savePref\('disableMacroOverlay'/.test(app) && !/id="set-disable-macro"/.test(app), 'the toggle is gone');
  const store = readSource('core/store.js');
  assert.ok(!/disableMacroOverlay\s*:/.test(store.slice(store.indexOf('async function loadSettingsFromSupabase'), store.indexOf('async function saveSettingsToSupabase'))), 'the load never returns it');
  const lg = readSource('scripts/log-signals-edge.mjs');
  assert.ok(/settings: \{[^}]*disableMacroOverlay: true \}/.test(lg) && !/disableMacroOverlay: false/.test(lg), 'the logger pins it');
});

run('no macro adjustment reaches a score, for any condition and category, under the setting the app actually makes', () => {
  const c = ctx();
  // Drive the REAL scoreStock with the pinned setting and every condition.
  const bars = Array.from({ length: 40 }, (_, i) => ({ t: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`, o: 10 + i * 0.05, h: 10.3 + i * 0.05, l: 9.8 + i * 0.05, c: 10 + i * 0.05, v: 1e6 + i * 1e4 }));
  const snap = { latestTrade: { p: 12.1 }, dailyBar: { c: 12.1, v: 2e6 }, prevDailyBar: { c: 11.9 } };
  c.state.settings.disableMacroOverlay = c.MACRO_OVERLAY_PINNED_OFF;
  let checked = 0;
  for (const cond of c.MACRO_CONDITIONS) for (const cat of CATEGORIES) {
    c.state.macroContext = { condition: cond, changes: { SPY: -2 } };
    const s = c.scoreStock('ABC', snap, bars, null, 0, cat);
    if (!s) continue;
    assert.strictEqual(s.macroAdjustment, 0, `${cond}/${cat}: adjustment ${s.macroAdjustment}`);
    checked++;
  }
  assert.ok(checked > 50, `scored ${checked} cases (a scorer that returns null for everything would pass vacuously)`);
});

run('the display cut is the base line for every condition and category; the old rule survives only as the recorded counterfactual', () => {
  const c = ctx();
  let raisedSomewhere = false;
  for (const cond of [...c.MACRO_CONDITIONS, null]) for (const cat of CATEGORIES) {
    assert.strictEqual(c.getDisplayThreshold(cond, cat), c.BASE_SCORE_THRESHOLD, `${cond}/${cat}`);
    if (c.wouldBeDisplayThreshold(cond, cat) !== c.BASE_SCORE_THRESHOLD) raisedSomewhere = true;
  }
  assert.ok(raisedSomewhere, 'the counterfactual still records the old raise');
});

run('a missing quote is missing (null), never 0%, and the pattern rule is withheld when it needs one', () => {
  const c = ctx();
  const q = p => ({ dailyBar: { c: p, t: '2026-10-30T04:00:00Z' }, prevDailyBar: { c: 100 } });
  const { changes, missing } = c.macroMovesFromSnapshots({ SPY: q(99), XLE: q(101), XLK: undefined, XBI: q(100), XLF: { dailyBar: { c: 100, t: '2026-10-30T04:00:00Z' }, prevDailyBar: null }, XLI: q(100), XLRE: q(100), XLY: q(100) }, Date.parse('2026-10-30T15:00:00Z'));
  assert.strictEqual(changes.XLK, null); assert.strictEqual(changes.XLF, null);
  assert.deepStrictEqual([...missing].sort(), ['XLF', 'XLK']);
  assert.ok(Math.abs(changes.SPY - -1) < 1e-9);
});

// The stale daily bar (2026-11-03). Friday 10-30 and the Thursday before it.
const FRI_0600 = Date.parse('2026-10-30T13:00:00Z'), FRI_0800 = Date.parse('2026-10-30T15:00:00Z'), SUN_1000 = Date.parse('2026-11-01T17:00:00Z');
const snapOn = (day, c = 101) => ({ dailyBar: { c, t: `${day}T04:00:00Z` }, prevDailyBar: { c: 100 } });

run("a stale ETF bar is UNJUDGED, never a number: yesterday's move is not today's", () => {
  const c = ctx();
  const r = c.macroMovesFromSnapshots({ SPY: snapOn('2026-10-29'), XLE: snapOn('2026-10-30'), XLK: snapOn('2026-10-30'), XBI: snapOn('2026-10-30'), XLF: snapOn('2026-10-30'), XLI: snapOn('2026-10-30'), XLRE: snapOn('2026-10-30'), XLY: snapOn('2026-10-30') }, FRI_0800);
  assert.strictEqual(r.changes.SPY, null, 'stale: no move');
  assert.ok(Math.abs(r.changes.XLE - 1) < 1e-9, "today's bar: a move");
  assert.deepStrictEqual([...r.unjudged], ['SPY']);
  assert.deepStrictEqual([...r.missing], [], 'stale is not missing: they are different failures');
  assert.strictEqual(r.barDates.SPY, '2026-10-29'); assert.strictEqual(r.barDates.XLE, '2026-10-30');
  const undated = c.macroMovesFromSnapshots({ SPY: { dailyBar: { c: 101 }, prevDailyBar: { c: 100 } } }, FRI_0800);
  assert.strictEqual(undated.changes.SPY, null); assert.ok(undated.unjudged.includes('SPY'), 'an undated bar is not assumed current');
  const tradeOnly = c.macroMovesFromSnapshots({ SPY: { latestTrade: { p: 101 }, prevDailyBar: { c: 100 } } }, FRI_0800);
  assert.strictEqual(tradeOnly.changes.SPY, null, 'no dailyBar to date the move by');
  assert.strictEqual(tradeOnly.barDates.SPY, null);
});

run('why not dailyBarSessionAge: it calls the pre-market stale bar CURRENT, by design; the macro rule must not', () => {
  const c = ctx();
  const ask = (day, ms) => [vm.runInContext('(s, m) => dailyBarSessionAge(scanFreshness(s, m)).state', c)(snapOn(day), ms), c.macroBarState(snapOn(day), ms).state];
  // The two questions differ exactly here. If the gate's function ever changes, this says so.
  assert.deepStrictEqual(ask('2026-10-29', FRI_0600), ['CURRENT', 'EARLIER_SESSION'], 'pre-market');
  assert.deepStrictEqual(ask('2026-10-30', SUN_1000), ['CURRENT', 'EARLIER_SESSION'], "a closed day: Friday's move isn't Sunday's");
  // In session they are one rule, and agree both ways.
  assert.deepStrictEqual(ask('2026-10-29', FRI_0800), ['EARLIER_SESSION', 'EARLIER_SESSION'], 'in session, stale');
  assert.deepStrictEqual(ask('2026-10-30', FRI_0800), ['CURRENT', 'CURRENT'], 'in session, current');
  assert.deepStrictEqual(ask('2026-10-30', FRI_0600), ['CURRENT', 'CURRENT'], "pre-market with a trade today: a real move");
});

run('the path: pattern when unambiguous; Groq when CHOPPY/ambiguous/incomplete and Groq answered; else pattern_groq_failed, or unclassified when nothing classified', () => {
  const c = ctx();
  const d = o => JSON.parse(JSON.stringify(c.decideMacroPath(o)));
  assert.deepStrictEqual(d({ patternCondition: 'GEOPOLITICAL', ambiguous: false, groqCondition: 'CHOPPY' }), { path: 'pattern', condition: 'GEOPOLITICAL' });
  assert.deepStrictEqual(d({ patternCondition: 'CHOPPY', ambiguous: false, groqCondition: 'GEOPOLITICAL' }), { path: 'groq', condition: 'GEOPOLITICAL' });
  assert.deepStrictEqual(d({ patternCondition: 'RISK_OFF', ambiguous: true, groqCondition: null }), { path: 'pattern_groq_failed', condition: 'RISK_OFF' });
  // ran, classified nothing: its own value, not pattern_groq_failed with a NULL condition (db/038 revision e)
  assert.deepStrictEqual(d({ patternCondition: null, ambiguous: false, groqCondition: null }), { path: 'unclassified', condition: null });
});

run('Groq is asked once per trading day unconditionally, again on a pattern change, otherwise carried', () => {
  const c = ctx();
  assert.strictEqual(c.macroGroqAskReason(null, '2026-11-03', 'GEOPOLITICAL'), 'daily');
  assert.strictEqual(c.macroGroqAskReason({ tradingDate: '2026-11-02', patternCondition: 'GEOPOLITICAL' }, '2026-11-03', 'GEOPOLITICAL'), 'daily');
  assert.strictEqual(c.macroGroqAskReason({ tradingDate: '2026-11-03', patternCondition: 'GEOPOLITICAL' }, '2026-11-03', 'GEOPOLITICAL'), null);
  assert.strictEqual(c.macroGroqAskReason({ tradingDate: '2026-11-03', patternCondition: 'GEOPOLITICAL' }, '2026-11-03', 'CHOPPY'), 'pattern_changed');
});

// observeMacro end to end, with every external call faked and recorded.
function observed({ moves, groqReply = 'GEOPOLITICAL — oil up on tensions', groqOk = true, last = null, insertError = null, staleBars = false }) {
  const c = ctx();
  c.state.macroGroqLast = last;
  const calls = { groqBodies: [] };
  const barDay = staleBars ? '2020-01-02' : c.ptDateTimeOf(Date.now()).date;
  c.fetchSnapshots = async () => Object.fromEntries(Object.entries(moves).map(([t, pct]) => [t, pct == null ? undefined : { dailyBar: { c: 100 + pct, t: `${barDay}T04:00:00Z` }, prevDailyBar: { c: 100 } }]));
  c.fetchNewsForTickers = async () => { c.state.newsLastRequest = { symbols: ['SPY', 'QQQ'], start: 's' }; return [{ id: 1, created_at: new Date().toISOString(), source: 'b', headline: 'Oil jumps' }]; };
  c.fetch = async (url, opts) => { calls.groqBodies.push(JSON.parse(opts.body)); return { ok: groqOk, status: groqOk ? 200 : 503, json: async () => ({ choices: [{ message: { content: groqReply } }] }) }; };
  c.supabaseClient = { from: t => ({ insert: row => ({ select: async () => { c.inserted.push({ t, row }); return insertError ? { data: null, error: insertError } : { data: [{ id: 'obs-1' }], error: null }; } }) }) };
  return { c, calls };
}
const FLAT = { SPY: 0.07, XLE: 0.86, XLK: 0.18, XBI: 1.04, XLF: 0.39, XLI: 0.2, XLRE: -1.1, XLY: -0.5 }; // 10-29's 07:18 context: pattern CHOPPY

run('observeMacro: CHOPPY by pattern -> Groq asked (daily) at temperature 0, its answer shown as path groq; everything recorded; nothing applied', async () => {
  const { c, calls } = observed({ moves: FLAT });
  const ctx1 = await c.observeMacro();
  assert.strictEqual(calls.groqBodies.length, 1);
  assert.strictEqual(calls.groqBodies[0].temperature, 0, 'temperature 0');
  assert.strictEqual(ctx1.path, 'groq'); assert.strictEqual(ctx1.condition, 'GEOPOLITICAL'); assert.strictEqual(ctx1.patternCondition, 'CHOPPY');
  const row = c.inserted[0].row;
  assert.strictEqual(c.inserted[0].t, 'macro_observations');
  assert.strictEqual(row.applied, false);
  assert.strictEqual(row.display_threshold, c.BASE_SCORE_THRESHOLD, 'the base cut, on a GEOPOLITICAL day');
  assert.strictEqual(row.would_adjust.display_threshold.TECH, 65, 'the old raise, as a counterfactual');
  assert.ok(row.groq_asked && row.groq_ask_reason === 'daily' && row.groq_temperature === 0 && row.groq_raw_reply && row.groq_headlines.length === 1 && row.groq_request.filter_hours === 6);
  assert.strictEqual(ctx1.observationId, 'obs-1');
  assert.ok(c.persisted.includes('macroGroqLast'));
});

run('observeMacro: same day, same pattern -> Groq NOT re-asked; its answer is carried and recorded as such', async () => {
  const { c, calls } = observed({ moves: FLAT, last: { tradingDate: new Date().toISOString().slice(0, 10), patternCondition: 'CHOPPY', condition: 'SECTOR_WEAKNESS_TECH', failed: false } });
  const ctx1 = await c.observeMacro();
  assert.strictEqual(calls.groqBodies.length, 0);
  assert.strictEqual(ctx1.condition, 'SECTOR_WEAKNESS_TECH');
  const row = c.inserted[0].row;
  assert.strictEqual(row.groq_asked, false); assert.strictEqual(row.groq_ask_reason, null); assert.strictEqual(row.groq_condition, 'SECTOR_WEAKNESS_TECH');
});

run('observeMacro: an unambiguous pattern day still asks Groq once (the disagreement record), but shows the pattern answer', async () => {
  const { c, calls } = observed({ moves: { SPY: -1.48, XLE: 1.6, XLK: -0.2, XBI: -0.5, XLF: -0.56, XLI: 0, XLRE: 0, XLY: 0 }, groqReply: 'TECH_ROTATION_OUT — tech sold' });
  const ctx1 = await c.observeMacro();
  assert.strictEqual(calls.groqBodies.length, 1, 'asked even though unambiguous');
  assert.strictEqual(ctx1.path, 'pattern'); assert.strictEqual(ctx1.condition, 'GEOPOLITICAL'); assert.strictEqual(ctx1.groqCondition, 'TECH_ROTATION_OUT');
  c.state.macroContext = ctx1; // what the scan does with it
  assert.ok(/disagree/.test(c.buildMacroBanner()) && /GEOPOLITICAL/.test(c.buildMacroBanner()) && /TECH_ROTATION_OUT/.test(c.buildMacroBanner()), 'both answers on the banner');
});

run('observeMacro: Groq fails -> pattern_groq_failed, the failure recorded; a missing quote withholds the pattern answer', async () => {
  let h = observed({ moves: FLAT, groqOk: false });
  let ctx1 = await h.c.observeMacro();
  assert.strictEqual(ctx1.path, 'pattern_groq_failed'); assert.strictEqual(ctx1.condition, 'CHOPPY');
  assert.ok(h.c.inserted[0].row.groq_failed === true && /503/.test(h.c.inserted[0].row.groq_error));
  h = observed({ moves: { ...FLAT, XLK: null }, groqOk: false });
  ctx1 = await h.c.observeMacro();
  assert.strictEqual(ctx1.patternCondition, null); assert.strictEqual(ctx1.condition, null);
  assert.strictEqual(ctx1.path, 'unclassified', 'a missing quote and a failed Groq: the engine ran and classified nothing');
  assert.ok(h.c.inserted[0].row.pattern_incomplete && h.c.inserted[0].row.missing_etfs.includes('XLK') && h.c.inserted[0].row.etf_moves.XLK === null);
  h.c.state.macroContext = ctx1;
  assert.ok(/Missing quotes: XLK/.test(h.c.buildMacroBanner()) && /could not run/.test(h.c.buildMacroBanner()));
});

run('observeMacro: stale bars -> the rule could not run, and that is what is recorded, not a condition from yesterday', async () => {
  // Yesterday's moves would classify confidently as GEOPOLITICAL.
  const moves = { SPY: -1.48, XLE: 1.6, XLK: -0.2, XBI: -0.5, XLF: -0.56, XLI: 0, XLRE: 0, XLY: 0 };
  const h = observed({ moves, staleBars: true, groqOk: false });
  const x = await h.c.observeMacro();
  assert.strictEqual(x.patternCondition, null); assert.strictEqual(x.condition, null);
  const row = h.c.inserted[0].row;
  assert.strictEqual(row.pattern_incomplete, true); assert.strictEqual(row.pattern_condition, null);
  assert.strictEqual(row.unjudged_etfs.length, 8); assert.strictEqual(row.missing_etfs.length, 0);
  assert.strictEqual(row.etf_moves.SPY, null, 'no stale number stored');
  assert.strictEqual(row.etf_bar_dates.SPY, '2020-01-02', 'the date the call was made on is stored');
  h.c.state.macroContext = x;
  const b = h.c.buildMacroBanner();
  assert.ok(/Not judged/.test(b) && /could not run/.test(b) && !/Missing quotes/.test(b), b);
  // Groq, if it answers, is told the moves aren't available, and the banner says the rule couldn't run.
  const g = observed({ moves, staleBars: true, groqReply: 'BROAD_RALLY — headlines' });
  const y = await g.c.observeMacro();
  assert.ok(/SPY: not available/.test(g.calls.groqBodies[0].messages[0].content), 'no stale move in the prompt');
  assert.strictEqual(y.path, 'groq'); assert.strictEqual(g.c.inserted[0].row.pattern_incomplete, true);
  g.c.state.macroContext = y;
  assert.ok(/Groq \(the pattern rule could not run\)/.test(g.c.buildMacroBanner()));
});

run('observeMacro: a failed observation write is said on the banner, and the context carries no invented id', async () => {
  const { c } = observed({ moves: FLAT, insertError: { code: '42501', message: 'denied' } });
  const ctx1 = await c.observeMacro();
  assert.strictEqual(ctx1.observationId, null);
  c.state.macroContext = ctx1;
  // CHANGED 2026-11-13, declared (the reviewer, from the 390px render): what failed and what it costs FIRST, the raw
  // error whole and LAST, and the container itself changes.
  const b = c.buildMacroBanner();
  const body = b.slice(b.indexOf('</summary>'));
  assert.ok(/^<details class="macro-banner macro-banner-unrecorded">/.test(b), 'the container changes, not one word in it: ' + b.slice(0, 80));
  assert.ok(body.indexOf('Not recorded') >= 0 && body.indexOf('Not recorded') < body.indexOf('Decided by') && body.indexOf('Decided by') < body.indexOf('Informational only'), 'the failure and its cost before the content: ' + body);
  assert.ok(/so today may not count toward the macro test/.test(body), 'says what it costs');
  assert.ok(body.trimEnd().endsWith('The error, as the database returned it: 42501: denied</details>'), 'the raw error, whole, last: ' + body.slice(-120));
});

run('the banner is ALWAYS shown when a condition was observed: CHOPPY included, says it affects nothing, never "50+"', async () => {
  const { c } = observed({ moves: FLAT, groqReply: 'CHOPPY — quiet' });
  await c.observeMacro().then(x => { c.state.macroContext = x; });
  const b = c.buildMacroBanner();
  assert.ok(/CHOPPY/.test(b) && /Informational only/.test(b) && !/50\+/.test(b), b);
  c.state.macroContext = null; c.state.macroFetchError = { message: 'HTTP 500' };
  assert.ok(/Market condition unavailable/.test(c.buildMacroBanner()) && /HTTP 500/.test(c.buildMacroBanner()));
  assert.ok(!/disableMacroOverlay/.test(grab('buildMacroBanner')), 'no setting can suppress it');
});

// The report section, with the app's own rule for what a trading day is.
function reportCtx(over = {}) {
  const grabR = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
  const c = { Date, Math, JSON, String, Number, Object, Array, Error, Intl, state: {}, withTimeout: p => p, ...over };
  vm.createContext(c);
  vm.runInContext(readSource('core/clock.js'), c);
  const edge = readSource('core/edge-scoring.js');
  const adj = edge.slice(edge.indexOf('const MACRO_ADJUSTMENTS = {'), edge.indexOf('\n};\n', edge.indexOf('const MACRO_ADJUSTMENTS = {')) + 4);
  vm.runInContext(adj + '\nfunction getMacroAdjustment(condition, category) { return MACRO_ADJUSTMENTS[condition]?.[category] ?? 0; }', c);
  vm.runInContext(['MACRO_TEST_MIN_DAYS', 'MACRO_TEST_MIN_DISAGREE_DAYS', 'MACRO_TEST_MIN_AWAY_DAYS', 'MACRO_REPORT_DAYS', 'MACRO_READ_PAGE_ROWS'].map(n => app.match(new RegExp(`^const ${n} = \\d+;$`, 'm'))[0]).join('\n') + '\n'
    + ['macroRuleStance', 'macroGroqDayLabel', 'buildMacroObservationSection', 'macroObservationsControl', 'fetchMacroObservationsForReport'].map(grabR).join('\n')
    + ';Object.assign(globalThis, { f: buildMacroObservationSection, stance: macroRuleStance, label: macroGroqDayLabel, fetchIt: fetchMacroObservationsForReport, MACRO_READ_PAGE_ROWS });', c);
  return c;
}
const obs = (d, t, o) => ({ trading_date: d, fetched_at: `${d}T${t}Z`, condition: 'CHOPPY', path: 'pattern', pattern_condition: 'CHOPPY', pattern_matched: [], pattern_incomplete: false, groq_condition: 'CHOPPY', groq_asked: false, groq_failed: null, display_threshold: 20, missing_etfs: [], unjudged_etfs: [], ...o });
const OK_READ = { state: 'READ_OK' };
// Weekdays from a Monday, skipping weekends and the calendar's holidays.
function sessions(n, from = '2026-09-14') {
  const c = reportCtx(), out = [];
  for (let d = new Date(from + 'T12:00:00Z'); out.length < n; d.setUTCDate(d.getUTCDate() + 1)) {
    const s = d.toISOString().slice(0, 10);
    if (c.classifySession(s, '06:30') === 'REGULAR') out.push(s);
  }
  return out;
}

run('a reading is decided, abstained, or could not run; only "decided" is an opinion', () => {
  const c = reportCtx();
  assert.strictEqual(c.stance(obs('2026-11-04', '14:00:00', { pattern_condition: 'GEOPOLITICAL', pattern_matched: ['GEOPOLITICAL'] })), 'decided');
  assert.strictEqual(c.stance(obs('2026-11-04', '14:00:00', {})), 'abstained', 'CHOPPY');
  assert.strictEqual(c.stance(obs('2026-11-04', '14:00:00', { pattern_condition: 'RISK_OFF', pattern_matched: ['RISK_OFF', 'GEOPOLITICAL'] })), 'abstained', 'ambiguous');
  assert.strictEqual(c.stance(obs('2026-11-04', '14:00:00', { pattern_condition: null, pattern_incomplete: true })), 'could_not_run');
});

run('the report section: Groq failure rate, the two disagreements, and the day list, computed from the rows', () => {
  const c = reportCtx();
  const today = new Date().toISOString().slice(0, 10);
  const out = c.f([
    obs('2026-11-04', '14:00:00', { groq_asked: true, groq_failed: false }),
    obs('2026-11-04', '15:00:00', { groq_condition: 'GEOPOLITICAL', condition: 'GEOPOLITICAL', path: 'groq' }),
    obs('2026-11-05', '14:00:00', { groq_asked: true, groq_failed: true, missing_etfs: ['XLK'], pattern_condition: 'RISK_OFF', pattern_matched: ['RISK_OFF'], groq_condition: 'BROAD_RALLY' }),
    obs('2026-11-06', '13:00:00', { pattern_condition: null, pattern_incomplete: true, groq_condition: null, unjudged_etfs: ['SPY'], condition: null }),
  ], null, OK_READ);
  assert.ok(/all 4 readings: 3 trading day\(s\)/.test(out) && /asked 2 time\(s\), failed 1 \(50%\)/.test(out), out);
  assert.ok(/The rule: decided on 1 trading day\(s\), only abstained on 1, could not run at all on 1\./.test(out), out);
  assert.ok(/Rule DECIDED, Groq chose differently: 1 day\(s\): both named a condition on 1, rule named one and Groq said CHOPPY on 0/.test(out), out);
  assert.ok(/Rule ABSTAINED, Groq named a condition: 1 day\(s\)\./.test(out), out);
  assert.ok(/SECONDARY test, rule vs Groq \(phase-10 spec\): needs 20\+ trading days logged \(have 3\) and 8\+ days the rule decided and Groq chose differently \(have 1\): not yet/.test(out), out);
  if (today <= '2026-12-20') assert.ok(/2026-11-04  GEOPOLITICAL\s+groq \(pattern CHOPPY, Groq GEOPOLITICAL\)/.test(out) && /missing XLK/.test(out) && /not judged SPY/.test(out), out);
});

run('the 8-day bar counts ONLY days the rule decided: 30 abstentions against a named Groq answer do not meet it', () => {
  const c = reportCtx();
  const abstain = sessions(30).map(d => obs(d, '14:00:00', { groq_condition: 'GEOPOLITICAL' }));
  let out = c.f(abstain, null, OK_READ);
  assert.ok(/Rule DECIDED, Groq chose differently: 0 day/.test(out) && /Rule ABSTAINED, Groq named a condition: 30 day/.test(out) && /differently \(have 0\): not yet/.test(out), out);
  out = c.f(sessions(3).map(d => obs(d, '14:00:00', { groq_condition: 'CHOPPY' })), null, OK_READ);
  assert.ok(/Rule ABSTAINED, Groq named a condition: 0 day/.test(out), 'both abstaining is not Groq naming something: ' + out);
  const decide = (d, g) => obs(d, '14:00:00', { pattern_condition: 'RISK_OFF', pattern_matched: ['RISK_OFF'], groq_condition: g });
  const days = sessions(20);
  // 8 decided-and-different in 20 days: met. 7: not. Agreeing with the rule, or no Groq answer: not a disagreement.
  out = c.f(days.map((d, i) => decide(d, i < 8 ? 'BROAD_RALLY' : 'RISK_OFF')), null, OK_READ);
  assert.ok(/have 8\): sample bar MET/.test(out), out);
  out = c.f(days.map((d, i) => decide(d, i < 7 ? 'BROAD_RALLY' : i < 12 ? null : 'RISK_OFF')), null, OK_READ);
  assert.ok(/have 7\): not yet/.test(out), out);
  // Enough disagreement, too few days.
  out = c.f(days.slice(0, 19).map(d => decide(d, 'BROAD_RALLY')), null, OK_READ);
  assert.ok(/have 19\) and .*have 19\): not yet/.test(out), out);
  // Groq's CHOPPY is a selection, so against a decision it counts toward the 8, as its own sub-kind.
  out = c.f(days.map(d => decide(d, 'CHOPPY')), null, OK_READ);
  assert.ok(/differently \(have 20\): sample bar MET/.test(out), out);
  assert.ok(/20 day\(s\): both named a condition on 0, rule named one and Groq said CHOPPY on 20/.test(out), out);
  out = c.f([decide(days[0], 'BROAD_RALLY'), decide(days[1], 'CHOPPY'), decide(days[2], 'RISK_OFF')], null, OK_READ);
  assert.ok(/2 day\(s\): both named a condition on 1, rule named one and Groq said CHOPPY on 1/.test(out), out);
});

run('the day label: Groq\'s FIRST answer given the moves; an answer without them never labels a day', () => {
  const c = reportCtx();
  const d = '2026-11-04';
  const noMoves = (t, g) => obs(d, t, { pattern_condition: null, pattern_incomplete: true, groq_condition: g });
  assert.strictEqual(c.label([obs(d, '15:00:00', { groq_condition: 'RISK_OFF' }), obs(d, '14:00:00', { groq_condition: 'BROAD_RALLY' })]), 'BROAD_RALLY', 'first by time, whatever the row order');
  assert.strictEqual(c.label([noMoves('13:00:00', 'GEOPOLITICAL'), obs(d, '14:30:00', { groq_condition: 'BROAD_RALLY' })]), 'BROAD_RALLY', 'the pre-market headlines answer is skipped');
  assert.strictEqual(c.label([noMoves('13:00:00', 'GEOPOLITICAL')]), null);
  assert.strictEqual(c.label([obs(d, '14:00:00', { groq_condition: null }), obs(d, '15:00:00', { groq_condition: 'CHOPPY' })]), 'CHOPPY', 'a failed ask labels nothing; CHOPPY is an answer');
});

run('the PRIMARY bar: labelled days, and the predicted sign has to vary; the CHOPPY count is reported; headlines-alone days are apart', () => {
  const c = reportCtx();
  const days = sessions(30);
  const g = (d, cond) => obs(d, '14:00:00', { groq_condition: cond });
  const mix = (geo, chop, total) => days.slice(0, total).map((d, i) => g(d, i < geo ? 'GEOPOLITICAL' : i < geo + chop ? 'CHOPPY' : 'BROAD_RALLY'));
  let out = c.f(mix(5, 5, 20), null, OK_READ);
  assert.ok(/labelled \(have 20\), 5\+ of them away from the most common predicted sign \(have 10; \+ 10, − 5, CHOPPY 5\): sample bar MET, run scripts\/run-macro-sign-test\.mjs/.test(out), out);
  assert.ok(/CHOPPY 5, GEOPOLITICAL 5 \(expected lower\), BROAD_RALLY 10 \(expected higher\)/.test(out), 'the direction comes from the OTHER column: ' + out);
  assert.ok(/Groq named a condition on 15 of 20 labelled day\(s\), CHOPPY on 5\./.test(out), 'the CHOPPY count is worth knowing on its own: ' + out);
  assert.ok(/labelled \(have 19\).*: not yet/.test(c.f(mix(5, 5, 19), null, OK_READ)), '19 days');
  // Every day but 4 on one sign: nothing to correlate.
  out = c.f(mix(16, 2, 20), null, OK_READ);
  assert.ok(/\(have 4; \+ 2, − 16, CHOPPY 2\): not yet/.test(out), 'too little variation: ' + out);
  // No + day at all, the rule-like split: it can still run.
  out = c.f(days.slice(0, 20).map((d, i) => g(d, i < 6 ? 'GEOPOLITICAL' : 'CHOPPY')), null, OK_READ);
  assert.ok(/\(have 6; \+ 0, − 6, CHOPPY 14\): sample bar MET/.test(out), out);
  // The sign is OTHER's, the logger's universe. This condition is 0 for TECH and -5 for OTHER.
  out = c.f(days.slice(0, 20).map((d, i) => g(d, i < 6 ? 'SECTOR_WEAKNESS_BIOTECH' : 'CHOPPY')), null, OK_READ);
  assert.ok(/\(have 6; \+ 0, − 6, CHOPPY 14\)/.test(out), 'the sign comes from the OTHER column: ' + out);
  // Thirty days of Groq on headlines alone move neither test.
  out = c.f(days.map(d => obs(d, '13:00:00', { pattern_condition: null, pattern_incomplete: true, groq_condition: 'GEOPOLITICAL' })), null, OK_READ);
  assert.ok(/Groq on headlines alone[^\n]*: 30 day\(s\)/.test(out) && /labelled \(have 0\)/.test(out) && /differently \(have 0\)/.test(out), out);
  // A day with both goes to the label, not the headlines count.
  out = c.f([obs(days[0], '13:00:00', { pattern_condition: null, pattern_incomplete: true, groq_condition: 'RISK_OFF' }), g(days[0], 'CHOPPY')], null, OK_READ);
  assert.ok(/headlines alone[^\n]*: 0 day\(s\)/.test(out) && /labelled \(have 1\)/.test(out), out);
});

run('the macro banner is one line on the Signals tab: condition, age and what must not be missed; the rest opens on a tap', () => {
  const c = reportCtx();
  const grabFn = name => { const a = app.search(new RegExp(`^function ${name}\\(`, 'm')); return app.slice(a, app.indexOf('\n}\n', a) + 3); };
  vm.runInContext(grabFn('macroBannerAge') + grabFn('buildMacroBanner') + ';globalThis.__mb = buildMacroBanner;', c);
  const banner = ctx => {
    vm.runInContext(`state = ${JSON.stringify({ macroContext: { path: 'groq', fetchedAt: Date.now(), missing: [], unjudged: [], explanation: 'A long explanation.', observationError: null, ...ctx } })};`, c);
    return c.__mb();
  };
  const summary = s => s.slice(s.indexOf('<summary>'), s.indexOf('</summary>'));
  const agree = banner({ path: 'pattern', condition: 'GEOPOLITICAL', patternCondition: 'GEOPOLITICAL', groqCondition: 'GEOPOLITICAL' });
  assert.ok(agree.startsWith('<details class="macro-banner"><summary>') && /GEOPOLITICAL/.test(summary(agree)) && /just now/.test(summary(agree)), agree);
  assert.ok(!/Informational only|A long explanation|Decided by|answers differ/.test(summary(agree)), 'nothing long on the line: ' + summary(agree));
  assert.ok(/Informational only/.test(agree) && /Decided by pattern rule/.test(agree), 'and it is all still there on a tap');
  const differ = banner({ condition: 'BROAD_RALLY', patternCondition: 'GEOPOLITICAL', groqCondition: 'BROAD_RALLY' });
  assert.ok(/answers differ/.test(summary(differ)) && /The two answers disagree/.test(differ), differ);
  // The rule's CHOPPY is a fallthrough and an ambiguous match is no answer: neither disagrees.
  for (const x of [{ patternCondition: 'CHOPPY' }, { patternCondition: 'GEOPOLITICAL', ambiguous: true }]) {
    const b = banner({ condition: 'BROAD_RALLY', groqCondition: 'BROAD_RALLY', ...x });
    assert.ok(!/answers differ/.test(b) && !/disagree/.test(b), b);
  }
  assert.ok(/NOT RECORDED/.test(summary(banner({ condition: 'CHOPPY', patternCondition: 'CHOPPY', groqCondition: 'CHOPPY', observationError: '42501: denied' }))), 'a lost record is never behind the tap');
  assert.ok(/rule could not run/.test(summary(banner({ condition: 'RISK_OFF', patternCondition: null, groqCondition: 'RISK_OFF' }))));
  // The line can't wrap, so what's last gets clipped: at 390px "NOT RECORDED" did, behind
  // the age. The order is what keeps it visible.
  const worst = summary(banner({ condition: 'SECTOR_WEAKNESS_ENERGY', patternCondition: 'GEOPOLITICAL', groqCondition: 'SECTOR_WEAKNESS_ENERGY', observationError: 'x' }));
  // CHANGED 2026-11-13, declared: NOT RECORDED leads the line (the state, then the content), in red.
  assert.ok(worst.indexOf('NOT RECORDED') >= 0 && worst.indexOf('NOT RECORDED') < worst.indexOf('SECTOR_WEAKNESS_ENERGY') && worst.indexOf('SECTOR_WEAKNESS_ENERGY') < worst.indexOf('answers differ') && worst.indexOf('answers differ') < worst.indexOf('just now'), worst);
  const css = readSource('styles.css');
  assert.ok(/\.macro-banner summary \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/.test(css), 'the summary cannot wrap');
  assert.ok(/<span class="macro-unrecorded">NOT RECORDED<\/span>/.test(worst), 'NOT RECORDED carries its own (red) class');
  assert.ok(/\.macro-banner\.macro-banner-unrecorded \{[^}]*border-color: var\(--red\)/.test(css) && /\.macro-banner \.macro-unrecorded \{[^}]*color: var\(--red\)/.test(css), 'a red container and a red word (the selector must outrank .macro-banner strong, which is blue: the 390px render showed it losing)');
});

run('every condition has a one-sided direction for the logger\'s universe: no zero in the OTHER column', () => {
  const c = reportCtx();
  for (const k of vm.runInContext('Object.keys(MACRO_ADJUSTMENTS)', c)) {
    if (k === 'CHOPPY') assert.strictEqual(c.getMacroAdjustment(k, 'OTHER'), 0, 'the comparison day moves nothing');
    else assert.notStrictEqual(c.getMacroAdjustment(k, 'OTHER'), 0, k + ' has no direction to test');
  }
  assert.ok(/STOCK_UNIVERSES\)?\.OTHER|\.OTHER/.test(readSource('scripts/lib/alpaca-bars.mjs')), 'the EDGE universe is OTHER');
});

run('progress counts the whole table, not the listed window, and a day with no session is not a trading day', () => {
  const c = reportCtx();
  // The bar can take longer than the 45-day list: readings a year old still count.
  const old = sessions(25, '2025-06-02').map(d => obs(d, '14:00:00', { pattern_condition: 'RISK_OFF', pattern_matched: ['RISK_OFF'], groq_condition: 'BROAD_RALLY' }));
  const out = c.f(old, null, OK_READ);
  assert.ok(/have 25\) and .*have 25\): sample bar MET/.test(out), out);
  assert.ok(!/Last 45 days/.test(out), 'nothing in the listed window, nothing listed');
  const sunday = c.f([obs('2026-11-01', '17:00:00', {})], null, OK_READ);
  assert.ok(/0 trading day\(s\), plus 1 day\(s\) with no session, not counted/.test(sunday) && /have 0\)/.test(sunday), sunday);
});

run('THE PROGRESS LINE on a bad read says UNKNOWN, never "not yet": error, denied, cannot tell; only a proven empty says none', () => {
  const c = reportCtx();
  for (const out of [
    c.f(null, '42501: x', null),
    c.f([], null, { state: 'DENIED', detail: 'rating_snapshots has a row' }),
    c.f([], null, { state: 'CANNOT_TELL', detail: 'the check failed' }),
    c.f([], null, undefined),
  ]) {
    assert.ok(/progress UNKNOWN/.test(out) && !/: not yet/.test(out) && !/No observations recorded yet/.test(out), out);
  }
  assert.ok(/Not available: macro_observations could not be read \(42501: x\)/.test(c.f(null, '42501: x', null)));
  const none = c.f([], null, { state: 'NONE_CONFIRMED', detail: 'rating_snapshots reads fine' });
  assert.ok(/No observations recorded yet/.test(none) && /Read checked: rating_snapshots reads fine/.test(none) && /: not yet/.test(none), none);
});

// A fake client: each table answers from its own script.
function fakeDb({ pages = null, count = null, macroError = null, anySnap = [{ captured_at: 'x' }], anyErr = null, usedSnap = [], usedErr = null }) {
  const calls = [];
  return { calls, from: table => {
    const q = { table, not: null };
    const chain = {
      select: () => chain, order: () => chain, limit: () => chain,
      not: (...a) => { q.not = a; return chain; },
      range: (a, b) => { q.range = [a, b]; return chain; },
      then: (res, rej) => {
        calls.push(q);
        let out;
        if (table === 'macro_observations') out = macroError ? { data: null, error: macroError } : { data: (pages || [[]]).shift() || [], error: null, count };
        else out = q.not ? { data: usedSnap, error: usedErr } : { data: anySnap, error: anyErr };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return chain;
  } };
}
const fetchWith = async (db, state = {}) => { const c = reportCtx({ supabaseClient: db, state }); return JSON.parse(JSON.stringify(await c.fetchIt())); };

run('the positive control: an empty macro read is DENIED when anything shows the build has observed', async () => {
  let r = await fetchWith(fakeDb({ count: 0, usedSnap: [{ captured_at: '2026-11-04T14:00:00Z' }] }));
  assert.strictEqual(r.control.state, 'DENIED');
  r = await fetchWith(fakeDb({ count: 0 }), { macroContext: { observationId: 'obs-1' } });
  assert.strictEqual(r.control.state, 'DENIED', "this session's own observation");
  r = await fetchWith(fakeDb({ count: 0, anySnap: [] }));
  assert.strictEqual(r.control.state, 'CANNOT_TELL', 'the table it checks against reads empty too');
  r = await fetchWith(fakeDb({ count: 0, anyErr: { code: '42501', message: 'x' } }));
  assert.strictEqual(r.control.state, 'CANNOT_TELL');
  r = await fetchWith(fakeDb({ count: 0, usedErr: { code: '42703', message: 'no column' } }));
  assert.strictEqual(r.control.state, 'CANNOT_TELL');
  r = await fetchWith(fakeDb({ count: 0 }));
  assert.strictEqual(r.control.state, 'NONE_CONFIRMED');
  // The evidence is macro_path, and excludes what isn't evidence of an observation.
  const db = fakeDb({ count: 0 }); await fetchWith(db);
  assert.deepStrictEqual(db.calls.find(q => q.not).not, ['macro_path', 'in', '(unknown,not_fetched)']);
});

run('the macro read pages to the end, and a short read is an error, never a smaller count', async () => {
  const c0 = reportCtx(); const P = c0.MACRO_READ_PAGE_ROWS;
  const row = i => ({ id: String(i) });
  let db = fakeDb({ count: P + 2, pages: [Array.from({ length: P }, (_, i) => row(i)), [row(P), row(P + 1)]] });
  let r = await fetchWith(db);
  assert.strictEqual(r.rows.length, P + 2); assert.strictEqual(r.error, null); assert.strictEqual(r.control.state, 'READ_OK');
  assert.deepStrictEqual(db.calls.map(q => q.range), [[0, P - 1], [P, 2 * P - 1]]);
  r = await fetchWith(fakeDb({ count: 3, pages: [[row(0)], []] }));
  assert.strictEqual(r.rows, null); assert.ok(/read 1 of 3 rows/.test(r.error), r.error);
  r = await fetchWith(fakeDb({ macroError: { code: '42P01', message: 'no table' } }));
  assert.strictEqual(r.rows, null); assert.ok(/42P01/.test(r.error));
});

// ---- PREVENT AND OBSERVE (2026-11-12, before (c) lands; approved by the reviewer with four additions) -----------------
// The three tests above this line check the SWITCH (the pin is true; the reported adjustment is 0; the cut function
// returns the base line). Mutants that applied the reading while leaving the switch alone survived them: the score
// adding the adjustment while the report said 0, and the scan filtering by the old raised cut. These three check the
// CONSEQUENCE, each with a control showing the harness can see a change.
const util = require('util');
const { loadApp } = require('./_app-vm');
// (a) PINNED: the scoreStock fields that may differ by condition, because they RECORD it. A third field that varies
// fails test A until someone decides whether it is an observation or an effect.
const SCORE_OBSERVATION_FIELDS = ['macroChanges', 'macroCondition'];
const scoreFixture = () => ({
  bars: Array.from({ length: 40 }, (_, i) => ({ t: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`, o: 10 + i * 0.05, h: 10.3 + i * 0.05, l: 9.8 + i * 0.05, c: 10 + i * 0.05, v: 1e6 + i * 1e4 })),
  snap: { latestTrade: { p: 12.1 }, dailyBar: { c: 12.1, v: 2e6 }, prevDailyBar: { c: 11.9 } },
});

run('A. THE SCORE: under every condition and category, the whole scoreStock result is the no-condition result, but for the pinned observation fields; control: unpinned, the score moves', () => {
  const c = ctx();
  const { bars, snap } = scoreFixture();
  const score = (cond, cat) => { c.state.macroContext = cond === undefined ? null : { condition: cond, changes: { SPY: -2 } }; return c.scoreStock('ABC', snap, bars, null, 0, cat); };
  c.state.settings.disableMacroOverlay = c.MACRO_OVERLAY_PINNED_OFF;
  const varied = new Set();
  let cells = 0;
  for (const cat of CATEGORIES) {
    const base = score(undefined, cat);
    if (!base) continue;
    for (const cond of [...c.MACRO_CONDITIONS, null]) {
      const s = score(cond, cat);
      for (const k of new Set([...Object.keys(base), ...Object.keys(s)])) if (!util.isDeepStrictEqual(s[k], base[k])) varied.add(k);
      cells++;
    }
  }
  assert.ok(cells > 50, `scored ${cells} cells (a scorer returning null everywhere would pass vacuously)`);
  assert.deepStrictEqual([...varied].sort(), SCORE_OBSERVATION_FIELDS, 'only the fields that record the condition may vary with it');
  // CONTROL: the overlay unpinned, in this test's own context only. Some cell's score must move, or this harness
  // could not have seen an adjustment reach the score.
  c.state.settings.disableMacroOverlay = false;
  let moved = 0;
  for (const cat of CATEGORIES) {
    const base = score(undefined, cat);
    if (!base) continue;
    for (const cond of c.MACRO_CONDITIONS) if (score(cond, cat).score !== base.score) moved++;
  }
  assert.ok(moved > 0, 'control: with the pin off, no score moved, so the harness cannot see an applied adjustment');
});

// The scan, run for real: the app's scripts in index.html's order (tests/_app-vm.js), runScreener itself, with the
// network, the scorer and the renders replaced. The scorer returns fixture scores AT and one step either side of both
// cuts (b); the tier of every fixture row is read from state.lastFullScanResults, the scan's own record (c).
function scanHarness() {
  const { ctx } = loadApp();
  vm.runInContext(`
    state.settings.alpacaKey = 'k'; state.settings.alpacaSecret = 's'; state.settings.includeUnder2 = false;
    state.portfolio = [];
    var __B = BASE_SCORE_THRESHOLD, __E = ELEVATED_SCORE_THRESHOLD;
    var __scores = { B_MINUS: __B - 1, B_AT: __B, B_PLUS: __B + 1, E_MINUS: __E - 1, E_AT: __E, E_PLUS: __E + 1, LOW: 1, HIGH: 200 };
    TICKERS = Object.keys(__scores);
    var __cond = null;
    observeMacro = async () => __cond == null ? null : { condition: __cond, path: 'pattern', observationId: null };
    fetchSnapshots = async t => Object.fromEntries(t.map(x => [x, { latestTrade: { p: 5 }, dailyBar: { c: 5, v: 1e6 }, prevDailyBar: { c: 5 } }]));
    checkUnresolvedSymbols = () => {};
    runEdgePrefilter = async (t, snaps) => ({ candidates: t.map(x => [x, snaps[x]]), rule: 'fixture' });
    fetchMultiBars = async t => ({ results: Object.fromEntries(t.map(x => [x, []])), droppedSymbols: [] });
    fetchNewsForTickers = async () => [];
    isPreMarketHours = () => false; isAfterHoursMode = () => false;
    barsFreshness = () => ({}); scanFreshness = () => ({});
    scoreStock = ticker => ({ ticker, score: __scores[ticker], price: 5, signal: 'FIXTURE' });
    renderSkeletons = () => {}; setRefreshSpinning = () => {}; renderSignalsTab = () => {}; updateNavBadges = () => {};
    writeRatingSnapshots = () => {};
  `, ctx);
  const scan = async (cond, cat) => {
    vm.runInContext(`__cond = ${JSON.stringify(cond)}; state.selectedUniverse = ${JSON.stringify(cat)}; state.loading = false;`, ctx);
    await vm.runInContext('runScreener()', ctx);
    return vm.runInContext('Object.fromEntries((state.lastFullScanResults || []).map(r => [r.ticker, r.tier]))', ctx);
  };
  return { ctx, scan };
}

run('B. THE SCAN: every condition and category gives the same fixture-to-tier map, at the base cut, including AT both cuts; control: the old raised cut moves it', async () => {
  const { ctx, scan } = scanHarness();
  const expected = vm.runInContext('Object.fromEntries(Object.entries(__scores).map(([t, s]) => [t, s >= BASE_SCORE_THRESHOLD ? "SHOWN" : "BELOW_THRESHOLD"]))', ctx);
  assert.deepStrictEqual([expected.B_MINUS, expected.B_AT, expected.B_PLUS], ['BELOW_THRESHOLD', 'SHOWN', 'SHOWN'], 'the fixture straddles the base cut, AT it included');
  assert.ok(vm.runInContext('ELEVATED_SCORE_THRESHOLD > BASE_SCORE_THRESHOLD', ctx), 'the elevated cut is above the base: E_MINUS/E_AT/E_PLUS are where a raised cut would bite');
  const conds = vm.runInContext('MACRO_CONDITIONS', ctx);
  let runs = 0;
  for (const cat of CATEGORIES) for (const cond of [...conds, null]) {
    assert.deepStrictEqual(await scan(cond, cat), expected, `${cond}/${cat}: the tier map moved`);
    runs++;
  }
  assert.strictEqual(runs, CATEGORIES.length * (conds.length + 1));
  // CONTROL: route the scan's cut through the recorded counterfactual (the old rule). Some condition must move the map.
  vm.runInContext('getDisplayThreshold = wouldBeDisplayThreshold;', ctx);
  let moved = 0;
  for (const cat of CATEGORIES) for (const cond of conds) if (!util.isDeepStrictEqual(await scan(cond, cat), expected)) moved++;
  assert.ok(moved > 0, 'control: the old raised cut moved no tier, so this harness cannot see a moved cut');
});

// The logger has no macro context at all: it sets state.macroContext to null once and never assigns it (its header's
// KNOWN GAP), so its condition is always null. Two halves: that stays true (the condition has no way in), and its own
// tier code, run as written, gives the base-cut map for fixture scores at and either side of both cuts. The control
// hands the same code a condition and the old rule, and the map must move.
function loggerTierBlock() {
  const src = readSource('scripts/log-signals-edge.mjs');
  const i = src.indexOf("  const category = 'OTHER';\n");
  const j = src.indexOf('\n  });\n', src.indexOf('  const scoredAll = candidates.map(', i)) + '\n  });\n'.length;
  assert.ok(i > 0 && j > i, 'the logger\'s tier block is where it was');
  return src.slice(i, j);
}

run('C. THE LOGGER: its condition has no way in, and its own tier code gives the base-cut map AT and either side of both cuts; control: given a condition and the old rule, the map moves', () => {
  const src = readSource('scripts/log-signals-edge.mjs');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const sets = [...code.matchAll(/macroContext\s*[:=](?!=)\s*([^,;\n]+)/g)].map(m => m[1].trim());
  assert.deepStrictEqual(sets, ['null'], `the logger gives macroContext exactly one value, null: ${sets.join(' | ')}`);
  const c = ctx();
  const B = c.BASE_SCORE_THRESHOLD, E = vm.runInContext('ELEVATED_SCORE_THRESHOLD', c);
  const scores = { B_MINUS: B - 1, B_AT: B, B_PLUS: B + 1, E_MINUS: E - 1, E_AT: E, E_PLUS: E + 1, LOW: 1, HIGH: 200 };
  const expected = Object.fromEntries(Object.entries(scores).map(([t, s]) => [t, s >= B ? 'SHOWN' : 'BELOW_THRESHOLD']));
  // eslint-disable-next-line no-new-func
  const block = new Function('global', 'candidates', 'allBars', 'newsMap', 'spyChangePct', 'today', `${loggerTierBlock()}\nreturn scoredAll;`);
  const tiers = (condition, cut) => {
    const g = {
      state: { settings: { includeUnder2: false }, macroContext: condition == null ? null : { condition } },
      getDisplayThreshold: cut, scoreStock: t => ({ ticker: t, score: scores[t], price: 5 }), VERSION: 't',
      barsFreshness: () => ({}), scanFreshness: () => ({}),
    };
    return Object.fromEntries(block(g, Object.keys(scores).map(t => [t, {}]), {}, {}, 0, '2026-11-12').map(r => [r.ticker, r.tier]));
  };
  assert.deepStrictEqual(tiers(null, c.getDisplayThreshold), expected, 'the logger as it runs: no condition, the base cut');
  for (const cond of c.MACRO_CONDITIONS) assert.deepStrictEqual(tiers(cond, c.getDisplayThreshold), expected, `${cond} reaching the logger would not move its map`);
  // CONTROL: a condition plus the old rule (the logger's category is OTHER). Some condition must move the map.
  const moved = c.MACRO_CONDITIONS.filter(cond => !util.isDeepStrictEqual(tiers(cond, c.wouldBeDisplayThreshold), expected));
  assert.ok(moved.length > 0, 'control: the old rule moved no logger tier, so this harness cannot see a moved cut');
});

// D and E (2026-11-12): found by the coverage cross-check below, which no hand-written test had reached. D: the
// held-position recommendation carries a -20/+20/-15 macro factor, gated by the overlay setting; with the gate
// removed the whole suite passed. E: computeScoreBreakdown's total is not display only: openStockModal shows it as
// the modal's score when the stock has no scanned or held score, and captures it into appShowedAtBuy, which a buy stores.
function appWith(fn) {
  const { ctx } = loadApp();
  vm.runInContext('state.settings.disableMacroOverlay = MACRO_OVERLAY_PINNED_OFF;', ctx);
  return fn(ctx);
}

run('D. THE RECOMMENDATION: for a held position, every condition gives the no-condition recommendation; control: unpinned, it moves', () => appWith(ctx => {
  vm.runInContext(`
    var __pos = { id: 'p1', ticker: 'ABC', company: 'Abc', shares: 10, buyPrice: 10, buyDate: '2026-11-02', buyTime: '07:00',
      scoreAtBuy: 70, rsiAtBuy: 50, volRatioAtBuy: 1.2, peakPrice: 11, peakPriceDate: '2026-11-05', engineSource: 'EDGE',
      exitRuleId: null, codeVersion: { scoring: 2 } };
    var __snap = { latestTrade: { p: 10.6 }, dailyBar: { c: 10.6, v: 2e6 }, prevDailyBar: { c: 10.4 } };
    var __rec = cond => calcUnifiedRecommendation(__pos, null, cond == null ? null : { condition: cond, changes: { SPY: -2 } }, __snap, '2026-11-12');
  `, ctx);
  const conds = vm.runInContext('MACRO_CONDITIONS', ctx);
  const base = vm.runInContext('__rec(null)', ctx);
  assert.ok(base && typeof base === 'object', 'the recommendation ran on the fixture');
  for (const cond of conds) {
    const r = vm.runInContext(`__rec(${JSON.stringify(cond)})`, ctx);
    assert.ok(util.isDeepStrictEqual(r, base), `${cond}: the recommendation moved:\n${JSON.stringify(r).slice(0, 300)}\nvs\n${JSON.stringify(base).slice(0, 300)}`);
  }
  // CONTROL: the overlay unpinned in this VM only. Some condition must move the recommendation.
  vm.runInContext('state.settings.disableMacroOverlay = false;', ctx);
  const moved = conds.filter(cond => !util.isDeepStrictEqual(vm.runInContext(`__rec(${JSON.stringify(cond)})`, ctx), base));
  assert.ok(moved.length > 0, 'control: unpinned, no condition moved the recommendation, so this harness cannot see the macro factor');
}));

run('E. THE BREAKDOWN TOTAL (shown and captured at buy): every condition gives the no-condition total; control: unpinned, it moves', () => appWith(ctx => {
  const { bars, snap } = scoreFixture();
  Object.assign(ctx, { __bars: bars, __snapE: snap });
  vm.runInContext(`
    var __total = (cond, cat) => { state.macroContext = cond == null ? null : { condition: cond, changes: { SPY: -2 } };
      const s = scoreStock('ABC', __snapE, __bars, null, 0, cat); return s ? computeScoreBreakdown(s).total : null; };
  `, ctx);
  const conds = vm.runInContext('MACRO_CONDITIONS', ctx);
  let cells = 0;
  for (const cat of CATEGORIES) {
    const base = vm.runInContext(`__total(null, ${JSON.stringify(cat)})`, ctx);
    if (base == null) continue;
    for (const cond of conds) { assert.strictEqual(vm.runInContext(`__total(${JSON.stringify(cond)}, ${JSON.stringify(cat)})`, ctx), base, `${cond}/${cat}: the breakdown total moved`); cells++; }
  }
  assert.ok(cells > 50, `scored ${cells} cells`);
  vm.runInContext('state.settings.disableMacroOverlay = false;', ctx);
  let moved = 0;
  for (const cat of CATEGORIES) {
    const base = vm.runInContext(`__total(null, ${JSON.stringify(cat)})`, ctx);
    if (base == null) continue;
    for (const cond of conds) if (vm.runInContext(`__total(${JSON.stringify(cond)}, ${JSON.stringify(cat)})`, ctx) !== base) moved++;
  }
  assert.ok(moved > 0, 'control: unpinned, no breakdown total moved');
}));

run('F. THE RECORD SAYS WHERE THE SWITCH WAS: applied is the overlay\'s position at the observation; unpinned, the row says true (and CHECK (applied = false) refuses it)', async () => {
  const pinned = observed({ moves: FLAT });
  await pinned.c.observeMacro();
  assert.strictEqual(pinned.c.inserted[0].row.applied, false, 'pinned: not applied');
  const unpinned = observed({ moves: FLAT });
  unpinned.c.state.settings.disableMacroOverlay = false;
  await unpinned.c.observeMacro();
  assert.strictEqual(unpinned.c.inserted[0].row.applied, true, 'unpinned: the row must say applied, so the database refuses it, never record false');
  const check = JSON.parse(readSource('db/live-columns.json'));
  assert.ok(JSON.stringify(check).includes('CHECK ((applied = false))'), 'the capture still holds CHECK (applied = false) on macro_observations');
});

// THE COVERAGE CROSS-CHECK (2026-11-12, the reviewer: a coverage claim is asserted against an inventory the claim did
// not author). tests/macro-consumers.test.js classifies every consumer of the macro condition. Every one whose role
// could let the condition change an output (INERT_PINNED: would act if unpinned; PASS_THROUGH: hands the condition to
// one) is covered by one of the tests above, named here; the scan and the logger, which apply the cut, too. A consumer
// added to the inventory with one of those roles fails here until a test covers it; an entry here whose consumer is
// gone fails too. The count is pinned.
const COVERED_BY = {
  'core/edge-scoring.js|scoreStock': 'A',
  'app.js|runScreener': 'B',
  'scripts/log-signals-edge.mjs|main': 'C',
  'app.js|calcUnifiedRecommendation': 'D',
  // each hands state.macroContext to calcUnifiedRecommendation only (their classification says so): D holds the callee
  // for every condition, so what they receive cannot move what they show
  'app.js|buildAIPrompt': 'D', 'app.js|openStockModal': 'D', 'app.js|renderPortfolioTab': 'D', 'app.js|renderSignalsTab': 'D', 'app.js|updateNavBadges': 'D',
  'app.js|computeScoreBreakdown': 'E',
};
run('the coverage cross-check: every consumer the inventory says could act on the condition is covered by a named test above', () => {
  const inv = readSource('tests/macro-consumers.test.js');
  const roles = Object.fromEntries([...inv.matchAll(/^\s*'([^']+\|[^']+)':\s*\['([A-Z_]+)'/gm)].map(m => [m[1], m[2]]));
  assert.ok(Object.keys(roles).length > 30, `read ${Object.keys(roles).length} classified consumers`);
  const mustCover = Object.keys(roles).filter(k => ['INERT_PINNED', 'PASS_THROUGH'].includes(roles[k])).concat(['app.js|runScreener', 'scripts/log-signals-edge.mjs|main']);
  const uncovered = mustCover.filter(k => !COVERED_BY[k]);
  assert.deepStrictEqual(uncovered, [], 'a consumer that could act on the condition with no test covering it');
  const stale = Object.keys(COVERED_BY).filter(k => !(k in roles));
  assert.deepStrictEqual(stale, [], 'a coverage entry whose consumer is no longer in the inventory');
  const self = readSource('tests/macro-observe-only.test.js');
  for (const [k, t] of Object.entries(COVERED_BY)) assert.ok(self.includes(`run('${t}. `), `${k}: covering test ${t} not found`);
  assert.strictEqual(Object.keys(COVERED_BY).length, 10, 'the coverage count is pinned: a change is a decision, made here');
});
