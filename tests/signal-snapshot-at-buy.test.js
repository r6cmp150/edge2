// tests/signal-snapshot-at-buy.test.js — phase-10 spec §5, db/033. A buy
// stores the signal that was on screen. It's worth storing only if it is
// SUFFICIENT: re-scored under the formula its own code_version.scoring_hash
// names, it reproduces its own stored score. That is the property tested
// here, through the same reconstruction the threshold derivation uses
// (scripts/lib/rescore-snapshot.mjs), plus the write path's rules: copied
// at the click, three states, never blocking the add, and the join key
// written at sale.
'use strict';
const assert = require('assert');
const path = require('path');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');
const { readSource, run: runNow, REPO_ROOT } = require('./_lib');
const queue = []; const run = (n, f) => queue.push([n, f]);

const lib = () => import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/rescore-snapshot.mjs')).href);
const hashLib = () => import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/scoring-hash.mjs')).href);
const app = readSource('app.js');
const grab = name => { const i = app.indexOf(`function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i) + 2); };
// eslint-disable-next-line no-eval
eval(grab('captureSignalSnapshot') + '\nglobal.__capture = captureSignalSnapshot;');

// Deterministic fixtures: a 126-bar daily history and a LIVE-SHAPED
// snapshot, whose last trade differs from its daily close as real ones do.
function fixture(seed) {
  let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  let p = 2 + rnd() * 16; const bars = [];
  const d = new Date('2026-04-20T04:00:00Z');
  while (bars.length < 125) {
    d.setUTCDate(d.getUTCDate() + 1); if ([0, 6].includes(d.getUTCDay())) continue;
    const o = p; p = Math.max(1.05, p * (1 + (rnd() - 0.48) * 0.08));
    bars.push({ t: d.toISOString(), o, h: Math.max(o, p) * (1 + rnd() * 0.03), l: Math.min(o, p) * (1 - rnd() * 0.03), c: p, v: Math.floor(5e5 + rnd() * 5e6) });
  }
  const last = p * (1 + (rnd() - 0.4) * 0.12);
  const today = { t: '2026-10-26T04:00:00Z', o: p, h: last * 1.02, l: p * 0.98, c: last, v: Math.floor(1e5 + rnd() * 9e6) };
  const snap = { latestTrade: { p: last * (1 + (rnd() - 0.5) * 0.004) }, dailyBar: today, prevDailyBar: { c: p }, latestQuote: { bp: last * 0.999, ap: last * 1.001 } };
  const news = rnd() < 0.4 ? { headline: 'Company announces record results', symbols: ['X'], created_at: '2026-10-26T12:00:00Z' } : null;
  const macro = [null, 'RISK_OFF', 'RISK_ON'][Math.floor(rnd() * 3)];
  return { bars: [...bars, today], snap, news, spy: (rnd() - 0.5) * 2, macro, category: rnd() < 0.8 ? 'OTHER' : null };
}

run('a captured snapshot re-scores to its own stored score under its own formula (live-shaped inputs)', async () => {
  const { scorerFromSource, rescoreUnderOwnFormula } = await lib();
  const { scoringHash } = await hashLib();
  const src = readSource('core/edge-scoring.js');
  const HASH = scoringHash(src);
  assert.ok(src.includes(`const SCORING_HASH = '${HASH}';`), 'the pinned SCORING_HASH is the formula hash the rows carry');
  const scorer = scorerFromSource(REPO_ROOT, src);
  let n = 0, distinct = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const f = fixture(seed);
    scorer.state.macroContext = f.macro ? { condition: f.macro, changes: null } : null;
    const sig = scorer.__s('X', f.snap, f.bars, f.news, f.spy, f.category);
    if (!sig) continue;
    // The app stamps these on the signal before it is shown (runScreener).
    Object.assign(sig, { thresholdAtBuy: 20, buildVersion: '20261027060000', barsAsOf: '2026-10-26', barsAgeTradingDays: 0 });
    const captured = global.__capture(sig);
    const r = rescoreUnderOwnFormula(REPO_ROOT, captured, HASH);
    assert.strictEqual(r.rev, 'working-tree');
    assert.strictEqual(r.score, sig.score, `seed ${seed}: stored ${sig.score}, re-scored ${r.score}`);
    n++; distinct.add(sig.score);
  }
  console.log(`re-scored ${n} captured snapshots exactly; ${distinct.size} distinct scores (${[...distinct].sort((a, b) => a - b).join(',')})`);
  assert.ok(n >= 50 && distinct.size >= 5, 'the fixtures must exercise more than one score');
});

run('an OLD snapshot finds ITS formula in git and reproduces under it, not under today\'s', async () => {
  const { rescoreUnderOwnFormula, formulaSourceForHash } = await lib();
  const { scoringHash } = await hashLib();
  const v1 = scoringHash(execSync('git show b63ef1b:core/edge-scoring.js', { cwd: REPO_ROOT, maxBuffer: 1e8 }).toString());
  assert.notStrictEqual(v1, scoringHash(readSource('core/edge-scoring.js')));
  const raw = JSON.parse(execSync('git show de95a93:data/backups/signal_log.json', { cwd: REPO_ROOT, maxBuffer: 1e9 }).toString());
  const rows = (Array.isArray(raw) ? raw : raw.rows).filter(r => r.engine_source === 'EDGE' && r.signal_snapshot?.bars?.length).slice(0, 40);
  let same = 0, differsNow = 0;
  const now = scoringHash(readSource('core/edge-scoring.js'));
  for (const r of rows) {
    const own = rescoreUnderOwnFormula(REPO_ROOT, r.signal_snapshot, v1);
    assert.ok(/^[0-9a-f]{7}$/.test(own.rev), own.rev);
    assert.strictEqual(own.score, r.signal_snapshot.score, `${r.signal_snapshot.ticker} ${r.signal_date}: own formula must reproduce the stored score`);
    same++;
    if (rescoreUnderOwnFormula(REPO_ROOT, r.signal_snapshot, now).score !== r.signal_snapshot.score) differsNow++;
  }
  console.log(`v1 rows: ${same} of ${rows.length} reproduce under their own formula (${formulaSourceForHash(REPO_ROOT, v1).rev}); ${differsNow} would differ under today's`);
  assert.ok(differsNow > 0, 'the formula version matters, so "its own" is doing work');
});

