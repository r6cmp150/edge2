// tests/held-score-prune.test.js -- 2026-11-17, P1 shape A (the reviewer: "Prune only. Keep the bars on the record,
// and keep signal_before_sale as it is"). Roman's phone storage was 99.4% full, 62.7% of it edge_ownedScores: one
// record per ticker ever held at a scan, never deleted. From this build each scan keeps only tickers with an open
// position or a pending order, names what it deleted, and the records keep their bars (so a sale's stored
// signal_before_sale is unchanged). With it, a defect of its own found on the way: deriveVolumeTrend answered 'flat'
// for fewer than 3 bars (the seventh fabricated neutral). Run for real here: the app's own functions, in a vm.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const grab = n => { const i = app.search(new RegExp(`^(async )?function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n}\n', i) + 3); };

function ctxWith(state) {
  const c = { Math, JSON, Set, Intl, console, String, Number, Object, Array, Date, state, SCORING_VERSION: 2 };
  vm.createContext(c);
  vm.runInContext(readSource('core/clock.js'), c);
  vm.runInContext(['heldScoreKeepSet', 'pruneHeldScores', 'currentOwnedScore', 'currentSignalForHolding', 'signalBeforeSale', 'deriveVolumeTrend'].map(grab).join('\n')
    + ';globalThis.__prune = pruneHeldScores; globalThis.__keep = heldScoreKeepSet; globalThis.__held = currentSignalForHolding; globalThis.__sbs = signalBeforeSale; globalThis.__vt = deriveVolumeTrend;', c);
  return c;
}
const bars = n => Array.from({ length: n }, (_, i) => ({ t: `2026-11-${String(i + 1).padStart(2, '0')}`, c: 10 + i, v: 1000 + i }));
const rec = (t, at) => ({ score: 70, label: 'BUY', scoringVersion: 2, scannedAt: at, signal: { ticker: t, score: 70, signal: 'BUY', bars: bars(125) } });

run('the prune keeps open positions and pending orders, deletes every other entry, and names each one it deleted', () => {
  const owned = { AAA: rec('AAA', 1), OLD1: rec('OLD1', 1), PEND: rec('PEND', 1), OLD2: rec('OLD2', 1) };
  const c = ctxWith({});
  const r = JSON.parse(JSON.stringify(c.__prune(owned, ['AAA', 'PEND', 'AAA'])));
  assert.deepStrictEqual(r, { pruned: ['OLD1', 'OLD2'], kept: 2 });
  assert.deepStrictEqual(Object.keys(owned).sort(), ['AAA', 'PEND']);
  assert.strictEqual(owned.AAA.signal.bars.length, 125, 'shape A: a kept record keeps its bars');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c.__prune(owned, ['AAA', 'PEND']))), { pruned: [], kept: 2 }, 'nothing to prune: an empty list, still reported');
});

