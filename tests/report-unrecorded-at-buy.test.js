// tests/report-unrecorded-at-buy.test.js -- 2026-11-14. The buy writer stores null (`?? null`), not 0 or 5, for a buy
// with no signal. That made every reader that coerces null newly reachable, so writer and readers are one change (the
// reviewer). Both reports, run for real in the app VM on real trades_v2 backup rows:
//   - generateClaudeReport (the Claude report, from state.sold through mapTradesV2ToSoldShape);
//   - buildSupabaseArchiveReport (from trades_v2 rows directly).
// Held here: the at-buy averages are over RECORDED values and say how many they skipped; the RSI and volume buckets
// leave nulls out and say how many; per-trade lines say "not recorded"; an average over nothing is a dash, never 0.0;
// and no report ever prints NaN or undefined.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { run, REPO_ROOT } = require('./_lib');
const { loadApp } = require('./_app-vm');

const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/backups/trades_v2.json'), 'utf8'));
const rows = (Array.isArray(raw) ? raw : raw.rows).filter(r => r.sell_price != null && r.pnl_pct != null);
const WINS = rows.filter(r => r.pnl_pct > 0.5).slice(0, 3), LOSSES = rows.filter(r => r.pnl_pct < -0.5).slice(0, 3);
assert.ok(WINS.length === 3 && LOSSES.length === 3, 'fixture rows');
const AT_BUY = ['signal_score', 'rsi_at_buy', 'volume_ratio_at_buy', 'risk_score'];
const nulled = (list, idx) => { const t = JSON.parse(JSON.stringify(list)); for (const i of idx) for (const k of AT_BUY) t[i][k] = null; return t; };
const meanOf = (list, k) => { const v = list.map(r => r[k]).filter(x => x != null).map(Number); return v.reduce((s, x) => s + x, 0) / v.length; };

async function claudeReport(trades) {
  const { ctx } = loadApp();
  let text = null;
  Object.assign(ctx, { __rows: trades, Blob: class { constructor(parts) { text = parts.join(''); } } });
  vm.runInContext(`checkBuildStatus = async () => {}; showAlert = () => {};
    URL.createObjectURL = () => 'blob:x'; URL.revokeObjectURL = () => {};
    state.sold = __rows.map(mapTradesV2ToSoldShape);`, ctx);
  await vm.runInContext('generateClaudeReport()', ctx); // the fake DOM's anchor has no click(): the text is already captured
  assert.ok(text, 'the report text was produced');
  return text;
}
function archiveReport(trades) { const { ctx } = loadApp(); ctx.__t = trades; return vm.runInContext('buildSupabaseArchiveReport(__t, [])', ctx); }
const line = (text, re) => { const l = text.split('\n').find(x => re.test(x)); assert.ok(l, `no line matching ${re}`); return l; };

for (const [name, make] of [['the Claude report', claudeReport], ['the archive report', async t => archiveReport(t)]]) {
  await_run(name, make);
}
function await_run(name, make) {
  run(`${name}: at-buy averages skip unrecorded values and say so; buckets and trade lines too; no NaN`, async () => {
    const t = nulled([...WINS, ...LOSSES], [0, 3]);
    const text = await make(t);
    const w = t.slice(0, 3), l = t.slice(3);
    assert.ok(line(text, /^\s*Avg RSI:/).includes(`wins ${meanOf(w, 'rsi_at_buy').toFixed(1)} (1 not recorded, skipped)`), line(text, /^\s*Avg RSI:/));
    assert.ok(line(text, /^\s*Avg RSI:/).includes(`losses ${meanOf(l, 'rsi_at_buy').toFixed(1)} (1 not recorded, skipped)`));
    assert.ok(line(text, /^\s*Avg volume ratio:/).includes(`wins ${meanOf(w, 'volume_ratio_at_buy').toFixed(2)}x (1 not recorded, skipped)`), line(text, /^\s*Avg volume ratio:/));
    assert.ok(line(text, /^\s*Avg signal score:/).includes(`wins ${meanOf(w, 'signal_score').toFixed(1)} (1 not recorded, skipped)`));
    assert.ok(line(text, /^\s*Avg risk score:/).includes(`wins ${meanOf(w, 'risk_score').toFixed(1)} (1 not recorded, skipped)`));
    assert.strictEqual((text.match(/not recorded \(not bucketed\): 2 trades/g) || []).length, 2, 'the RSI and the volume buckets each say 2 left out');
    // ...and really leave them out: each bucket set counts the 4 recorded trades, never a null read as 0 in the lowest.
    for (const head of [/^RSI at purchase — win rate by bucket:/, /^Volume ratio at purchase — win rate by bucket:/]) {
      const ls = text.split('\n'); const i = ls.findIndex(x => head.test(x.trim()));
      assert.ok(i >= 0, `section ${head}`);
      const counts = ls.slice(i + 1, i + 5).map(x => Number((/:\s*(\d+) trades/.exec(x) || [])[1]));
      assert.strictEqual(counts.reduce((s, x) => s + x, 0), 4, `${head}: ${ls.slice(i + 1, i + 5).join(' / ')}`);
    }
    assert.ok(/Signal score at purchase: not recorded/.test(text) && /Risk score at purchase: not recorded/.test(text));
    assert.ok(!/NaN|undefined\/|\$undefined(?!\b)/.test(text.replace(/Budget: \$undefined/, '')), 'no NaN or undefined figure');
  });
  run(`${name}: an average over nothing is a dash, never 0.0`, async () => {
    const text = await make(JSON.parse(JSON.stringify(LOSSES)));
    assert.ok(line(text, /Average profit on wins:/).includes('+$— (—%)'), line(text, /Average profit on wins:/));
    assert.ok(/^\s*Avg RSI:\s+wins —\s/.test(line(text, /^\s*Avg RSI:/)), line(text, /^\s*Avg RSI:/));
    assert.ok(!/NaN/.test(text), 'no NaN');
  });
  // (the reviewer, 2026-11-14) the other direction: a REAL zero is a measurement. avg([0, 0]) is 0.0, never the dash
  // that means "nothing", and a zero is never counted as skipped.
  run(`${name}: genuine zeros print 0.0 and are not skipped`, async () => {
    const t = JSON.parse(JSON.stringify([...WINS, ...LOSSES]));
    for (const r of t) { r.rsi_at_buy = 0; r.risk_score = 0; }
    const text = await make(t);
    assert.ok(/^\s*Avg RSI:\s+wins 0\.0\s+\| losses 0\.0\s*$/.test(line(text, /^\s*Avg RSI:/)), line(text, /^\s*Avg RSI:/));
    assert.ok(/^\s*Avg risk score:\s+wins 0\.0\s+\| losses 0\.0\s*$/.test(line(text, /^\s*Avg risk score:/)), line(text, /^\s*Avg risk score:/));
    assert.ok(!/not recorded, skipped|not bucketed/.test(text), 'a zero is never skipped');
    const ls = text.split('\n'); const i = ls.findIndex(x => /^RSI at purchase — win rate by bucket:/.test(x.trim()));
    assert.ok(/:\s*6 trades/.test(ls[i + 1]), `all six zeros in the lowest RSI bucket: ${ls[i + 1]}`);
  });
  run(`${name}: control, nothing unrecorded, nothing said about skipping`, async () => {
    const text = await make(JSON.parse(JSON.stringify([...WINS, ...LOSSES])));
    assert.ok(!/not recorded, skipped|not bucketed/.test(text));
  });
}
