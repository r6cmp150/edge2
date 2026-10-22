// tests/score-components.test.js — core/edge-scoring.js's scoreComponents
// is THE EDGE score formula (phase-10 spec §7.7: when a change requires
// editing the same logic in two places, delete one of them).
//
// 1. Equivalence against the last commit before the refactor (1c39926):
//    scoreStock's full output, on every EDGE snapshot in the committed
//    signal_log backup and on generated inputs, must equal the old
//    scoreStock's except by expectedScoreDelta(). For the refactor that
//    delta is ZERO everywhere -- the refactor must prove it changes
//    nothing. Step 2 (spec §7.6) changes the score on purpose; when it
//    does, expectedScoreDelta is the one place that states exactly which
//    terms moved, and this test proves nothing else did.
// 2. Every reader agrees with the one formula: the score breakdown's rows,
//    rsi_pts capture, and the display text carries no performance claim.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const { readSource, run } = require('./_lib');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASE_COMMIT = '1c39926'; // last commit with the inline (pre-scoreComponents) formula

// How much the CURRENT score may differ from BASE_COMMIT's for the same
// input. The refactor: nothing.
// Scoring version 1: nothing. The 1d threshold refactor (scoreLabel, the
// per-version table) must change no score and no label. Phase-10 step 2
// replaces this with its two stated terms, computed from the OLD output's
// own inputs (RSI < 35: -10; price < 10: the sub-$10 bonuses, -10 at
// RSI < 45 / -5 at RSI 45-55, and -5 at vol < 1.5x).
function expectedScoreDelta(a) {
  let d = 0;
  if (a.rsi < 35) d -= 10;
  if (a.price < 10) {
    if (a.rsi < 45) d -= 10;
    else if (a.rsi >= 45 && a.rsi <= 55) d -= 5;
    if (a.volRatio < 1.5) d -= 5;
  }
  return d;
}

// The label lines of the version under test, stated independently of the
// code (spec §7.6 step 2). Version 1: SOFT 73, STRONG 116. Step 2 changes
// this to 65 / 110 in the same diff as the formula.
const DECIDED_LINES = { soft: 65, strong: 110 };

const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');
function context(scoringSrc) {
  const c = { console, Math, Date, JSON, Number, String, Array, Object, Infinity, NaN, isFinite, state: { settings: {}, macroContext: null } };
  vm.createContext(c);
  for (const f of ['core/indicators.js', 'core/market-data.js']) vm.runInContext(strip(readSource(f)), c);
  vm.runInContext(strip(scoringSrc) + '\n;globalThis.__scoreStock = scoreStock; globalThis.__scoreComponents = typeof scoreComponents === "function" ? scoreComponents : null;', c);
  return c;
}

let OLD = null;
try {
  OLD = context(execSync(`git show ${BASE_COMMIT}:core/edge-scoring.js`, { cwd: REPO_ROOT, maxBuffer: 1e8 }).toString());
} catch (e) {
  console.log(`SKIP equivalence: cannot read ${BASE_COMMIT} from git (${e.message.split('\n')[0]})`);
}
const NEW = context(readSource('core/edge-scoring.js'));

function compare(args, macro, disable) {
  for (const c of [OLD, NEW]) {
    c.state.macroContext = macro ? { condition: macro, changes: null } : null;
    c.state.settings.disableMacroOverlay = disable;
  }
  const a = OLD.__scoreStock(...args), b = NEW.__scoreStock(...args);
  if (a === null || b === null) { assert.strictEqual(a, b, `${args[0]}: null-ness differs`); return; }
  const delta = expectedScoreDelta(a);
  assert.strictEqual(b.score, Math.max(0, a.score + delta), `${args[0]}: score ${a.score} -> ${b.score}, expected delta ${delta}`);
  // Only the fields step 2 moves may differ: the score (by exactly the stated
  // delta), the sub-$10 component it came from, and the label. The label
  // moves even when the score doesn't, because step 2 moved the lines too.
  // Everything else must match exactly, and the new label must be the one
  // the DECIDED version-2 lines give (spec §7.6 step 2: SOFT 65, STRONG 110,
  // all >=), stated here independently of the code under test.
  const rest = o => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !['score', 'sub10Pts', 'signal'].includes(k))));
  assert.strictEqual(rest(b), rest(a), `${args[0]}: a field outside step 2's stated changes differs`);
  const label = b.score >= DECIDED_LINES.strong ? 'STRONG BUY' : b.score >= DECIDED_LINES.soft ? 'SOFT BUY' : 'WATCH';
  assert.strictEqual(b.signal, label, `${args[0]}: score ${b.score} labelled ${b.signal}, the decided lines say ${label}`);
  if (delta === 0 && DECIDED_LINES.soft === 73 && DECIDED_LINES.strong === 116) assert.strictEqual(JSON.stringify(b), JSON.stringify(a), `${args[0]}: full scoreStock output differs under version 1`);
}

const CONDS = [null, 'RISK_OFF', 'BROAD_RALLY', 'CHOPPY', 'MOMENTUM_DAY', 'TECH_ROTATION_OUT'];

