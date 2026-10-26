#!/usr/bin/env node
// scripts/check-market-calendar.mjs — diff core/clock.js's hand-kept market
// calendar (HOLIDAYS, EARLY_CLOSES) against Alpaca's /v2/calendar, for EVERY
// year each table covers. Read-only; exits 1 on any difference.
//
//   node scripts/check-market-calendar.mjs
//
// Run it whenever tests/calendar-horizon.test.js fails (each autumn, when
// HOLIDAYS is under 90 days from its end): add next year's dates, then run
// this, so the annual task also verifies the years already there. A horizon
// guard can't see a hole in the middle. 2025-01-09 (the national day of
// mourning for President Carter) was missing for almost two years, and was
// found by this same comparison, done by hand on 2026-10-23 before it was
// saved here. A test can't call Alpaca, which is why this is a script.
//
// What it checks, per year:
//   HOLIDAYS     = every weekday Alpaca lists no session for. Missing and
//                  extra dates are both errors.
//   EARLY_CLOSES = every session closing before 16:00 ET, with its value
//                  (minutes after midnight PT = ET close minus 180; ET and PT
//                  change clocks on the same dates). Checked only for the
//                  years EARLY_CLOSES itself covers. Earlier HOLIDAYS years
//                  are reported as a NOTE, not an error: 2024-2025 are
//                  absent by decision (2026-10-23), since nothing stored
//                  predates 2026.
//
// CLAUDE.md pagination rule, proof: /v2/calendar takes no limit and returns
// no next_page_token; one request per calendar YEAR returns at most about
// 253 sessions. Each response is also checked for completeness (240-260
// rows, the last one in the year's final week), so a truncated or empty
// response is an error, never read as "every later weekday is a holiday".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { alpacaHeaders } from './lib/alpaca-bars.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(readFileSync(path.join(ROOT, 'core/clock.js'), 'utf8') + '\nglobalThis.__H = [...HOLIDAYS]; globalThis.__E = { ...EARLY_CLOSES };', ctx);
const HOLIDAYS = ctx.__H;
const EARLY_CLOSES = ctx.__E;

const yearsOf = dates => { const ys = dates.map(d => Number(d.slice(0, 4))); return [Math.min(...ys), Math.max(...ys)]; };
const [hFrom, hTo] = yearsOf(HOLIDAYS);
const [eFrom, eTo] = yearsOf(Object.keys(EARLY_CLOSES));
const headers = alpacaHeaders(ROOT);
const errors = [], notes = [];

for (let y = hFrom; y <= Math.max(hTo, eTo); y++) {
  const res = await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${y}-01-01&end=${y}-12-31`, { headers });
  const body = await res.json();
  if (!res.ok || !Array.isArray(body)) { errors.push(`${y}: /v2/calendar HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`); continue; }
  const last = body.map(d => d.date).sort().at(-1) || '';
  if (body.length < 240 || body.length > 260 || last < `${y}-12-24`) {
    errors.push(`${y}: /v2/calendar returned ${body.length} sessions ending ${last || 'nowhere'}: incomplete, not compared`);
    continue;
  }
  const sessions = new Map(body.map(d => [d.date, d.close]));
  const closed = [], early = {};
  for (let d = new Date(`${y}-01-01T12:00:00Z`); d.getUTCFullYear() === y; d.setUTCDate(d.getUTCDate() + 1)) {
    const s = d.toISOString().slice(0, 10), dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (!sessions.has(s)) closed.push(s);
    else if (sessions.get(s) !== '16:00') { const [h, m] = sessions.get(s).split(':').map(Number); early[s] = h * 60 + m - 180; }
  }
  const have = HOLIDAYS.filter(d => d.startsWith(String(y)));
  const missing = closed.filter(d => !have.includes(d)), extra = have.filter(d => !closed.includes(d));
  if (missing.length) errors.push(`${y}: HOLIDAYS is missing ${missing.join(' ')}`);
  if (extra.length) errors.push(`${y}: HOLIDAYS has ${extra.join(' ')}, which Alpaca lists as a session`);

  const haveE = Object.keys(EARLY_CLOSES).filter(d => d.startsWith(String(y)));
  if (y < eFrom) {
    if (Object.keys(early).length) notes.push(`${y}: before EARLY_CLOSES' coverage (starts ${eFrom}); not in the table: ${Object.keys(early).join(' ')}`);
  } else {
    for (const [d, min] of Object.entries(early)) {
      if (!(d in EARLY_CLOSES)) errors.push(`${y}: EARLY_CLOSES is missing ${d} (${min})`);
      else if (EARLY_CLOSES[d] !== min) errors.push(`${y}: EARLY_CLOSES['${d}'] is ${EARLY_CLOSES[d]}, Alpaca says ${min}`);
    }
    for (const d of haveE) if (!(d in early)) errors.push(`${y}: EARLY_CLOSES has ${d}, which Alpaca lists as a full session or a closure`);
  }
  console.log(`${y}: ${body.length} sessions | ${closed.length} weekday closures, ${Object.keys(early).length} early closes | HOLIDAYS ${missing.length || extra.length ? 'DIFFERS' : 'matches'}`);
}

notes.forEach(n => console.log('NOTE ' + n));
if (errors.length) { errors.forEach(e => console.log('ERROR ' + e)); process.exit(1); }
console.log(`OK: HOLIDAYS ${hFrom}-${hTo} and EARLY_CLOSES ${eFrom}-${eTo} match Alpaca's market calendar.`);
