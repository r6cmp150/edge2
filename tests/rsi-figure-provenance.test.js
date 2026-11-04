// tests/rsi-figure-provenance.test.js — 2026-11-03. The report's "RSI points"
// buckets filed scoring-v2 trades with RSI <35 under "Got 0 (RSI 65-75)". Did
// any RSI-band figure in the specs come from them? No: every one recomputes
// from the RSI value of each pinned row (scripts/audit-rsi-figures.mjs). This
// holds both directions: the figures still come out of the raw RSI, and the
// mislabelled bucket really does hold what was claimed, so "the figures differ
// from the buckets" keeps meaning something.
//
// Average returns may differ from the spec by 0.01: §1 and §3.5 were first
// parsed from the report's 2-decimal text, these use the stored values. n, win
// rate and dollars must match exactly.
//
// A guard on claims, not code. When a figure is added to a spec, add it here.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 0.0101, `${label}: ${a} vs the spec's ${b}`);
const same = (s, n, win, avg, pnl, label) => {
  assert.strictEqual(s.n, n, `${label} n`); assert.strictEqual(s.winPct, win, `${label} win`);
  near(s.avgPct, avg, `${label} avg`); assert.strictEqual(s.pnl, pnl, `${label} pnl`);
};

run('§1, §2, §3, §3.5: the history figures come from rsi_at_buy at the 10-21 pin', async () => {
  const { historyFigures } = await import('../scripts/audit-rsi-figures.mjs');
  const h = historyFigures();
  assert.strictEqual(h.rows, 270); assert.strictEqual(h.regular, 215);
  same(h.regularBands['<35'], 51, 54.9, -1.07, -123, '<35');
  same(h.regularBands['35-45'], 55, 45.5, -1.28, -250, '35-45');
  same(h.regularBands['45-50'], 22, 68.2, 1.16, 150, '45-50');
  same(h.regularBands['50-55'], 24, 87.5, 1.09, 107, '50-55');
  same(h.regularBands['55-65'], 46, 58.7, -0.95, -218, '55-65');
  same(h.regularBands['65+'], 17, 52.9, -0.71, -35, '65+');
  same(h.all['45-55'], 55, 72.7, 0.86, 242, 'all 45-55');
  assert.strictEqual(h.all['not 45-55'].winPct, 50.7); assert.strictEqual(h.all['not 45-55'].pnl, -926);
  assert.strictEqual(h.all['<30'].n, 41); near(h.all['<30'].avgPct, -2.10, '<30'); assert.strictEqual(h.all['<30'].pnl, -211);
  same(h.all['42-58'], 97, 69.1, 0.26, 220, '42-58');
  same(h.timeCells['7:30-10:00 45-55'], 21, 81, 1.68, 222, 'best cell');
  assert.strictEqual(h.timeCells['open-7:30 45-55'].winPct, 72.7); near(h.timeCells['open-7:30 45-55'].avgPct, -0.35, 'open');
  assert.strictEqual(h.timeCells['10:00+ 45-55'].winPct, 78.6); near(h.timeCells['10:00+ 45-55'].avgPct, 1.46, '10+');
});

run('§1, §7.3, §7.6: forward against history, "63% against 73%", from rsi_at_buy at 0775407', async () => {
  const { forwardFigures } = await import('../scripts/audit-rsi-figures.mjs');
  const f = forwardFigures();
  assert.strictEqual(f.forward, 64); assert.strictEqual(f.history, 270);
  assert.strictEqual(f.bands['45-55'].forward.n, 19); assert.strictEqual(Math.round(f.bands['45-55'].forward.winPct), 63); near(f.bands['45-55'].forward.avgPct, 0.48, 'fwd 45-55');
  assert.strictEqual(f.bands['45-55'].history.n, 55); assert.strictEqual(Math.round(f.bands['45-55'].history.winPct), 73); near(f.bands['45-55'].history.avgPct, 0.86, 'hist 45-55');
  assert.strictEqual(f.bands['55-65'].forward.n, 18); assert.strictEqual(Math.round(f.bands['55-65'].forward.winPct), 83); near(f.bands['55-65'].forward.avgPct, 1.43, 'fwd 55-65');
  assert.strictEqual(Math.round(f.bands['55-65'].history.winPct), 54); near(f.bands['55-65'].history.avgPct, -1.41, 'hist 55-65');
  assert.strictEqual(f.bands['35-45'].forward.n, 19); assert.strictEqual(Math.round(f.bands['35-45'].forward.winPct), 74); near(f.bands['35-45'].forward.avgPct, 1.17, 'fwd 35-45');
  assert.strictEqual(f.bands['<35'].forward.n, 6); assert.strictEqual(f.bands['<35'].history.n, 72);
});

run('§7.2: "-0.04 points at 30 minutes" and its table come from each signal\'s own RSI at the 10-21 pin', async () => {
  const { signalLogFigures } = await import('../scripts/audit-rsi-figures.mjs');
  const s = signalLogFigures('80f52fb');
  assert.strictEqual(s.rows, 664); assert.strictEqual(s.dates, 18);
  const row = (h, excess, won, of) => { near(s.horizons[h].excess, excess, h); assert.strictEqual(s.horizons[h].datesWon, won, `${h} won`); assert.strictEqual(s.horizons[h].datesCompared, of, `${h} of`); };
  row('ret_30m', -0.04, 9, 18); row('ret_close', -0.04, 9, 18); row('ret_1d', 0.58, 9, 17); row('ret_3d', 1.23, 11, 15);
  assert.ok(s.bands['<42 ret_1d'] <= -0.55 && s.bands['<42 ret_1d'] >= -0.85, `<42 +1d ${s.bands['<42 ret_1d']}`);
  assert.ok(s.bands['<42 ret_3d'] <= -0.55 && s.bands['<42 ret_3d'] >= -0.85, `<42 +3d ${s.bands['<42 ret_3d']}`);
  near(s.bands['58-65 ret_1d'], 1.02, '58-65 +1d');
  // The same claim at the later pin: outcomes filled in, so §7.2 quotes its pin in the sentence.
  const later = signalLogFigures('d6e277d');
  assert.strictEqual(later.rows, 676); near(later.horizons.ret_30m.excess, -0.04, 'd6e277d 30m'); near(later.horizons.ret_close.excess, -0.04, 'd6e277d close');
  near(later.horizons.ret_3d.excess, 1.59, 'd6e277d +3d'); assert.strictEqual(later.horizons.ret_3d.datesWon, 14);
});

run('the other direction: the report buckets could not have given these, and the mislabelled one holds what was claimed', async () => {
  const { forwardFigures } = await import('../scripts/audit-rsi-figures.mjs');
  const b = forwardFigures().reportBuckets;
  assert.strictEqual(b[0].n, 8, '"Got 0 (RSI 65-75)": 8 trades');
  assert.strictEqual(b[0].underRsi35, 6, '6 of them RSI <35, the false legend');
  assert.strictEqual(b[0].rsiMin, 15);
  assert.strictEqual(b[15].n, 38, 'the bucket spans 35-55: 45-55 cannot be read from it');
  assert.ok(b[15].rsiMin < 45 && b[15].rsiMax >= 54.9);
  // The buckets' edges are 35, 55, 65, 75. The quoted bands' 45 and 58 are not among them.
  const app = readSource('app.js');
  const i = app.indexOf('const rsiPtsBlock');
  const block = app.slice(i, app.indexOf('`;', i));
  assert.ok(/RSI 35-55/.test(block) && /RSI 55-65/.test(block) && !/\b45\b/.test(block) && !/\b58\b/.test(block), block);
});