run('score formula: scoreStock identical to pre-refactor on every committed EDGE snapshot', () => {
  if (!OLD) return;
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/backups/signal_log.json'), 'utf8'));
  const rows = (Array.isArray(raw) ? raw : raw.rows).filter(r => r.engine_source === 'EDGE' && r.signal_snapshot?.bars?.length);
  assert.ok(rows.length > 100, `expected the committed signal_log backup to hold real EDGE snapshots, found ${rows.length}`);
  for (const r of rows) {
    const o = r.signal_snapshot;
    const snap = { latestTrade: { p: o.price }, dailyBar: { c: o.price, v: o.volume }, prevDailyBar: { c: o.prevClose } };
    for (const m of CONDS) compare([o.ticker, snap, o.bars, o.news || null, o.spyChange || 0, o.category || null], m, false);
  }
  console.log(`  ${rows.length} real snapshots x ${CONDS.length} macro conditions`);
});

run('score formula: scoreStock identical to pre-refactor on 10,000 generated inputs', () => {
  if (!OLD) return;
  let seed = 20261021;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const cats = [null, 'OTHER', 'TECH', 'ENERGY', 'CRYPTO'];
  const now = Date.now();
  for (let i = 0; i < 10000; i++) {
    const len = 15 + Math.floor(rnd() * 110);
    let p = 0.5 + rnd() * 30;
    const vol0 = 1e4 + rnd() * 5e6, bars = [], t0 = Date.UTC(2026, 0, 1);
    for (let k = 0; k < len; k++) {
      const o = p;
      p = Math.max(0.05, p * (1 + (rnd() - 0.5) * (rnd() < 0.1 ? 0.4 : 0.08)));
      bars.push({ t: new Date(t0 + k * 864e5).toISOString(), o, h: Math.max(o, p) * (1 + rnd() * 0.03), l: Math.min(o, p) * (1 - rnd() * 0.03), c: p, v: Math.floor(vol0 * (0.2 + rnd() * (rnd() < 0.1 ? 8 : 2))) });
    }
    const price = p * (1 + (rnd() - 0.5) * 0.15);
    const snap = { latestTrade: { p: price }, dailyBar: { c: price, v: Math.floor(vol0 * rnd() * 6) }, prevDailyBar: { c: rnd() < 0.05 ? undefined : bars[len - 1].c } };
    const news = rnd() < 0.2 ? { headline: rnd() < 0.5 ? 'Company faces lawsuit' : 'Company launches product', created_at: new Date(now - rnd() * 2e8).toISOString() } : null;
    compare(['T' + i, snap, bars, news, (rnd() - 0.5) * 6, cats[i % cats.length]], CONDS[i % CONDS.length], rnd() < 0.2);
  }
});

run('score formula: the breakdown and rsi_pts read scoreComponents, and nothing else carries buckets', () => {
  const app = readSource('app.js');
  assert.ok(!/function derive(VolSpike|PriceMomentum|Rsi)Pts/.test(app), 'the hand-synced derive*Pts copies are gone');
  const bd = app.match(/function computeScoreBreakdown\(s\) \{[\s\S]*?\n\}/)[0];
  assert.ok(/scoreComponents\(/.test(bd), 'computeScoreBreakdown calls scoreComponents');
  assert.ok(!/>= 55 && |volRatio >= 3|\+= 10;/.test(bd), 'no bucket boundaries or point values inside computeScoreBreakdown');
  assert.ok(/rsiPts:\s+sigComps && sig\.rsi != null \? sigComps\.rsiPts : null/.test(app), 'rsi_pts captured from scoreComponents');
});

run('score formula: breakdown rows equal scoreComponents, total equals scoreStock', () => {
  // Load the real breakdown function out of app.js against the NEW scorer.
  const app = readSource('app.js');
  const pick = re => app.match(re)[0];
  const src = [
    pick(/const RSI_BAND_DESCRIPTIONS = \{[\s\S]*?\n\};/),
    pick(/const VOL_BAND_DESCRIPTIONS = \{[\s\S]*?\n\};/),
    pick(/function rsiBandDescription\(rsi\) \{[\s\S]*?\n\}/),
    pick(/function computeScoreBreakdown\(s\) \{[\s\S]*?\n\}/),
  ].join('\n');
  const c = NEW;
  c.formatMacroConditionDetail = () => '';
  vm.runInContext(src + '\n;globalThis.__bd = computeScoreBreakdown; globalThis.__VOL = VOL_BAND_DESCRIPTIONS;', c);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 5000; i++) {
    const s = {
      ticker: 'X', volRatio: rnd() * 5, todayChange: (rnd() - 0.4) * 12, rsi: rnd() * 100, price: 0.5 + rnd() * 25,
      ma20: 0.5 + rnd() * 25, volBuild: rnd() < 0.3, meanReversion: rnd() < 0.1, catalystSetup: rnd() < 0.1,
      consUpDays: Math.floor(rnd() * 6), rsVsSPY: (rnd() - 0.5) * 6, spyChange: 0, macroCondition: null,
    };
    const comps = c.__scoreComponents(s);
    const { rows, total } = c.__bd(s);
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.pts]));
    assert.strictEqual(byKey.rsi, comps.rsiPts);
    assert.strictEqual(byKey.vol, comps.volPts);
    assert.ok(rows.find(r => r.key === 'vol').label.endsWith('— ' + c.__VOL[comps.volBucket]), 'volume note is the factual band for the scored bucket');
    assert.strictEqual(byKey.sub10, comps.sub10Pts ?? undefined, 'sub10 row present exactly when the component exists');
    assert.strictEqual(total, Math.max(0, comps.raw), 'breakdown total = the formula total');
  }
});

