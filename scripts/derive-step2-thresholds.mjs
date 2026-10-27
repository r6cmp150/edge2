// scripts/derive-step2-thresholds.mjs -- phase-10 step 2 (spec §7.6): the
// re-derivation of STRONG / SOFT / WATCH after the two neutralised terms,
// by the equal-count histogram method, from data/backups/signal_log.json.
// This script is the source of every number step 2 states (spec §7.7: a
// number that can't be reproduced on demand doesn't go in a spec).
//
//   node scripts/derive-step2-thresholds.mjs                 (pinned data, below)
//   node scripts/derive-step2-thresholds.mjs --data-rev HEAD  (today's backup)
//
// THE DATA IS PINNED, not just the code. data/backups/signal_log.json is
// overwritten by the nightly backup, so an unpinned run gives a different
// answer every day: the step 2 figures were first derived against a local
// copy one day staler than the remote, and that difference was misread as
// "the other figures don't reproduce" (spec §7.7). DATA_REV is the backup
// commit every stated step 2 figure comes from; the output prints it.
//
// OLD scorer = core/edge-scoring.js at BASE_COMMIT (the last commit before
// step 2), read from git. NEW scorer = the working tree. Both score the same
// logged snapshots, so the only difference is the formula. The OLD re-score
// must reproduce each row's stored score, or the comparison is invalid.
//
// Population: every EDGE row with a full snapshot, SHOWN and
// BELOW_THRESHOLD. The logger logs every scored symbol (spec §7.6 step 1e),
// so the rows scoring below the display line are present: this is the whole
// scored population, not a lower bound. A symbol can be logged more than
// once a day (one row per tier), so a day's signals are counted once per
// (date, symbol), keeping the row with the highest OLD score.
//
// Equal-count: for each old line L, the new line is the multiple of 5
// whose >= count is closest to the old count at L (ties: the higher line,
// the stricter choice). Scores are multiples of 5 before and after, so no
// other value can select differently.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_COMMIT = 'b63ef1b'; // last commit with the pre-step-2 formula
const argRev = process.argv.indexOf('--data-rev');
const DATA_REV = argRev > -1 ? process.argv[argRev + 1] : 'de95a93'; // nightly backup 2026-10-22T10:45Z: signal_log through 2026-10-21
const OLD_LINES = { WATCH: 29, SOFT: 73, STRONG: 116 };
// A line no signal ever reached under the old formula has no equal-count
// derivation: the target count is 0, and every high enough new line
// "matches" it. That line is a judgement, not a measurement, and the
// output says so instead of printing a number nobody computed. STRONG is
// that case (spec §7.6 step 2: the tier never fired), set to 110 by
// decision.
const DECIDED_WHEN_UNDERIVABLE = { STRONG: 110 };

const read = f => readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export (function|const)/gm, '$1');
function scorer(src) {
  const c = { console, Math, Date, JSON, Number, String, Array, Object, Infinity, NaN, isFinite, state: { settings: {}, macroContext: null } };
  vm.createContext(c);
  for (const f of ['core/indicators.js', 'core/market-data.js']) vm.runInContext(strip(read(f)), c);
  vm.runInContext(strip(src) + '\n;globalThis.__s = scoreStock;', c);
  return c;
}
const OLD = scorer(execSync(`git show ${BASE_COMMIT}:core/edge-scoring.js`, { cwd: ROOT, maxBuffer: 1e8 }).toString());
const NEW = scorer(read('core/edge-scoring.js'));

const raw = JSON.parse(execSync(`git show ${DATA_REV}:data/backups/signal_log.json`, { cwd: ROOT, maxBuffer: 1e9 }).toString());
console.log(`data: data/backups/signal_log.json at ${DATA_REV}; old formula: core/edge-scoring.js at ${BASE_COMMIT}; new formula: working tree`);
let rows = (Array.isArray(raw) ? raw : raw.rows).filter(r => r.engine_source === 'EDGE' && r.signal_snapshot?.bars?.length);

