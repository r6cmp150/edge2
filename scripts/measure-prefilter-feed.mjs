// scripts/measure-prefilter-feed.mjs -- what the EDGE pre-filter would pass
// if its volume test read the full market (SIP, 15 minutes lagged) instead
// of IEX (one venue). Phase-10 spec §7.3. Measure before deciding.
//
//   node scripts/measure-prefilter-feed.mjs
//
// The live filter: price $1-$20 and volume >= 100,000, both from a
// /stocks/snapshots dailyBar with feed:'iex'. This rebuilds that from
// 1-minute bars for the 239-symbol universe (STOCK_UNIVERSES.OTHER, read
// from app.js by the logger's own text anchor), on both feeds, for the
// pinned DATES, and reports for each test time:
//   iex      the live rule, reconstructed: IEX price, IEX volume so far
//   sipLag   the proposal: IEX price (unchanged), SIP volume up to T-15min,
//            a LOWER BOUND on volume so far (cumulative volume only grows)
//   sipNow   reference only: SIP volume up to T (not readable live)
//
// It CALIBRATES FIRST: the reconstructed iex count is compared with what
// the real logger passed (scan_runs.evaluated_count) at the real scan
// times. If the reconstruction doesn't match, the comparison means nothing,
// so it says so.
//
// Model of the snapshot at time T, chosen by that calibration:
//   - today's IEX bars up to T exist  -> dailyBar = today: volume = sum of
//     today's IEX bars from SESSION_START to T, price = last close.
//   - no IEX bar yet today            -> dailyBar is still YESTERDAY's:
//     yesterday's full IEX volume and close (why the 06:30 scans pass more
//     symbols than the 07:00 ones).
// Read-only Alpaca requests; every list is paginated to exhaustion.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const H = { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY };
const SUPA_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPA_KEY = readFileSync(path.join(ROOT, 'core', 'store.js'), 'utf8').match(/sb_publishable_[A-Za-z0-9_]+/)[0];

const DATES = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21'];
const PREV = { '2026-10-13': '2026-10-10', '2026-10-14': '2026-10-13', '2026-10-15': '2026-10-14', '2026-10-16': '2026-10-15', '2026-10-19': '2026-10-16', '2026-10-20': '2026-10-19', '2026-10-21': '2026-10-20' };
const TIMES_PT = ['06:35', '06:40', '06:45', '07:00', '07:28', '07:30', '08:00', '10:00', '12:00'];
const MIN_PRICE = 1, MAX_PRICE = 20, MIN_VOL = 100000, LAG_MIN = 15;
const PDT_OFFSET_H = 7; // all DATES are in PDT

// Universe: the same text-anchored block the logger evaluates.
const appLines = readFileSync(path.join(ROOT, 'app.js'), 'utf8').split('\n').map(l => l.replace(/\r$/, ''));
const a = appLines.indexOf('const STOCK_UNIVERSES = {');
const b = appLines.indexOf('};', a);
const STOCK_UNIVERSES = new Function(appLines.slice(a, b + 1).join('\n') + '\nreturn STOCK_UNIVERSES;')();
const UNIVERSE = STOCK_UNIVERSES.OTHER;

const ptToUtc = (date, hhmm) => new Date(`${date}T${hhmm}:00Z`).getTime() + PDT_OFFSET_H * 3600e3;

async function getAll(url) {
  const out = {};
  let token = null, pages = 0;
  do {
    const res = await fetch(url + (token ? `&page_token=${token}` : ''), { headers: H });
    const body = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    for (const [s, bars] of Object.entries(body.bars || {})) (out[s] ||= []).push(...bars);
    token = body.next_page_token; pages++;
  } while (token);
  return { bars: out, pages };
}
async function minuteBars(feed, date) {
  const all = {};
  for (let i = 0; i < UNIVERSE.length; i += 100) {
    const syms = UNIVERSE.slice(i, i + 100).join(',');
    const { bars } = await getAll(`https://data.alpaca.markets/v2/stocks/bars?symbols=${syms}&timeframe=1Min&start=${date}T08:00:00Z&end=${date}T19:30:00Z&feed=${feed}&limit=10000&adjustment=raw&sort=asc`);
    Object.assign(all, bars);
  }
  return all;
}
async function dailyBars(feed, date) {
  const all = {};
  for (let i = 0; i < UNIVERSE.length; i += 100) {
    const syms = UNIVERSE.slice(i, i + 100).join(',');
    const { bars } = await getAll(`https://data.alpaca.markets/v2/stocks/bars?symbols=${syms}&timeframe=1Day&start=${date}&end=${date}&feed=${feed}&limit=10000&adjustment=raw`);
    Object.assign(all, bars);
  }
  return all;
}

// volume of a symbol's bars with start time in [fromMs, toMs]
const sumVol = (bars, fromMs, toMs) => (bars || []).reduce((s, x) => { const t = Date.parse(x.t); return t >= fromMs && t <= toMs ? s + x.v : s; }, 0);
const lastClose = (bars, toMs, fromMs) => { let c = null; for (const x of bars || []) { const t = Date.parse(x.t); if (t >= fromMs && t <= toMs) c = x.c; } return c; };