// Spec §7.3: text Roman reads at the moment of buying must not assert
// performance the data contradicts.
run('score formula: no evaluative RSI or volume copy left in the display', () => {
  // Code only: the comments that record what the old copy said are allowed.
  const app = readSource('app.js').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  for (const phrase of ['Sweet spot', 'potential bounce setup', 'Oversold bounce setup', 'Neutral-bullish — solid performer', 'Bullish momentum',
    // Volume (2026-10-21): the breakdown notes and the exit engine's labels.
    'best win-rate zone', 'strong historical performer', 'late entry risk', 'moderate signal', 'insufficient liquidity signal',
    'Quiet accumulation', 'Healthy volume', 'Volume fading',
    // Exit-engine RSI labels (2026-10-22): missed while this check was case-sensitive.
    'sweet spot', 'neutral-bullish']) {
    // Case-insensitive: "Sweet spot" was banned while "RSI in sweet spot" stayed on screen.
    assert.ok(!app.toLowerCase().includes(phrase.toLowerCase()), `withdrawn claim still displayed: "${phrase}"`);
  }
});

// Formula identity (spec §7.6 step 1d, db/028). SCORING_HASH must equal the
// hash of the formula's own source, and SCORING_VERSION must map to it in
// the pinned history. Changing a term without both failing here is
// impossible: a new formula gets a new hash, and a new hash needs a new
// version. Version 1 is the REFACTORED source (scoreLabel and the threshold
// table added; every score and label identical to b63ef1b's, which the
// equivalence tests above prove against the old commit). No row was ever
// stamped with b63ef1b's own hash, so nothing refers to it.
const SCORING_HISTORY = {
  1: 'ce367ebf81eb4741a52f6b845b1ddada7962e450bdba892f3282e82ffb54ab86', // b63ef1b's formula via scoreLabel (1d)
  2: '8e10b278942271cdfb1944320de39b969a4585748edf9130c294545a9e7515e2', // phase-10 step 2
};
run('scoring identity: SCORING_HASH matches the source, and the version history is pinned', async () => {
  const { scoringHash } = await import('../scripts/lib/scoring-hash.mjs');
  const src = readSource('core/edge-scoring.js');
  const version = Number(src.match(/^const SCORING_VERSION = (\d+);/m)[1]);
  const hash = src.match(/^const SCORING_HASH = '([0-9a-f]{64})';/m)[1];
  assert.strictEqual(scoringHash(src), hash, 'the formula changed: recompute SCORING_HASH and give it a NEW SCORING_VERSION');
  assert.strictEqual(SCORING_HISTORY[version], hash, `SCORING_VERSION ${version} is pinned to a different formula; a new formula is a new version`);
  assert.strictEqual(new Set(Object.values(SCORING_HISTORY)).size, Object.keys(SCORING_HISTORY).length, 'two versions share a hash');
  // every pinned version has label thresholds
  const table = src.match(/const SCORE_THRESHOLDS_BY_VERSION = \{([\s\S]*?)\n\};/)[1];
  for (const v of Object.keys(SCORING_HISTORY)) assert.ok(new RegExp(String.raw`\n\s*${v}: \{ watch: \d+, soft: \d+, strong: \d+ \}`).test(table), `no thresholds for version ${v}`);
});

run('exit cutoffs: version-1 thresholds reproduce the old literals 116 / 94 / 73 / 44 exactly', () => {
  const app = readSource('app.js');
  const start = app.indexOf('const t = scoreThresholds();');
  assert.ok(start >= 0, 'exit cutoff block found');
  const block = app.slice(start, app.indexOf('else add(', start));
  for (const expr of ['nowScore >= t.strong', 'nowScore >= Math.floor((t.strong + t.soft) / 2)', 'nowScore >= t.soft', 'nowScore >= Math.ceil(0.6 * t.soft)']) {
    assert.ok(block.includes(expr), `cutoff expression missing: ${expr}`);
  }
  const v1 = { soft: 73, strong: 116 }, v2 = { soft: 65, strong: 110 };
  assert.deepStrictEqual([v1.strong, Math.floor((v1.strong + v1.soft) / 2), v1.soft, Math.ceil(0.6 * v1.soft)], [116, 94, 73, 44]);
  assert.deepStrictEqual([v2.strong, Math.floor((v2.strong + v2.soft) / 2), v2.soft, Math.ceil(0.6 * v2.soft)], [110, 87, 65, 39]);
  assert.ok(!block.includes('nowScore > t.strong'), 'top cutoff is >=, not > (step 2 decision)');
});