run('it runs at scan time, after both of the scan\'s writes and before the cache is saved, over holdings plus pending orders', () => {
  const i = app.indexOf('async function runScreener(');
  const body = app.slice(i, app.indexOf('\n}\n', i));
  const writes = [...body.matchAll(/state\.ownedScores\[ticker\] = \{ score: s\.score, label: s\.signal, scoringVersion: SCORING_VERSION, scannedAt: Date\.now\(\), signal: s \};/g)].map(m => m.index);
  assert.strictEqual(writes.length, 2, 'the main scan and the owned-ticker top-up both write the whole signal (bars kept: shape A)');
  const prune = body.indexOf('const keepSet = await heldScoreKeepSet(state.portfolioLoad, [...getHoldings(), ...getPendingOrders()],');
  assert.ok(body.includes('state.heldScorePrune = keepSet.keep ? pruneHeldScores(state.ownedScores, keepSet.keep) : { notPruned: keepSet.notEstablished };'), 'prunes only on an established keep-set');
  const save = body.indexOf("persist('ownedScores')");
  assert.ok(prune > Math.max(...writes) && prune < save, 'after both writes, before the save');
  assert.ok(/console\.info\(`held-score cache: pruned/.test(body.slice(prune, save)), 'the prune is logged when it deletes anything');
});

run('a run of scans: buy, scan, sell (the sale keeps its signal, bars and all), scan prunes it, re-buy, scan writes it again', () => {
  const state = { ownedScores: {}, signals: [] };
  const c = ctxWith(state);
  const at = Date.parse('2026-11-16T17:00:00Z');
  state.ownedScores.XYZ = rec('XYZ', at);                    // scan 1 while held
  const pos = { ticker: 'XYZ', engineSource: 'EDGE' };
  assert.strictEqual(c.__held('XYZ').score, 70, 'held: its record is read');
  const sale = c.__sbs(pos, '2026-11-17', Date.parse('2026-11-17T17:00:00Z')); // the sale record is built while the position exists
  assert.strictEqual(sale.state, 'PREDATES_SALE');
  assert.strictEqual(sale.signal.bars.length, 125, 'signal_before_sale keeps the bars, as before P1');
  const r = c.__prune(state.ownedScores, []);                 // scan 2: no longer held
  assert.deepStrictEqual([...r.pruned], ['XYZ']);
  assert.strictEqual(sale.signal.bars.length, 125, 'the stored sale record is untouched by the prune');
  assert.strictEqual(c.__held('XYZ'), null, 'not held, no entry: nothing stale is offered');
  state.ownedScores.XYZ = rec('XYZ', at + 86400e3);         // re-bought; scan 3 writes it again
  assert.deepStrictEqual([...c.__prune(state.ownedScores, ['XYZ']).pruned], []);
  assert.strictEqual(c.__held('XYZ').scannedAt, at + 86400e3);
});

run('DEFECT (seventh fabricated neutral): fewer than 3 bars is "not measured" with the reason, never \'flat\'', () => {
  const c = ctxWith({});
  for (const b of [null, undefined, [], bars(1), bars(2)]) {
    const v = c.__vt(b);
    assert.notStrictEqual(v, 'flat', String(b && b.length));
    assert.ok(/^not measured \(\d daily bars?, 3 needed\)$/.test(v), v);
  }
  assert.strictEqual(c.__vt(bars(1)), 'not measured (1 daily bar, 3 needed)');
  assert.strictEqual(c.__vt(bars(3)), 'rising');
  assert.strictEqual(c.__vt([{ v: 3 }, { v: 2 }, { v: 1 }]), 'falling');
  assert.strictEqual(c.__vt([{ v: 1 }, { v: 1 }, { v: 1 }]), 'flat', 'a measured flat is still flat');
});

// The reviewer, 2026-11-17: "a scan with an unloaded or denied portfolio deletes nothing".
run('the keep-set must be ESTABLISHED: unread or denied portfolio prunes nothing and says why; a confirmed empty one prunes all', async () => {
  const c = ctxWith({});
  const held = [{ ticker: 'AAA' }];
  const boom = async () => { throw new Error('control must not run when rows came back'); };
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await c.__keep(null, [], boom))), { notEstablished: 'the portfolio has not been read this session' });
  const denied = JSON.parse(JSON.stringify(await c.__keep({ rows: 0 }, [], async () => 0)));
  assert.ok(/a denied read cannot be ruled out/.test(denied.notEstablished), JSON.stringify(denied));
  const failed = JSON.parse(JSON.stringify(await c.__keep({ rows: 0 }, [], async () => { throw new Error('HTTP 401'); })));
  assert.ok(failed.notEstablished.includes("control read failed (HTTP 401)"), JSON.stringify(failed));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await c.__keep({ rows: 0 }, [], async () => 906))), { keep: [] }, 'confirmed empty: keep nothing');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await c.__keep({ rows: 6 }, held, boom))), { keep: ['AAA'] }, 'rows came back: established, no control needed');
  // end to end: the not-established result reaches no deletion
  const owned = { AAA: rec('AAA', 1), OLD: rec('OLD', 1) };
  const k = await c.__keep({ rows: 0 }, [], async () => 0);
  if (k.keep) c.__prune(owned, k.keep);
  assert.deepStrictEqual(Object.keys(owned).sort(), ['AAA', 'OLD'], 'nothing deleted');
});

// 2026-11-18: the eighth fabricated neutral. The modal's Volume Trend row showed "Normal" for a stock with no
// volume trend at all (`stock.volTrend || 'normal'`).
run('DEFECT (eighth fabricated neutral): a missing volume trend is "Not measured", never "Normal"', () => {
  const c = vm.createContext({ String });
  vm.runInContext(grab('volTrendLabel') + ';globalThis.__l = volTrendLabel;', c);
  assert.strictEqual(c.__l(undefined), 'Not measured (no scan signal for this ticker)');
  assert.strictEqual(c.__l(null), 'Not measured (no scan signal for this ticker)');
  assert.strictEqual(c.__l('sideways'), 'Not measured (unrecognised value: sideways)');
  assert.strictEqual(c.__l('normal'), 'Normal', 'a computed normal is still Normal');
  assert.strictEqual(c.__l('building'), '📈 Building (3 days)');
  assert.strictEqual(c.__l('spike'), '⚡ Spike (today only)');
  assert.ok(app.includes('<span class="signal-val">${volTrendLabel(stock.volTrend)}</span>'), 'the modal row uses it');
  const code = app.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/volTrend \|\| 'normal'/.test(code), 'the defaulting expression is gone from the code');
});
