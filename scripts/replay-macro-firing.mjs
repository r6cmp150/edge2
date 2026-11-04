// scripts/replay-macro-firing.mjs — "does the macro condition fire when it
// should?" (phase-10 spec, observe-only part 4, 2026-11-02). Replays the
// app's OWN classifier (classifyMacroCondition, loaded from app.js) over
// RECONSTRUCTED ETF moves for every trading day in the window, at fixed
// scan times, on both feeds, and reports:
//   1. how often each condition fires, by scan time;
//   2. how often the rule is CHOPPY or ambiguous (= how often the app would
//      have needed Groq to resolve it);
//   3. missing inputs (an ETF with no bar at that time);
//   4. THE INPUT-PRECISION TEST: per rule threshold, how often the IEX move
//      (what the app reads) and the SIP move fall on OPPOSITE sides of it,
//      and on how many day-times the two feeds give a different condition.
//      If that's material, the classification is noise at the input, and
//      it's fixed before the predictive test runs.
//
// RECONSTRUCTED, NOT THE APP'S INPUTS: the move at time T is the last 1-min
// bar close at or before T (extended hours included) against the previous
// session's daily close, per feed. The app reads a live snapshot
// (dailyBar.c || latestTrade.p vs prevDailyBar.c); before the open its
// dailyBar may still be the previous session's, which a bar replay can't
// reproduce. 06:00 PT is included so the pre-market case is measured, as a
// bar reconstruction, not absent.
//   node scripts/replay-macro-firing.mjs [--from 2026-08-13] [--to 2026-10-30]
// Source: Alpaca historical bars, fetched at run time (printed); SIP history
// is final, so a re-run gives the same SIP figures.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { alpacaHeaders, fetchBars } from './lib/alpaca-bars.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FROM = arg('--from', '2026-08-13'), TO = arg('--to', '2026-10-30');
const TIMES = ['06:00', '07:00', '07:30', '09:00', '11:00'];
const ETFS = ['SPY', 'XLE', 'XLK', 'XBI', 'XLF', 'XLI', 'XLRE', 'XLY'];
const REQUIRED = ['SPY', 'XLE', 'XLK', 'XBI', 'XLF'];

