// tests/macro-consumers.test.js — 2026-11-02. The macro condition is
// observe-only for the measurement period, and its channels were found one
// at a time: the score adjustment, the display cut, then the AI prompts.
// This lists EVERY consumer (anything that reads the condition, displays it,
// passes it on or branches on it) by file and enclosing function, with what
// it does, and fails when a consumer appears unclassified or a
// classification's consumer is gone. No role means "acts on it": a consumer
// that would let the condition change a score, the display cut, what's shown
// or text Roman reads can't be classified here at all.
//
// Roles:
//   OBSERVE          fetches, classifies or records the condition now
//   DISPLAY          states it to Roman as information (the banner) — the ONE place
//   RECORD           copies it into a stored row / maps a stored row
//   HISTORY          reports conditions already stored (past trades, archives)
//   COUNTERFACTUAL   computes what WOULD have applied; never used to filter or score
//   INERT_PINNED     a branch that would act, unreachable: gated on the pinned
//                    disableMacroOverlay (tests/macro-observe-only.test.js)
//   PASS_THROUGH     hands state.macroContext to an INERT_PINNED consumer only
//   DEFINITION       a table or constant the above read
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSource, run, REPO_ROOT } = require('./_lib');

const ID = /\b(macroContext|macroCondition|macro_condition|macroConditionAtBuy|macro_condition_at_buy|macroChanges|getMacroAdjustment|MACRO_ADJUSTMENTS|wouldBeDisplayThreshold|BROAD_ELEVATED_CONDITIONS|MACRO_TAILWIND_CONDITIONS|SECTOR_WEAKNESS_THRESHOLD_CATEGORIES|SECTOR_WEAKNESS_DISPLAY_NAME|macroAdjustment|macroPath|macro_path|macroPathAtBuy|macro_path_at_buy|MACRO_INTERPRETATIONS|macroObservationId|macro_observation_id|macro_observations|macroGroqLast|observeMacro|classifyMacroCondition)\b/;

