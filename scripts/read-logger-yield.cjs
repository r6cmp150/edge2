// scripts/read-logger-yield.cjs -- the logger-observes yield, read from the committed signal_log backup (data/backups/
// signal_log, as of 90d51fe, 2026-11-19 14:48Z). Read only: reads files in this repository, writes nothing, no network.
// (The reviewer, 2026-11-19: anything whose result is acted on is run from the committed tree; it changed what Roman is
// told about the sign test.)
// Per trading day: the logger's first in-session scan (earliest EDGE SHOWN first_shown_at; an observation at the start
// of that run would precede every signal the day shows), minutes left to the close, signals shown, those with a close
// return, and the size of those returns. The calendar (holidays, early closes) is core/clock.js's, loaded for real.
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
//   node scripts/read-logger-yield.cjs
const c = {}; vm.createContext(c);
vm.runInContext(fs.readFileSync(path.join(root, 'core/clock.js'), 'utf8') + ';globalThis.__EC = EARLY_CLOSES;', c);
const rows = [];
for (const f of ['2026-10.json', '2026-11.json']) {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'data/backups/signal_log', f), 'utf8'));
  rows.push(...(Array.isArray(j) ? j : (j.rows || Object.values(j).find(Array.isArray))));
}
const edge = rows.filter(r => r.engine_source === 'EDGE' && r.tier === 'SHOWN');
const byDay = {};
for (const r of edge) (byDay[r.signal_date] = byDay[r.signal_date] || []).push(r);
const pt = ms => c.ptDateTimeOf(ms);
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const days = [];
for (let d = new Date('2026-10-13T12:00:00Z'); d <= new Date('2026-11-18T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
  const date = d.toISOString().slice(0, 10);
  if (c.classifySession(date, '10:00') === 'CLOSED') continue; // weekends and holidays, by the app's calendar
  const close = c.__EC[date] ?? 780;
  const sig = (byDay[date] || []).filter(r => c.classifySession(date, pt(Date.parse(r.first_shown_at)).hhmm) === 'REGULAR');
  const first = sig.length ? sig.map(r => Date.parse(r.first_shown_at)).sort((a, b) => a - b)[0] : null;
  const withRet = sig.filter(r => r.ret_close != null && r.ret_close_split_in_window !== true);
  const meanAbs = withRet.length ? withRet.reduce((a, r) => a + Math.abs(100 * r.ret_close), 0) / withRet.length : null;
  days.push({ date, first: first ? pt(first).hhmm : null, left: first ? close - toMin(pt(first).hhmm) : null, shown: sig.length, withRet: withRet.length, meanAbs });
}
const show = (label, ds) => {
  console.log(`\n${label}: ${ds.length} trading days`);
  console.log('date        first  min-left  shown  w/close-ret  mean|ret| pts');
  for (const x of ds) console.log(`${x.date}  ${x.first || ' -   '}  ${x.left == null ? '   -' : String(x.left).padStart(5)}     ${String(x.shown).padStart(4)}   ${String(x.withRet).padStart(6)}       ${x.meanAbs == null ? '  -' : x.meanAbs.toFixed(2)}`);
  const fired = ds.filter(x => x.first), counting = fired.filter(x => x.withRet > 0);
  console.log(`fired in session: ${fired.length} of ${ds.length}; with shown signals carrying a close return: ${counting.length} of ${ds.length}`);
  const buckets = [['before 10:00', 0, 600], ['10:00-10:59', 600, 660], ['11:00-11:59', 660, 720], ['12:00-close', 720, 2000]];
  for (const [name, lo, hi] of buckets) {
    const b = counting.filter(x => toMin(x.first) >= lo && toMin(x.first) < hi);
    const m = b.length ? b.reduce((a, x) => a + x.meanAbs, 0) / b.length : null;
    console.log(`  first scan ${name.padEnd(12)}: ${b.length} day(s)${b.length ? `, mean of daily mean|ret| ${m.toFixed(2)} pts, minutes left ${Math.min(...b.map(x => x.left))}-${Math.max(...b.map(x => x.left))}` : ''}`);
  }
};
show('Since the cron re-aim (3729de6, 2026-10-26): 10-27 to 11-18', days.filter(x => x.date >= '2026-10-27'));
show('Longer window, for comparison: 10-13 to 11-18', days);