// --exclude-artifacts (2026-10-27, phase-10 §7.6 step 2 recheck): drop, from
// BOTH sides, rows that were not a real signal when scored. Decided from
// each row's own stored data, so the result stays pinned to DATA_REV:
//   stale    = its newest bar was more than one trading day before the
//              signal date (a dead or halted stock; PSKY from 10-09);
//   openMin  = scored on the previous session's bar (age exactly 1) by a
//              scan in the first two minutes after the 06:30 PT open, when
//              the live snapshot still held yesterday's bar.
// Not a fixed list of dead symbols: a stock that died on 10-14 had real
// signals before that.
if (process.argv.includes('--exclude-artifacts')) {
  const clock = { console }; vm.createContext(clock);
  vm.runInContext(read('core/clock.js') + '\nglobalThis.__tdb = tradingDaysBetween;', clock);
  const ptHHMM = t => new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' });
  const why = { stale: 0, openMin: 0, noTime: 0 };
  rows = rows.filter(r => {
    const newest = r.signal_snapshot.bars.map(b => b.t).sort().at(-1).slice(0, 10);
    const age = clock.__tdb(newest, r.signal_date);
    if (age > 1) { why.stale++; return false; }
    if (age === 1) {
      if (!r.first_shown_at) { why.noTime++; return true; } // can't tell: kept, and counted
      const hm = ptHHMM(r.first_shown_at);
      if (hm >= '06:30' && hm < '06:33') { why.openMin++; return false; }
    }
    return true;
  });
  console.log(`--exclude-artifacts: dropped ${why.stale} stale-history rows and ${why.openMin} open-minute rows (age-1 rows without a timestamp, kept: ${why.noTime})`);
}

let mismatches = 0;
const scored = [];
for (const r of rows) {
  const o = r.signal_snapshot;
  const snap = { latestTrade: { p: o.price }, dailyBar: { c: o.price, v: o.volume }, prevDailyBar: { c: o.prevClose } };
  const macro = o.macroCondition ? { condition: o.macroCondition, changes: null } : null;
  for (const c of [OLD, NEW]) { c.state.macroContext = macro; c.state.settings.disableMacroOverlay = false; }
  const args = [o.ticker, snap, o.bars, o.news || null, o.spyChange || 0, o.category || null];
  const a = OLD.__s(...args), b = NEW.__s(...args);
  if (!a || !b) continue;
  if (a.score !== o.score) mismatches++;
  scored.push({ date: r.signal_date, symbol: o.ticker, oldScore: a.score, newScore: b.score, price: o.price, tier: r.tier });
}

// one per (date, symbol): the highest OLD score
const best = new Map();
for (const s of scored) { const k = `${s.date}|${s.symbol}`; if (!best.has(k) || s.oldScore > best.get(k).oldScore) best.set(k, s); }
const sig = [...best.values()];
const dates = [...new Set(sig.map(s => s.date))].sort();

console.log(`signal_log EDGE rows with snapshots: ${rows.length}; re-scored: ${scored.length}; OLD re-score != stored score: ${mismatches}`);
console.log(`signals (one per date+symbol): ${sig.length} over ${dates.length} dates (${dates[0]} .. ${dates[dates.length - 1]})`);
if (mismatches) console.log(`!! ${mismatches} rows do not reproduce their stored score under ${BASE_COMMIT}; the old/new comparison is not exact for them.`);

// histograms, 5-pt bins
const bin = x => Math.floor(x / 5) * 5;
const hist = key => sig.reduce((m, s) => (m[bin(s[key])] = (m[bin(s[key])] || 0) + 1, m), {});
const ho = hist('oldScore'), hn = hist('newScore');
const bins = [...new Set([...Object.keys(ho), ...Object.keys(hn)].map(Number))].sort((x, y) => x - y);
console.log('\nHISTOGRAM (5-pt bins, one per date+symbol)\n  bin    old  new');
for (const k of bins) console.log(`  ${String(k).padStart(3)}  ${String(ho[k] || 0).padStart(5)} ${String(hn[k] || 0).padStart(4)}`);

