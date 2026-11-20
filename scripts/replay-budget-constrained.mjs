#!/usr/bin/env node
// scripts/replay-budget-constrained.mjs -- the pre-registered sample, replayed at Roman's own $1,500. Read only.
// (2026-11-20, the reviewer.) The paper book was not funded: day-end deployed exceeded $1,500 on 20 of the sample's 60
// days (STATUS, "Deployed capital far above the $1,500 budget"), so the sample measured a strategy Roman could not have
// run. If the strategy has an edge in what it ranks highest, pooling every trade would hide it. This asks one question.
//
// DECLARED BEFORE THE FIRST RUN, AND COMMITTED BEFORE IT (as scripts/prereg-pnl.mjs was). Nothing below may change after
// its output has been seen without saying so in the commit that changes it.
//   SAMPLE: exactly prereg-pnl.mjs's: data/backups/trades_v2.json @ 314f6e0, sell_price_unverified false (586 trades).
//   BUDGET: $1,500, Roman's own figure (settings.budget), not a parameter. Available = budget minus every open position
//     at cost (shares x buy_price), the app's own definition (app.js getAvailableBudget); realized P&L does not flow
//     back into it, as in the app. Each trade keeps its recorded shares: nothing is re-sized.
//   EVENTS: an entry at buy_date + buy_time, an exit at sell_date + sell_time (both recorded, HH:MM, on every row). In
//     time order; at the same minute, exits first (the cash is free). An entry is TAKEN if its cost fits in Available,
//     else SKIPPED; a taken trade's exit is its recorded exit; a skipped trade has no exit. A row whose recorded exit is
//     EARLIER than its entry closes, if taken, the moment it is entered (its cost held for no time); counted and printed.
//   ORDER WITHIN A CLUSTER: entries at the same minute (the stored resolution) in descending signal_score, the score
//     the strategy recorded at entry (set on all 586), then by created_at. Across minutes, by time: most of any wider
//     burst is therefore ordered by ARRIVAL, not conviction, and the output says so with the counts.
//   REPORT, the whole comparison: total P&L and P&L per trade for the CONSTRAINED set beside the FULL set, and the count
//     taken and skipped. One constraint, the one Roman intended. No top-N search, no threshold, no second cut.
//   READING, printed with the numbers so they are never quoted without it: a frictionless paper simulation (STATUS); one
//     comparison on one historical sample establishes nothing; a constrained result better than the full set would
//     justify a FORWARD test, declared in advance, and nothing stronger; a flat constrained result is the finding.
//   node scripts/replay-budget-constrained.mjs [--rev 314f6e0]
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BUDGET = 1500;
export const REV = '314f6e0';
const num = v => (v == null || v === '' ? null : Number(v));
const at = (date, hhmm) => `${String(date).slice(0, 10)}T${hhmm}`;

// The replay itself. rows: the sample. Returns every trade's fate and the two sets' figures.
export function replay(rows, { budget = BUDGET } = {}) {
  const events = [];
  for (const r of rows) {
    const cost = num(r.shares) * num(r.buy_price);
    events.push({ kind: 'entry', t: at(r.buy_date, r.buy_time), r, cost });
    events.push({ kind: 'exit', t: at(r.sell_date, r.sell_time), r, cost });
  }
  events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.kind !== b.kind ? (a.kind === 'exit' ? -1 : 1)
    : a.kind === 'entry' ? (num(b.r.signal_score) - num(a.r.signal_score)) || String(a.r.created_at).localeCompare(String(b.r.created_at)) : 0));
  let available = budget;
  const taken = new Set(), skipped = new Set();
  // A recorded exit EARLIER than its entry (declared before the first run): if the trade is taken, it closes the moment
  // it is entered, so its cost is held for no time; the count is printed.
  let minAvailable = budget, maxOpen = 0, open = 0;
  const closed = new Set(), exitFirst = new Set();
  for (const e of events) {
    if (e.kind === 'exit') {
      if (taken.has(e.r) && !closed.has(e.r)) { available += e.cost; closed.add(e.r); open--; }
      else if (!taken.has(e.r) && !skipped.has(e.r)) exitFirst.add(e.r);
      continue;
    }
    if (e.cost <= available) {
      taken.add(e.r);
      if (exitFirst.has(e.r)) { closed.add(e.r); continue; } // closed at entry: nothing held
      available -= e.cost; open++; maxOpen = Math.max(maxOpen, open); minAvailable = Math.min(minAvailable, available);
    } else skipped.add(e.r);
  }
  const exitBeforeEntry = exitFirst.size;
  const figures = set => { const p = [...set].map(r => num(r.pnl_dollars)); const total = p.reduce((a, b) => a + b, 0); return { n: set.size, total, perTrade: set.size ? total / set.size : null }; };
  // ties: how many taken-or-skipped decisions were made among entries at the same minute (ordered by score) vs alone
  const perMinute = new Map(); for (const r of rows) { const k = at(r.buy_date, r.buy_time); perMinute.set(k, (perMinute.get(k) || 0) + 1); }
  const inTies = rows.filter(r => perMinute.get(at(r.buy_date, r.buy_time)) > 1).length;
  return { full: figures(new Set(rows)), constrained: figures(taken), skipped: skipped.size, taken, maxOpen, minAvailable, inTies, exitBeforeEntry };
}

async function main() {
  const rev = (i => (i < 0 ? REV : process.argv[i + 1]))(process.argv.indexOf('--rev'));
  const all = (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execSync(`git show ${rev}:data/backups/trades_v2.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString()));
  const rows = all.filter(r => r.sell_price_unverified === false);
  const $ = v => (v == null ? '-' : `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`);
  console.log('A FRICTIONLESS PAPER SIMULATION, not P&L (STATUS): every fill in full, instantly, at the displayed price, no costs.');
  console.log(`SOURCE: data/backups/trades_v2.json @ ${rev}: ${all.length} rows; the sample (sell_price_unverified false): ${rows.length} trades.`);
  const r = replay(rows);
  console.log(`\nFULL (every trade, unfunded):          ${r.full.n} trades, total ${$(r.full.total)}, per trade ${$(r.full.perTrade)}`);
  console.log(`CONSTRAINED ($${BUDGET}, Available at cost): ${r.constrained.n} trades taken, ${r.skipped} skipped, total ${$(r.constrained.total)}, per trade ${$(r.constrained.perTrade)}`);
  console.log(`  at most ${r.maxOpen} position(s) open at once; the lowest Available reached $${r.minAvailable.toFixed(2)}.`);
  console.log(`  ORDER: ${r.inTies} of ${rows.length} trades entered at a minute shared with another entry, and were ordered by signal_score;`);
  console.log(`  the other ${rows.length - r.inTies} were ordered by ARRIVAL (time), which is a weaker test of conviction than a ranking.`);
  if (r.exitBeforeEntry) console.log(`  DATA: ${r.exitBeforeEntry} trade(s) record an exit earlier than their entry (taken or skipped by entry, as above).`);
  console.log('\nREADING (declared before the first run): one comparison on one historical sample establishes nothing. A constrained');
  console.log('result better than the full set would justify a FORWARD test, declared in advance, and nothing stronger. A flat');
  console.log('constrained result is the finding: the strategy is flat at the size Roman intended.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
