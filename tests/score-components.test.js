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
function expectedScoreDelta(/* inputs */) { return 0; }

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
  if (delta === 0) assert.strictEqual(JSON.stringify(b), JSON.stringify(a), `${args[0]}: full scoreStock output differs`);
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
    'Quiet accumulation', 'Healthy volume', 'Volume fading']) {
    assert.ok(!app.includes(phrase), `withdrawn claim still displayed: "${phrase}"`);
  }
});