function counts(day, date, T, sessionStartUtcMs, switchFromUtcMs) {
  let iex = 0, sipLag = 0, sipNow = 0, lagExcludesReal = 0;
  for (const s of UNIVERSE) {
    const ib = day.iex[s];
    // Has the snapshot's dailyBar switched from yesterday to today yet?
    const todayIex = lastClose(ib, T, switchFromUtcMs);
    let price, iexVol;
    if (todayIex == null) { price = day.prevIex[s]?.[0]?.c ?? null; iexVol = day.prevIex[s]?.[0]?.v ?? 0; } // still yesterday's bar
    else { price = todayIex; iexVol = sumVol(ib, sessionStartUtcMs, T); }
    const priceOk = price != null && price >= MIN_PRICE && price <= MAX_PRICE;
    if (!priceOk) continue;
    if (iexVol >= MIN_VOL) iex++;
    const lagVol = sumVol(day.sip[s], sessionStartUtcMs, T - LAG_MIN * 60e3);
    const nowVol = sumVol(day.sip[s], sessionStartUtcMs, T);
    if (lagVol >= MIN_VOL) sipLag++;
    if (nowVol >= MIN_VOL) sipNow++;
    if (nowVol >= MIN_VOL && lagVol < MIN_VOL) lagExcludesReal++;
  }
  return { iex, sipLag, sipNow, lagExcludesReal };
}

const logged = await (await fetch(`${SUPA_URL}/rest/v1/scan_runs?engine_source=eq.EDGE&session=eq.OPEN&scan_date=gte.${DATES[0]}&scan_date=lte.${DATES[DATES.length - 1]}&select=scan_date,started_at,evaluated_count&order=started_at.asc`, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } })).json();

console.log(`universe: ${UNIVERSE.length} symbols (STOCK_UNIVERSES.OTHER); dates: ${DATES.join(', ')}; price $${MIN_PRICE}-$${MAX_PRICE}, volume >= ${MIN_VOL.toLocaleString()}, SIP lag ${LAG_MIN} min`);
const days = {};
for (const date of DATES) {
  const [iex, sip, prevIex] = await Promise.all([minuteBars('iex', date), minuteBars('sip', date), dailyBars('iex', PREV[date])]);
  days[date] = { iex, sip, prevIex };
}

// Calibration. Two unknowns about the live snapshot: which trades its
// dailyBar volume counts (regular session only, or pre-market too), and when
// its dailyBar switches from yesterday to today (first trade of the day, or
// first regular-session trade). Each combination is scored against the real
// logger's counts, and the best one is used below.
const MODELS = [];
for (const [vLabel, vStart] of [['volume from 06:30 PT', '06:30'], ['volume from 01:00 PT', '01:00']]) {
  for (const [sLabel, sFrom] of [['bar switches at first trade', '01:00'], ['bar switches at first regular trade', '06:30']]) {
    MODELS.push({ label: `${vLabel}, ${sLabel}`, hhmm: vStart, sw: sFrom });
  }
}
console.log('\nCALIBRATION: logged evaluated_count vs reconstructed IEX count at the same instant');
let best = null;
for (const m of MODELS) {
  let absErr = 0, bias = 0;
  const rows = [];
  for (const r of logged) {
    if (!days[r.scan_date]) continue;
    const T = Date.parse(r.started_at);
    const c = counts(days[r.scan_date], r.scan_date, T, ptToUtc(r.scan_date, m.hhmm), ptToUtc(r.scan_date, m.sw));
    absErr += Math.abs(c.iex - r.evaluated_count);
    bias += c.iex - r.evaluated_count;
    rows.push(`${r.scan_date} ${new Date(T - PDT_OFFSET_H * 3600e3).toISOString().slice(11, 16)} logged ${String(r.evaluated_count).padStart(3)} rebuilt ${String(c.iex).padStart(3)}`);
  }
  console.log(`  ${m.label.padEnd(58)} total |error| ${String(absErr).padStart(3)}, bias ${bias >= 0 ? '+' : ''}${bias} over ${rows.length} scans`);
  if (!best || absErr < best.absErr) best = { ...m, absErr, bias, rows };
}
console.log(`  using: ${best.label}`);
best.rows.forEach(r => console.log('    ' + r));
const n = best.rows.length;
console.log(`  mean |error| ${(best.absErr / n).toFixed(1)} symbols per scan, mean bias ${(best.bias / n).toFixed(1)} (negative = the rebuild passes fewer than the live filter did)`);

console.log(`\nPASS COUNTS per test time, of ${UNIVERSE.length} (median over ${DATES.length} dates; per-date in brackets)`);
console.log('  time PT   iex (live rule)             sipLag (proposal)              sipNow (reference)             lag excludes (sipNow, not sipLag)');
for (const hhmm of TIMES_PT) {
  const per = DATES.map(d => counts(days[d], d, ptToUtc(d, hhmm), ptToUtc(d, best.hhmm), ptToUtc(d, best.sw)));
  const col = k => { const v = per.map(p => p[k]); const m = [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)]; return `${String(m).padStart(3)} [${v.join(',')}]`.padEnd(31); };
  console.log(`  ${hhmm}     ${col('iex')}${col('sipLag')}${col('sipNow')}${col('lagExcludesReal')}`);
}
