// tests/one-current-signal.test.js — 2026-10-28. AXTL's portfolio card read
// "SCORE AT PURCHASE 80 · SCORE NOW 70 (last scan)" while the recommendation
// beneath it said "Score improved from 80 → 85 (+20)" and returned HOLD
// STRONG: the card read ownedScores first, the verdict (and the stock modal)
// read state.signals first, so the advice rested on a score shown nowhere.
// Now one resolver, currentSignalForHolding, is the only reader, and its
// fallback carries every field the recommendation uses.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const grab = name => { const i = app.indexOf(`function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i) + 2); };
function load(stateOver) {
  global.SCORING_VERSION = 2;
  global.state = { ownedScores: {}, signals: [], lastScanTime: 1000, ...stateOver };
  // eslint-disable-next-line no-eval
  eval(grab('currentOwnedScore') + grab('currentSignalForHolding') + '\nglobal.__cur = currentSignalForHolding;');
}
const full = (score, extra = {}) => ({ ticker: 'AXTL', score, signal: 'SOFT BUY', volRatio: 1.4, maPct: 3.1, consUpDays: 2, catalystSetup: false, category: 'OTHER', bars: [{ c: 1 }], price: 1.9, ...extra });

run("AXTL's case: one score for card and verdict, the latest scan's", () => {
  load({
    ownedScores: { AXTL: { score: 70, label: 'SOFT BUY', scoringVersion: 2, scannedAt: 5000, signal: full(70) } },
    signals: [full(85)],
  });
  const r = global.__cur('AXTL');
  assert.strictEqual(r.score, 70, 'the held ticker\'s refreshed scan wins over a state.signals entry');
  assert.strictEqual(r.volRatio, 1.4, 'with every component the recommendation reads');
  assert.strictEqual(r.scannedAt, 5000);
});

run('a held ticker no scan has refreshed yet falls back to state.signals, whole', () => {
  load({ signals: [full(85)] });
  const r = global.__cur('AXTL');
  assert.deepStrictEqual({ score: r.score, maPct: r.maPct, scannedAt: r.scannedAt }, { score: 85, maPct: 3.1, scannedAt: 1000 });
});

run('a score-only entry (stored before 2026-10-28) is flagged, never silently missing its components', () => {
  load({ ownedScores: { AXTL: { score: 70, label: 'SOFT BUY', scoringVersion: 2 } }, signals: [full(85)] });
  const r = global.__cur('AXTL');
  assert.ok(r.scoreOnly && r.score === 70 && r.volRatio === undefined);
  assert.ok(grab('calcUnifiedRecommendation').includes("if (currentSignal?.scoreOnly) add('Volume, MA-distance and up-day factors not evaluated"), 'the verdict says the components were not evaluated');
});

run("another formula's stored score is not evaluated, and says so", () => {
  load({ ownedScores: { AXTL: { score: 70, label: 'x', scoringVersion: 1, signal: full(70) } }, signals: [full(85)] });
  const r = global.__cur('AXTL');
  assert.ok(r.notEvaluatedReason && r.score == null, 'never the v1 score, and never quietly the signals one either');
});

run('every reader goes through the resolver: card, modal, recommendations, badge, sale, exit alerts', () => {
  assert.ok(!/state\.signals\.find\([a-z]+ => [a-z]+\.ticker === [a-z.]+\) \|\| currentOwnedScore/.test(app), 'no "signals first, ownedScores second" reader left');
  assert.ok(!/s \|\| currentOwnedScore\(ticker\)/.test(app));
  assert.strictEqual((app.match(/const currentSignal = currentSignalForHolding\(/g) || []).length, 3, 'portfolio card verdict, sale fields, nav badge');
  assert.ok(app.includes('          currentSignalForHolding(ticker),\n          state.macroContext'), 'stock modal verdict');
  assert.ok(app.includes('const nowSig = currentSignalForHolding(p.ticker);'), 'portfolio card score');
  assert.ok(app.includes("const s = (held && !held.scoreOnly && !held.notEvaluatedReason) ? held : state.signals.find(x => x.ticker === ticker);"), 'stock modal score and breakdown');
  assert.ok(app.includes('const sig = currentSignalForHolding(p.ticker);'), 'afternoon exit alerts');
  const writes = app.match(/state\.ownedScores\[ticker\] = \{[^}]*\}/g);
  assert.strictEqual(writes.length, 2);
  for (const w of writes) assert.ok(w.includes('scannedAt: Date.now(), signal: s'), 'both scan writers store the full signal and its time');
});
