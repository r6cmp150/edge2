#!/usr/bin/env node
// scripts/measure-iex-vs-sip-scoring.mjs -- what scoring on IEX bars does
// to EDGE's scores (2026-11-01). Measurement only; changes nothing.
//
// The bars and snapshot that reach scoreStock come from core/market-data.js
// (fetchMultiBars, fetchSnapshots), which hardcode feed:'iex', in the
// browser and in the logger (which loads the same file). The 1M liquidity
// pre-filter reads SIP (core/universe.js). So a stock is admitted on its
// consolidated volume and then scored on one venue's prints.
//
// For each buy in signal_snapshot_at_buy, scoreStock (the working-tree
// formula; its scoring_hash is checked against the rows') runs twice at the
// buy minute, once per feed, on inputs rebuilt the way Alpaca serves them:
//   - daily bars: from 180 calendar days before the buy date (fetchMultiBars'
//     window) through the previous session, plus today's partial bar built
//     from that feed's 1-minute bars up to the buy minute, if it has any;
//   - the snapshot scoreStock reads: dailyBar = the most recent daily bar
//     (today's partial bar, or YESTERDAY's when the feed has no print today
//     -- which is how a stock with no IEX trade yet gets yesterday's price,
//     volume and change presented as today's), prevDailyBar = the one before.
// News, category, SPY change and macro condition are the snapshot's own,
// identical for both feeds.
//
// THE SCAN MINUTE, not the buy minute: the scan came before the buy, and a
// score moves minute to minute. The snapshot's last bar is IEX's partial
// daily bar at scan time, so its volume is IEX's cumulative volume then:
// the scan minute is the first minute whose running IEX total reaches it
// with the snapshot's price as its close. Where that can't be found (no
// IEX print today, a scan from an earlier day, or no exact match), the buy
// minute stands in, and the row says so. The IEX rebuild is checked against
// the stored score: the match rate says how faithful the rebuild is.
//
//   node scripts/measure-iex-vs-sip-scoring.mjs --rev <backup commit>   (quotable)
//   node scripts/measure-iex-vs-sip-scoring.mjs --live                  (not quotable)
//
// A third input set (2026-11-01): SIP as it stood 15 minutes before the
// minute, which is what Alpaca's Basic plan serves (SIP only for data at
// least 15 minutes old). It is compared with live SIP, the truth, against
// live IEX, split by the stock's IEX share of volume.
//
// Input: signal_snapshot_at_buy, from data/backups/signal_snapshot_at_buy.json
// at --rev (in the daily backup from 2026-11-02, d6e277d), or the live table
// with --live. Alpaca historical bars are fixed once the session is old
// enough to query on SIP.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAllRows } from './lib/read-all.mjs';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';
import { scorerFromSource, snapshotScoreInputs } from './lib/rescore-snapshot.mjs';
import { scoringHash } from './lib/scoring-hash.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store = readFileSync(path.join(ROOT, 'core/store.js'), 'utf8');
const SB = store.match(/SUPABASE_URL = '([^']+)'/)[1], KEY = store.match(/SUPABASE_ANON_KEY = '([^']+)'/)[1];
const argv = process.argv.slice(2);
const rev = argv.includes('--rev') ? argv[argv.indexOf('--rev') + 1] : null;
if (!rev === !argv.includes('--live')) { console.error('usage: --rev <commit> | --live'); process.exit(2); }
const raw = rev
  ? JSON.parse(execSync(`git show ${rev}:data/backups/signal_snapshot_at_buy.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString())
  : await fetchAllRows(`${SB}/rest/v1/signal_snapshot_at_buy?select=*&order=position_id`, { apikey: KEY, Authorization: `Bearer ${KEY}` }, 'signal_snapshot_at_buy read', fetch, 'position_id');
if (!Array.isArray(raw)) throw new Error(JSON.stringify(raw));
const rows = raw.filter(r => r.snapshot).sort((a, b) => Number(a.position_id) - Number(b.position_id));
console.log(`Source: ${rev ? `data/backups/signal_snapshot_at_buy.json at ${rev}` : `LIVE signal_snapshot_at_buy at ${new Date().toISOString()} -- NOT QUOTABLE`}`);

const src = readFileSync(path.join(ROOT, 'core/edge-scoring.js'), 'utf8');
const hash = scoringHash(src);
const own = rows.filter(r => r.code_version?.scoring_hash === hash);
console.log(`Rows: ${rows.length} snapshots (position_id ${rows[0]?.position_id}..${rows[rows.length - 1]?.position_id}); ${own.length} scored by the working-tree formula (${hash.slice(0, 12)}), used below.`);
const scorer = scorerFromSource(ROOT, src);
// The macro overlay is scored as it was at the buy, not assumed on. The
// snapshot doesn't record the setting; every row here stores
// macroAdjustment 0 under a non-null macroCondition, which is what the
// overlay being OFF produces (Roman's disableMacroOverlay), and re-scoring
// the stored snapshots with it off reproduces all 88 stored scores, while
// rescore-snapshot.mjs's default (on) reproduces 44. Checked here per run.
const score = (o, off) => { const { args, macroContext } = snapshotScoreInputs(o); scorer.state.macroContext = macroContext; scorer.state.settings.disableMacroOverlay = off; return scorer.__s(...args); };
const overlayOff = own.every(r => r.snapshot.macroAdjustment === 0);
const reproduce = own.filter(r => score(r.snapshot, overlayOff)?.score === r.snapshot.score).length;
console.log(`Macro overlay at the buy: ${overlayOff ? 'OFF' : 'ON'} (inferred from stored macroAdjustment); stored snapshots re-score to their stored score on ${reproduce} of ${own.length} with it.`);

const ptDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
// Every buy here is before 2026-11-01, so the session opened at 13:30Z (EDT).
const openUtc = d => { if (d >= '2026-11-01') throw new Error(`open time for ${d} not handled (EST)`); return `${d}T13:30:00Z`; };
const H = alpacaHeaders(ROOT);
const byDate = {};
for (const r of own) (byDate[ptDate(Number(r.position_id))] ||= []).push(r);

const cmp = [];
for (const [d, rs] of Object.entries(byDate)) {
  const syms = [...new Set(rs.map(r => r.snapshot.ticker))];
  const start = new Date(Date.parse(`${d}T12:00:00Z`) - 180 * 86400000).toISOString().slice(0, 10);
  const feeds = {};
  for (const feed of ['iex', 'sip']) {
    const daily = await fetchBars(H, syms, { timeframe: '1Day', start, end: d, feed, adjustment: 'all' });
    const lastBuy = Math.max(...rs.map(r => Number(r.position_id)));
    const minute = await fetchBars(H, syms, { timeframe: '1Min', start: openUtc(d), end: new Date(lastBuy).toISOString(), feed, adjustment: 'all' });
    feeds[feed] = { daily, minute };
  }
  for (const r of rs) {
    const s = r.snapshot, t = s.ticker;
    let buyMs = Number(r.position_id), at = 'buy minute';
    const sl = s.bars[s.bars.length - 1];
    if (sl.t.slice(0, 10) === d) {
      let cum = 0;
      for (const b of feeds.iex.minute[t] || []) {
        cum += b.v;
        if (cum === sl.v && b.c === sl.c) { buyMs = Date.parse(b.t) + 60000; at = 'scan minute'; break; }
        if (cum > sl.v) break;
      }
    }
    const out = { at, t, d, buy: new Date(buyMs).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' }), stored: s.score, storedLabel: s.signal };
    for (const [name, feed, cutMs] of [['iex', 'iex', buyMs], ['sip', 'sip', buyMs], ['sip15', 'sip', buyMs - 15 * 60000]]) {
      const hist = (feeds[feed].daily[t] || []).filter(b => b.t.slice(0, 10) < d);
      const mins = (feeds[feed].minute[t] || []).filter(b => Date.parse(b.t) + 60000 <= cutMs);
      const bars = [...hist];
      if (mins.length) bars.push({ t: `${d}T04:00:00Z`, o: mins[0].o, h: Math.max(...mins.map(b => b.h)), l: Math.min(...mins.map(b => b.l)), c: mins[mins.length - 1].c, v: mins.reduce((a, b) => a + b.v, 0) });
      const last = bars[bars.length - 1], prev = bars[bars.length - 2];
      const o = { ticker: t, price: last.c, volume: last.v, prevClose: prev?.c, bars, news: s.news, spyChange: s.spyChange, category: s.category, macroCondition: s.macroCondition };
      const res = score(o, overlayOff);
      out[name + 'Hist10'] = hist.slice(-10).reduce((a, b) => a + b.v, 0);
      out[name] = { res, todayPrints: mins.length, barsAsOf: last.t.slice(0, 10), nBars: bars.length, score: res?.score ?? null, label: res?.signal ?? null, rsi: res?.rsi, maPct: res?.maPct, volRatio: res?.volRatio, todayChange: res?.todayChange, consUpDays: res?.consUpDays, volBuild: res?.volBuild, price: last.c, vol: last.v };
    }
    cmp.push(out);
  }
}

const n = cmp.length, f1 = x => x == null ? '—' : x.toFixed(1), med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const ok = cmp.filter(c => c.iex.score != null && c.sip.score != null);
const sm = cmp.filter(c => c.at === 'scan minute');
console.log(`\nScan minute recovered from IEX cumulative volume: ${sm.length} of ${n}; the rest use the buy minute.`);
console.log(`Rebuild check: IEX rebuild equals the stored score on ${sm.filter(c => c.iex.score === c.stored).length} of ${sm.length} at the recovered scan minute; ${cmp.filter(c => c.at !== 'scan minute' && c.iex.score === c.stored).length} of ${n - sm.length} at the buy minute.`);
console.log(`No print yet today at the buy minute: IEX ${cmp.filter(c => !c.iex.todayPrints).length} of ${n}, SIP ${cmp.filter(c => !c.sip.todayPrints).length} of ${n}.`);
console.log(`IEX history has fewer daily bars than SIP (sessions with no IEX print): ${cmp.filter(c => c.iex.nBars < c.sip.nBars).length} of ${n}; median missing ${med(cmp.map(c => c.sip.nBars - c.iex.nBars))}, max ${Math.max(...cmp.map(c => c.sip.nBars - c.iex.nBars))}.`);

console.log('\nPER INPUT, IEX minus SIP, same ticker, same minute (median |diff| / 90th pct |diff|):');
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
for (const [k, label] of [['price', 'price (% of SIP)'], ['rsi', 'RSI (points)'], ['maPct', 'MA20 distance (pct points)'], ['todayChange', 'today change (pct points)'], ['volRatio', 'volume ratio (IEX/SIP, x)'], ['consUpDays', 'consecutive up days']]) {
  const diffs = ok.map(c => k === 'price' ? Math.abs(c.iex.price / c.sip.price - 1) * 100 : k === 'volRatio' ? (c.iex.volRatio / c.sip.volRatio) : Math.abs(c.iex[k] - c.sip[k]));
  if (k === 'volRatio') console.log(`  ${label.padEnd(30)} median ${f1(med(diffs))}x, 10th pct ${f1(q(diffs, 0.1))}x, 90th pct ${f1(q(diffs, 0.9))}x`);
  else console.log(`  ${label.padEnd(30)} median ${f1(med(diffs))}, 90th pct ${f1(q(diffs, 0.9))}, max ${f1(Math.max(...diffs))}`);
}
console.log(`  volBuild agrees: ${ok.filter(c => c.iex.volBuild === c.sip.volBuild).length} of ${ok.length}`);

console.log('\nSCORE, IEX minus SIP:');
const sd = ok.map(c => c.iex.score - c.sip.score);
console.log(`  identical ${sd.filter(x => x === 0).length} of ${ok.length}; |diff| median ${med(sd.map(Math.abs))}, 90th pct ${q(sd.map(Math.abs), 0.9)}, max ${Math.max(...sd.map(Math.abs))}; IEX higher ${sd.filter(x => x > 0).length}, lower ${sd.filter(x => x < 0).length}`);
console.log(`  label differs: ${ok.filter(c => c.iex.label !== c.sip.label).length} of ${ok.length}`);
for (const c of ok.filter(c => c.iex.label !== c.sip.label)) console.log(`    ${c.t} ${c.d} ${c.buy}: IEX ${c.iex.score} ${c.iex.label} | SIP ${c.sip.score} ${c.sip.label}`);
const thr = 65; // v2 soft-buy line: the buyable threshold
console.log(`  buyable (>= ${thr}) on IEX but not on SIP: ${ok.filter(c => c.iex.score >= thr && c.sip.score < thr).length}; on SIP but not IEX: ${ok.filter(c => c.sip.score >= thr && c.iex.score < thr).length}`);

// Which term moves the score: each component's points, IEX minus SIP, from
// the same scoreComponents the score was summed from.
console.log('\nBY COMPONENT (points, IEX minus SIP): rows differing | mean signed diff | IEX higher/lower');
const comps = c => scorer.scoreComponents({ volRatio: c.volRatio, todayChange: c.todayChange, rsi: c.rsi, price: c.price, ma20: c.ma20, volBuild: c.volBuild, meanReversion: c.meanReversion, catalystSetup: c.catalystSetup, consUpDays: c.consUpDays, rsVsSPY: c.rsVsSPY });
const cr = ok.map(c => ({ i: comps(c.iex.res), s: comps(c.sip.res) }));
for (const k of Object.keys(cr[0].i).filter(k => /Pts$/.test(k))) {
  const d = cr.map(x => (x.i[k] ?? 0) - (x.s[k] ?? 0));
  const nz = d.filter(x => x !== 0);
  console.log(`  ${k.padEnd(15)} ${String(nz.length).padStart(3)} of ${ok.length} | ${(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2)} | ${nz.filter(x => x > 0).length}/${nz.filter(x => x < 0).length}`);
}

// Why the volume ratio doesn't cancel: it's IEX-today / IEX-10-day-average,
// which equals the SIP ratio only if IEX's share of today's volume so far
// equals its share of the averaged days. Both shares, per row.
const shares = ok.filter(c => c.iex.todayPrints && c.sip.vol > 0).map(c => {
  return { today: c.iex.vol / c.sip.vol, hist: c.iexHist10 / c.sipHist10, t: c.t };
});
const sr = shares.map(x => x.today / x.hist);
console.log(`\nIEX SHARE OF VOLUME (rows with an IEX print today, n=${shares.length}): today so far median ${(med(shares.map(x => x.today)) * 100).toFixed(1)}%, prior 10 sessions median ${(med(shares.map(x => x.hist)) * 100).toFixed(1)}%`);
console.log(`  today's share / 10-session share: median ${med(sr).toFixed(2)}, 10th pct ${q(sr, 0.1).toFixed(2)}, 90th pct ${q(sr, 0.9).toFixed(2)} (1.00 = cancels exactly)`);

// 15-MINUTE-DELAYED SIP against live IEX, each measured against live SIP
// (the truth at that minute), split by the stock's IEX share of volume over
// the 10 sessions before: where live IEX is closest to live SIP, the delay
// costs most.
console.log('\n15-MINUTE-DELAYED SIP vs LIVE IEX, both against live SIP, by 10-session IEX share:');
const bands = [['IEX share < 3%', 0, 0.03], ['3% to 8%', 0.03, 0.08], ['>= 8%', 0.08, 1]];
const d3 = cmp.filter(c => c.iex.score != null && c.sip.score != null && c.sip15.score != null);
for (const [label, lo, hi] of [['all', 0, 1.01], ...bands]) {
  const rs = d3.filter(c => { const sh = c.iexHist10 / c.sipHist10; return sh >= lo && sh < hi; });
  if (!rs.length) { console.log(`  ${label}: n=0`); continue; }
  const pIex = rs.map(c => Math.abs(c.iex.price / c.sip.price - 1) * 100), pDel = rs.map(c => Math.abs(c.sip15.price / c.sip.price - 1) * 100);
  const pDelIex = rs.map(c => Math.abs(c.sip15.price / c.iex.price - 1) * 100);
  const lIex = rs.filter(c => c.iex.label !== c.sip.label).length, lDel = rs.filter(c => c.sip15.label !== c.sip.label).length;
  const bIex = rs.filter(c => (c.iex.score >= 65) !== (c.sip.score >= 65)).length, bDel = rs.filter(c => (c.sip15.score >= 65) !== (c.sip.score >= 65)).length;
  const sIex = rs.map(c => Math.abs(c.iex.score - c.sip.score)), sDel = rs.map(c => Math.abs(c.sip15.score - c.sip.score));
  console.log(`  ${label.padEnd(15)} n=${String(rs.length).padStart(2)} | price off live SIP, median/90th: IEX ${f1(med(pIex))}%/${f1(q(pIex, 0.9))}%, delayed SIP ${f1(med(pDel))}%/${f1(q(pDel, 0.9))}% | delayed SIP vs live IEX ${f1(med(pDelIex))}%/${f1(q(pDelIex, 0.9))}%`);
  console.log(`  ${''.padEnd(15)}      | score off live SIP, 90th pct: IEX ${q(sIex, 0.9)}, delayed ${q(sDel, 0.9)} | label wrong: IEX ${lIex}, delayed ${lDel} | buyable wrong: IEX ${bIex}, delayed ${bDel}`);
}

console.log('\nNO IEX PRINT TODAY (scored on yesterday as if today):');
for (const c of cmp.filter(c => !c.iex.todayPrints)) console.log(`  ${c.t} ${c.d} ${c.buy}: IEX bars as of ${c.iex.barsAsOf}, price ${c.iex.price}, today ${f1(c.iex.todayChange)}%, score ${c.iex.score} | SIP prints ${c.sip.todayPrints}, price ${c.sip.price}, today ${f1(c.sip.todayChange)}%, score ${c.sip.score}`);

console.log('\nALL ROWS: ticker date buy (minute used) | stored | IEX score rsi vr | SIP score rsi vr');
for (const c of cmp) console.log(`  ${c.t.padEnd(5)} ${c.d} ${c.buy} (${c.at}) | ${c.stored} | ${c.iex.score} ${f1(c.iex.rsi)} ${f1(c.iex.volRatio)} | ${c.sip.score} ${f1(c.sip.rsi)} ${f1(c.sip.volRatio)}`);