const REGISTRY = {
  'app.js|state':                           ['OBSERVE', 'state.macroContext starts null (no reading yet)'],
  'app.js|loadState':                       ['RECORD', 'macroGroqLast (the day\'s last Groq answer) persisted across reloads'],
  'app.js|MACRO_REQUIRED_ETFS':             ['DEFINITION', 'the ETFs classifyMacroCondition needs'],
  'app.js|MACRO_INTERPRETATIONS':           ['DEFINITION', 'plain-language text per condition, read by the banner'],
  'app.js|classifyMacroCondition':          ['OBSERVE', 'the deterministic pattern rule'],
  'app.js|macroWouldAdjust':                ['COUNTERFACTUAL', 'per-category score and cut that WOULD have applied; stored in macro_observations.would_adjust, applied CHECKed false'],
  'app.js|observeMacro':                    ['OBSERVE', 'one observation per scan: moves, both answers, path, cut, counterfactual; writes macro_observations'],
  'app.js|SECTOR_WEAKNESS_THRESHOLD_CATEGORIES': ['DEFINITION', 'the old raise rule, read only by wouldBeDisplayThreshold'],
  'app.js|BROAD_ELEVATED_CONDITIONS':       ['DEFINITION', 'the old raise rule, read by wouldBeDisplayThreshold and the pinned exit branch'],
  'app.js|wouldBeDisplayThreshold':         ['COUNTERFACTUAL', 'the old cut rule; never filters'],
  'app.js|SECTOR_WEAKNESS_DISPLAY_NAME':    ['DEFINITION', 'sector names (no live reader after the banner rewrite is allowed to filter on it)'],
  'app.js|buildMacroBanner':                ['DISPLAY', 'the banner: the single place the condition is stated'],
  'app.js|buildAIPrompt':                   ['PASS_THROUGH', 'passes state.macroContext to calcUnifiedRecommendation for the held-position block; the prompt text itself carries no market state'],
  'app.js|runScreener':                     ['OBSERVE', 'calls observeMacro each scan; stamps macroPath / macroObservationId / the base cut on each signal'],
  'app.js|writeRatingSnapshots':            ['RECORD', 'macro_condition, macro_path, display_threshold, macro_observation_id, tier on each row'],
  // CHANGED 2026-11-13, declared: the containment of an off-list snapshot row names the row's macro PATH on the banner.
  'app.js|updateMarketBanner':              ['RECORD', 'names a set-aside snapshot row and its macro path (a record that failed); never the condition, never a decision'],
  'app.js|renderSignalsTab':                ['PASS_THROUGH', 'calcUnifiedRecommendation for the held-position SELL badge'],
  'app.js|computeScoreBreakdown':           ['INERT_PINNED', 'shows the macro row with the score\'s macroAdjustment, which the pin holds at 0'],
  'app.js|openStockModal':                  ['PASS_THROUGH', 'calcUnifiedRecommendation for the modal\'s held-position block'],
  'app.js|finalizeAddPortfolio':            ['RECORD', 'copies the signal\'s condition, path, cut and adjustment onto the new position'],
  'app.js|renderPortfolioTab':              ['PASS_THROUGH', 'calcUnifiedRecommendation for each card'],
  'app.js|macroConditionForRecord':         ['RECORD', 'the condition on a captured card (Verdict A), for the audit; nothing reads it back into a decision'],
  'app.js|MACRO_TAILWIND_CONDITIONS':       ['DEFINITION', 'read only by the pinned exit branch'],
  'app.js|calcUnifiedRecommendation':       ['INERT_PINNED', 'its macro factor (+/-20) runs only when !disableMacroOverlay, which is pinned true'],
  'app.js|writeTradeToSupabase':            ['RECORD', 'macro_condition and macro_path at buy, copied to trades_v2 at sale'],
  'app.js|confirmMarkSold':                 ['RECORD', 'copies the position\'s condition and path into the sale record'],
  'app.js|mapTradesV2ToSoldShape':          ['RECORD', 'maps a stored trades_v2 row back'],
  'app.js|macroObservationsControl':        ['HISTORY', 'the positive control behind an empty macro read: reads the session id and rating_snapshots, never the condition'],
  'app.js|fetchMacroObservationsForReport': ['HISTORY', 'reads stored observations for the report; a read error is said, never shown as "none"'],
  'app.js|buildMacroObservationSection':    ['HISTORY', 'the report\'s per-day record: condition, path, both answers, cut, Groq failure rate, test progress'],
  'app.js|generateClaudeReport':            ['HISTORY', 'win rate by the condition stored at buy, for past trades'],
  'app.js|buildSupabaseArchiveReport':      ['HISTORY', 'the same, in the archive report'],
  'app.js|updateNavBadges':                 ['PASS_THROUGH', 'calcUnifiedRecommendation for the Portfolio badge count'],
  'core/edge-scoring.js|MACRO_ADJUSTMENTS': ['DEFINITION', 'the adjustment table (hashed source, scoring v2)'],
  'core/edge-scoring.js|getMacroAdjustment':['DEFINITION', 'the table lookup'],
  'core/edge-scoring.js|scoreStock':        ['INERT_PINNED', 'macroAdjustment = disableMacroOverlay ? 0 : ...; the pin holds it at 0; stores the condition and moves on the signal'],
  'core/store.js|mapSupabasePortfolioRowToPosition': ['RECORD', 'portfolio row -> position'],
  'core/store.js|mapPositionToSupabaseRow': ['RECORD', 'position -> portfolio row'],
  // CHANGED 2026-11-12, declared (carve of (c)): main's storage tiers (change 4a, 11-08) now name macroGroqLast.
  'core/store.js|PERSIST_TIER':             ['DEFINITION', 'the storage tier of the macroGroqLast key (3); reads no condition and decides nothing about one'],
  'scripts/log-signals-edge.mjs|main':      ['RECORD', 'stamps macroPath not_fetched; scores with no macro context (base cut), pinned'],
};
const ROLES = new Set(['OBSERVE', 'DISPLAY', 'RECORD', 'HISTORY', 'COUNTERFACTUAL', 'INERT_PINNED', 'PASS_THROUGH', 'DEFINITION']);