run('the reconstruction passes every input scoreStock takes, including ones today\'s score ignores', async () => {
  const { snapshotScoreInputs } = await lib();
  const o = { ticker: 'X', price: 5.1, volume: 123, prevClose: 5, bars: [{ t: 't' }], news: { headline: 'h' }, spyChange: -0.4, category: 'OTHER', macroCondition: 'RISK_OFF' };
  const { args, macroContext } = snapshotScoreInputs(o);
  // News feeds only risk today (core/edge-scoring.js: "no longer affects
  // score"), so the re-score property can't see it dropped. A later formula
  // that scores news must not inherit a reconstruction that loses it.
  assert.deepStrictEqual(args, ['X', { latestTrade: { p: 5.1 }, dailyBar: { c: 5.1, v: 123 }, prevDailyBar: { c: 5 } }, [{ t: 't' }], { headline: 'h' }, -0.4, 'OTHER']);
  assert.deepStrictEqual(macroContext, { condition: 'RISK_OFF', changes: null });
});

run('an unknown formula is reported, never substituted with the current one', async () => {
  const { rescoreUnderOwnFormula } = await lib();
  const r = rescoreUnderOwnFormula(REPO_ROOT, { ticker: 'X', bars: [] }, 'f'.repeat(64));
  assert.strictEqual(r.score, null);
  assert.ok(/no revision/.test(r.reason));
  assert.strictEqual(rescoreUnderOwnFormula(REPO_ROOT, null, 'x').score, null);
  assert.strictEqual(rescoreUnderOwnFormula(REPO_ROOT, { ticker: 'X' }, null).reason, 'no scoring_hash on the row');
});

run('captured at the click: a copy, so later changes to the on-screen signal cannot reach it', () => {
  const sig = { ticker: 'X', score: 55, bars: [{ t: '2026-10-26T04:00:00Z', c: 5 }] };
  const c = global.__capture(sig);
  sig.score = 99; sig.bars[0].c = 1;
  assert.deepStrictEqual(c, { ticker: 'X', score: 55, bars: [{ t: '2026-10-26T04:00:00Z', c: 5 }] });
  assert.strictEqual(global.__capture(undefined), null, 'no signal -> null, never {}');
  const fin = grab('finalizeAddPortfolio');
  assert.ok(fin.indexOf('const signalSnapshotAtBuy = captureSignalSnapshot(sig);') < fin.indexOf('await '), 'copied before the first await');
});

run('three states, and a failed write never fails, delays or blocks the add', async () => {
  const rows = [];
  let fail = false;
  global.insertSignalSnapshotAtBuy = async row => { if (fail) throw new Error('503'); rows.push(row); };
  // eslint-disable-next-line no-eval
  eval(grab('recordSignalSnapshotAtBuy') + '\nglobal.__record = recordSignalSnapshotAtBuy;');
  const pos = { id: '1761550000000', ticker: 'X', codeVersion: { app: 'a', scoring: 2, scoring_hash: 'h' } };
  assert.strictEqual(await global.__record(pos, { ticker: 'X', score: 55, barsAsOf: '2026-10-26' }), true);
  assert.strictEqual(await global.__record(pos, null), true);
  assert.deepStrictEqual(rows[0], { position_id: '1761550000000', engine_source: 'EDGE', code_version: pos.codeVersion, bars_as_of: '2026-10-26', snapshot: { ticker: 'X', score: 55, barsAsOf: '2026-10-26' }, absent_reason: null });
  assert.deepStrictEqual(rows[1], { position_id: '1761550000000', engine_source: 'EDGE', code_version: pos.codeVersion, bars_as_of: null, snapshot: null, absent_reason: 'no_signal' });
  // db/033's CHECK: exactly one of snapshot / absent_reason.
  for (const r of rows) assert.ok((r.snapshot !== null) !== (r.absent_reason !== null));
  fail = true;
  const err = console.error; const seen = []; console.error = m => seen.push(m);
  try { assert.strictEqual(await global.__record(pos, null), false, 'a failed write resolves false: it never throws'); }
  finally { console.error = err; }
  assert.ok(seen.some(m => /Not captured; the position is saved/.test(m)));
  // Wired after the position insert, NOT awaited, before the add completes.
  const fin = grab('finalizeAddPortfolio');
  const ins = fin.indexOf('await insertPositionToSupabase(position);'), rec = fin.indexOf('recordSignalSnapshotAtBuy(position, signalSnapshotAtBuy);'), push = fin.indexOf('state.portfolio.push(position);');
  assert.ok(ins > 0 && rec > ins && push > rec, 'after the insert succeeds, before the add completes');
  assert.ok(!/await\s+recordSignalSnapshotAtBuy/.test(fin), 'never awaited');
  assert.ok(readSource('core/store.js').includes("from('signal_snapshot_at_buy').insert([row])"));
});

run('the sale writes the join key, so the snapshot survives the portfolio row', () => {
  const w = grab('writeTradeToSupabase');
  assert.ok(w.includes('position_id: pos.id ?? null,'), 'trades_v2.position_id from the position');
});

(async () => { for (const [n, f] of queue) await runNow(n, f); })();