// The app's classifier, verbatim.
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const i = app.search(/^function classifyMacroCondition\(/m);
const c = {};
vm.createContext(c);
vm.runInContext(app.slice(i, app.indexOf('\n}\n', i) + 3) + ';globalThis.cls = classifyMacroCondition;', c);
// Every threshold comparison the rule makes, as [label, ETF, op, value]
// (read off classifyMacroCondition; tests/macro-classifier.test.js checks
// this list against its source so it can't drift).
export const RULE_EDGES = [
  ['RISK_OFF: SPY <= -2', 'SPY', '<=', -2], ['GEOPOLITICAL: SPY <= -1', 'SPY', '<=', -1], ['GEOPOLITICAL: XLE >= 1', 'XLE', '>=', 1],
  ['TECH_ROTATION_OUT: XLK <= -1.5', 'XLK', '<=', -1.5], ['TECH_ROTATION_OUT: XLE >= 0.5', 'XLE', '>=', 0.5], ['TECH_ROTATION_OUT: XLF >= 0.5', 'XLF', '>=', 0.5],
  ['BROAD_RALLY: SPY >= 1', 'SPY', '>=', 1], ['MOMENTUM_DAY: SPY >= 1.5', 'SPY', '>=', 1.5], ['MOMENTUM_DAY: XLK >= 1.5', 'XLK', '>=', 1.5],
  ['SECTOR_WEAKNESS: SPY > -1', 'SPY', '>', -1], ['SECTOR_WEAKNESS_BIOTECH: XBI <= -1.5', 'XBI', '<=', -1.5],
  ['SECTOR_WEAKNESS_ENERGY: XLE <= -1.5', 'XLE', '<=', -1.5], ['SECTOR_WEAKNESS_TECH: XLK <= -1.5', 'XLK', '<=', -1.5],
];
const holds = (v, op, t) => (op === '<=' ? v <= t : op === '>=' ? v >= t : op === '>' ? v > t : v < t);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

async function main() {
  const H = alpacaHeaders(ROOT);
  const fetchedAt = new Date().toISOString();
  const withRetry = async fn => { for (let a = 0; ; a++) { try { return await fn(); } catch (e) { if (!/HTTP 429/.test(e.message) || a >= 8) throw e; await new Promise(r => setTimeout(r, 15000 * (a + 1))); } } };
  // Daily closes per feed (the previous session's close is the reference).
  const startD = new Date(Date.parse(FROM + 'T00:00:00Z') - 10 * 864e5).toISOString().slice(0, 10);
  const daily = {};
  for (const feed of ['iex', 'sip']) daily[feed] = await withRetry(() => fetchBars(H, ETFS, { timeframe: '1Day', start: `${startD}T00:00:00Z`, end: `${TO}T23:59:00Z`, feed }));
  const days = [...new Set(daily.sip.SPY.map(b => b.t.slice(0, 10)))].filter(d => d >= FROM && d <= TO).sort();
  const ptOffset = d => (d >= '2026-11-01' ? 8 : 7); // PDT before 11-01
  const results = []; // { day, time, feed, changes, missing, condition, matched }
  for (const day of days) {
    for (const feed of ['iex', 'sip']) {
      // 04:00 ET (the start of extended hours) to 12:00 PT, as UTC.
      const t0 = `${day}T${String(8 + (ptOffset(day) - 7)).padStart(2, '0')}:00:00Z`;
      const t1 = `${day}T${String(19 + (ptOffset(day) - 7)).padStart(2, '0')}:00:00Z`;
      const bars = await withRetry(() => fetchBars(H, ETFS, { timeframe: '1Min', start: t0, end: t1, feed }));
      for (const hm of TIMES) {
        const [h, m] = hm.split(':').map(Number);
        const tMs = Date.parse(`${day}T00:00:00Z`) + ((h + ptOffset(day)) * 60 + m) * 60000;
        const changes = {}, missing = [];
        for (const s of ETFS) {
          const prev = (daily[feed][s] || []).filter(b => b.t.slice(0, 10) < day).pop();
          const last = (bars[s] || []).filter(b => Date.parse(b.t) <= tMs).pop();
          if (!prev || !last) { changes[s] = null; missing.push(s); continue; }
          changes[s] = ((last.c - prev.c) / prev.c) * 100;
        }
        const incomplete = REQUIRED.some(s => changes[s] == null);
        const r = incomplete ? { condition: null, matched: [] } : c.cls(changes);
        results.push({ day, time: hm, feed, changes, missing, condition: r.condition, matched: [...r.matched] });
      }
    }
  }
  // 1-3: firing, Groq need, missing — per time, per feed
  console.log(`source: Alpaca historical bars, fetched ${fetchedAt}; ${days.length} trading days ${days[0]}..${days[days.length - 1]}; RECONSTRUCTED moves (see header)`);
  for (const feed of ['iex', 'sip']) {
    console.log(`\n== feed ${feed.toUpperCase()} ==`);
    for (const hm of TIMES) {
      const rs = results.filter(r => r.feed === feed && r.time === hm);
      const fire = {};
      for (const r of rs) fire[r.condition ?? 'INCOMPLETE'] = (fire[r.condition ?? 'INCOMPLETE'] || 0) + 1;
      const groq = rs.filter(r => r.condition === 'CHOPPY' || r.matched.length > 1 || r.condition == null).length;
      const miss = rs.filter(r => r.missing.length).length;
      console.log(`  ${hm} PT  n=${rs.length}  ${Object.entries(fire).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}  | needs Groq ${groq} (${Math.round(100 * groq / rs.length)}%) | missing an ETF ${miss}`);
    }
  }
  // 3b: does the rule DECIDE? A named condition, not CHOPPY, not ambiguous,
  // not incomplete. Only these days can count toward the rule-vs-Groq bar
  // (phase-10 spec), so this is the ceiling on how fast that bar can be met.
  // A replay time with no bar yet today is one a live snapshot would read as
  // yesterday's: the rule could not run there.
  const decided = r => r.condition != null && r.condition !== 'CHOPPY' && r.matched.length <= 1;
  console.log('\n== DOES THE RULE NAME A CONDITION? ==');
  for (const feed of ['iex', 'sip']) {
    const rs = results.filter(r => r.feed === feed);
    for (const hm of TIMES) {
      const at = rs.filter(r => r.time === hm);
      console.log(`  ${feed.toUpperCase()} ${hm} PT  decided ${at.filter(decided).length} of ${at.length} days | abstained ${at.filter(r => r.condition != null && !decided(r)).length} | could not run ${at.filter(r => r.condition == null).length}`);
    }
    const session = rs.filter(r => r.time !== '06:00');
    const anyDay = new Set(session.filter(decided).map(r => r.day));
    const allDay = days.filter(d => session.filter(r => r.day === d).every(decided));
    console.log(`  ${feed.toUpperCase()} in session (07:00-11:00 PT): a condition named at ANY of the 4 times on ${anyDay.size} of ${days.length} days; at ALL 4 on ${allDay.length}`);
    if (anyDay.size) console.log(`  ${feed.toUpperCase()} so 8 rule-vs-Groq days need at least ${Math.ceil(8 * days.length / anyDay.size)} trading days, if Groq differed on EVERY day the rule decided (a floor, not an estimate)`);
  }

  // 4: IEX vs SIP, same side of each threshold?
  console.log('\n== INPUT PRECISION: IEX vs SIP on the same side of each rule threshold ==');
  let condDiff = 0, pairs = 0;
  const edgeDis = Object.fromEntries(RULE_EDGES.map(e => [e[0], { n: 0, dis: 0 }]));
  const diffByTime = {};
  for (const day of days) for (const hm of TIMES) {
    const a = results.find(r => r.day === day && r.time === hm && r.feed === 'iex');
    const b = results.find(r => r.day === day && r.time === hm && r.feed === 'sip');
    if (!a || !b) continue;
    pairs++;
    if (a.condition !== b.condition) { condDiff++; diffByTime[hm] = (diffByTime[hm] || 0) + 1; }
    for (const [label, s, op, t] of RULE_EDGES) {
      if (a.changes[s] == null || b.changes[s] == null) continue;
      edgeDis[label].n++;
      if (holds(a.changes[s], op, t) !== holds(b.changes[s], op, t)) edgeDis[label].dis++;
    }
  }
  for (const [label, x] of Object.entries(edgeDis)) console.log(`  ${label.padEnd(40)} opposite sides on ${x.dis} of ${x.n} day-times`);
  console.log(`  DIFFERENT CONDITION (IEX vs SIP): ${condDiff} of ${pairs} day-times (${(100 * condDiff / Math.max(1, pairs)).toFixed(1)}%) | by time: ${TIMES.map(t => `${t} ${diffByTime[t] || 0}`).join(', ')}`);

  // 5. The recorded conditions against the rule: for each trade (pinned
  // trades_v2), the IEX pattern answer at the latest replay time at or before
  // its buy_time that day. A stored condition the rule didn't give is one the
  // pattern rule could not have produced at that reading: Groq-decided, or
  // read at a different moment (the old once-per-page-load fetch).
  const TR = arg('--trades', 'd6e277d');
  const { execSync } = await import('node:child_process');
  const trades = (j => Array.isArray(j) ? j : j.rows)(JSON.parse(execSync(`git show ${TR}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
  const tally = { agree: 0, differ: 0, noReading: 0, notInWindow: 0, noCondition: 0 };
  const differBy = {};
  for (const t of trades) {
    const d = String(t.buy_date).slice(0, 10), hm = String(t.buy_time ?? '').slice(0, 5);
    if (!t.macro_condition) { tally.noCondition++; continue; }
    if (d < FROM || d > TO || !days.includes(d)) { tally.notInWindow++; continue; }
    const at = TIMES.filter(x => x !== '06:00' && x <= hm).pop();
    const r = at && results.find(x => x.day === d && x.time === at && x.feed === 'iex');
    if (!r || r.condition == null) { tally.noReading++; continue; }
    if (r.condition === t.macro_condition) tally.agree++;
    else { tally.differ++; const k = `${r.condition} -> stored ${t.macro_condition}`; differBy[k] = (differBy[k] || 0) + 1; }
  }
  console.log(`\n== RECORDED CONDITION vs THE RULE (trades_v2 @ ${TR}, IEX, latest replay time <= buy_time) ==`);
  console.log(`  agree ${tally.agree} | differ ${tally.differ} | no in-session reading before the buy ${tally.noReading} | outside the window ${tally.notInWindow} | no stored condition ${tally.noCondition}`);
  for (const [k, n] of Object.entries(differBy).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    ${n}× rule ${k}`);
}