const atLeast = (key, line) => sig.filter(s => s[key] >= line).length;
const newLines = {};
console.log('\nEQUAL-COUNT LINES');
for (const [name, L] of Object.entries(OLD_LINES)) {
  const target = atLeast('oldScore', L);
  if (target === 0) {
    newLines[name] = DECIDED_WHEN_UNDERIVABLE[name];
    console.log(`  ${name.padEnd(6)} old >=${L}: 0  ->  NOT DERIVABLE (no signal reached the old line). Using ${newLines[name]} by decision; new >=${newLines[name]}: ${atLeast('newScore', newLines[name])}`);
    continue;
  }
  let bestLine = null, bestGap = Infinity;
  for (let x = 0; x <= 200; x += 5) {
    const gap = Math.abs(atLeast('newScore', x) - target);
    if (gap < bestGap || (gap === bestGap && x > bestLine)) { bestGap = gap; bestLine = x; }
  }
  newLines[name] = bestLine;
  const near = [bestLine - 5, bestLine, bestLine + 5].map(x => `>=${x}: ${atLeast('newScore', x)}`).join(' | ');
  console.log(`  ${name.padEnd(6)} old >=${L}: ${target}  ->  new line ${bestLine} (${near})`);
}

const label = (score, lines) => score >= lines.STRONG ? 'STRONG' : score >= lines.SOFT ? 'SOFT' : score >= lines.WATCH ? 'WATCH' : 'below';
const oldL = OLD_LINES, newL = newLines;
const tier = p => p <= 3 ? '$1-3' : p <= 9 ? '$4-9' : '$10-20';
console.log(`\nPER DATE: buyable (SOFT+) and price-tier mix, old lines ${oldL.SOFT}/${oldL.STRONG} vs new ${newL.SOFT}/${newL.STRONG}`);
console.log('  date        old  new   old $1-3/$4-9/$10-20   new $1-3/$4-9/$10-20   STRONG old/new');
let totOld = 0, totNew = 0;
const mix = (list) => ['$1-3', '$4-9', '$10-20'].map(t => list.filter(s => tier(s.price) === t).length).join('/');
for (const d of dates) {
  const day = sig.filter(s => s.date === d);
  const bo = day.filter(s => s.oldScore >= oldL.SOFT), bn = day.filter(s => s.newScore >= newL.SOFT);
  totOld += bo.length; totNew += bn.length;
  const so = day.filter(s => s.oldScore >= oldL.STRONG).length, sn = day.filter(s => s.newScore >= newL.STRONG).length;
  console.log(`  ${d}  ${String(bo.length).padStart(3)}  ${String(bn.length).padStart(3)}   ${mix(bo).padEnd(20)}  ${mix(bn).padEnd(20)}  ${so}/${sn}`);
}
const allOld = sig.filter(s => s.oldScore >= oldL.SOFT), allNew = sig.filter(s => s.newScore >= newL.SOFT);
console.log(`  total       ${String(totOld).padStart(3)}  ${String(totNew).padStart(3)}   ${mix(allOld).padEnd(20)}  ${mix(allNew).padEnd(20)}  over ${dates.length} dates`);
console.log(`  SOFT+ (buyable) under the NEW formula at the OLD line ${oldL.SOFT}: ${atLeast('newScore', oldL.SOFT)} of ${atLeast('oldScore', oldL.SOFT)} (what step 2 would do without re-deriving the line)`);
console.log(`  WATCH+ (display) old >=${oldL.WATCH}: ${atLeast('oldScore', oldL.WATCH)}  new >=${newL.WATCH}: ${atLeast('newScore', newL.WATCH)}  (new formula at the OLD line ${oldL.WATCH}: ${atLeast('newScore', oldL.WATCH)})`);

// how labels move under the new formula + new lines
const moves = {};
for (const s of sig) { const k = `${label(s.oldScore, oldL)} -> ${label(s.newScore, newL)}`; moves[k] = (moves[k] || 0) + 1; }
console.log('\nLABEL MOVES (old formula+lines -> new formula+lines):');
for (const [k, v] of Object.entries(moves).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}`);