const list = (dir, re) => fs.readdirSync(path.join(REPO_ROOT, dir)).filter(f => re.test(f)).map(f => `${dir}/${f}`);
function consumers() {
  const files = ['app.js', ...list('core', /\.js$/), ...list('shell', /\.js$/),
    ...fs.readdirSync(path.join(REPO_ROOT, 'engines')).flatMap(d => list(`engines/${d}`, /\.js$/)), 'scripts/log-signals-edge.mjs'];
  const out = new Map();
  for (const f of files) {
    let owner = '(top level)';
    readSource(f).split('\n').forEach(l => {
      const m = l.match(/^(?:export )?(?:async )?function ([A-Za-z0-9_$]+)\(|^(?:export )?(?:const|let|var) ([A-Za-z0-9_$]+) = /);
      if (m) owner = m[1] || m[2];
      if (/^\s*\/\//.test(l)) return;
      if (ID.test(l)) out.set(`${f}|${owner}`, true);
    });
  }
  return [...out.keys()];
}

run('enumeration finds the known consumers (a blind enumerator would pass everything)', () => {
  const c = new Set(consumers());
  for (const k of ['app.js|buildMacroBanner', 'core/edge-scoring.js|scoreStock', 'app.js|calcUnifiedRecommendation', 'app.js|observeMacro', 'app.js|writeRatingSnapshots'])
    assert.ok(c.has(k), `missing ${k}`);
});

run('every consumer of the macro condition is classified, and every classification still has its consumer', () => {
  const found = new Set(consumers());
  const unclassified = [...found].filter(k => !REGISTRY[k]);
  const stale = Object.keys(REGISTRY).filter(k => !found.has(k));
  assert.deepStrictEqual({ unclassified, stale }, { unclassified: [], stale: [] },
    'a new consumer must be classified here (and must not act on the condition during the measurement period); a stale entry must go');
  for (const [k, [role, what]] of Object.entries(REGISTRY)) assert.ok(ROLES.has(role) && what, `${k}: role ${role}`);
});

run('the banner is the ONE place the condition is stated; no AI prompt carries market state', () => {
  const display = Object.entries(REGISTRY).filter(([, [r]]) => r === 'DISPLAY').map(([k]) => k);
  assert.deepStrictEqual(display, ['app.js|buildMacroBanner']);
  const app = readSource('app.js');
  const body = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); return app.slice(i, app.indexOf('\n}\n', i)); };
  for (const fn of ['buildAIPrompt', 'buildPreMarketGroqPrompt']) {
    const src = body(fn).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/macroContext\??\.(condition|changes|explanation)|MACRO_INTERPRETATIONS|SPY today|SPY pre-market|macro condition:/i.test(src), `${fn} carries market state`);
    assert.ok(src.includes('${AI_NO_MARKET_STATE_LINE}'), `${fn} tells the model no market state is given`);
  }
  assert.ok((app.match(/\$\{AI_NOT_CONDITIONED_LABEL\}/g) || []).length >= 2 && /AI_NOT_CONDITIONED_LABEL\.replace/.test(app), 'every AI result is labelled');
  // PASS_THROUGH consumers may only hand macroContext to calcUnifiedRecommendation.
  for (const [k, [role]] of Object.entries(REGISTRY)) {
    if (role !== 'PASS_THROUGH') continue;
    const fn = k.split('|')[1];
    // every reference must sit INSIDE a calcUnifiedRecommendation(...) call
    const src = body(fn).split('\n').map(l => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
    const spans = [];
    for (const m of src.matchAll(/calcUnifiedRecommendation\(/g)) {
      let depth = 1, j = m.index + m[0].length;
      while (j < src.length && depth) { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++; }
      spans.push([m.index, j]);
    }
    const refs = [...src.matchAll(/macroContext/g)].map(m => m.index);
    assert.ok(refs.length, `${fn}: classified PASS_THROUGH but has no reference`);
    const outside = refs.filter(i => !spans.some(([a, b]) => i > a && i < b));
    assert.deepStrictEqual(outside.map(i => src.slice(Math.max(0, i - 40), i + 20)), [], `${fn}: macroContext used outside a calcUnifiedRecommendation call`);
  }
});
