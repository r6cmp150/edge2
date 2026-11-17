#!/usr/bin/env node
// scripts/count-macro-observations.mjs -- 2026-11-12, landing (c). The macro sign-test's input is macro_observations, and
// nothing wrote it before (c). A clock that starts silently can run for a month at zero (the 14 unsaved scan rows were
// found only when Roman read his banner list), so this counts the writer's output every day (backup-tables.yml) and goes
// RED when the writer should be writing and isn't. READ-ONLY: GET with the anon key.
//
// A count of 0 on a table whose writes are new cannot tell "not written" from "not readable", so the CONTROL comes from
// another table the same scans write. After (c), every scan stamps rating_snapshots.macro_path from core/store.js's
// MACRO_PATHS, never 'unknown' (main before (c) wrote only the column's DEFAULT, 'unknown'). So:
//   scans by an observing build   rating_snapshots rows with macro_path <> 'unknown'
//   their observations            the distinct macro_observation_id they carry; every one must be readable here
//   a decided reading, no id      macro_path pattern/groq/pattern_groq_failed/unclassified with no id: the write failed
// Exit 0: counted and consistent, or no scan by an observing build yet (said as NOT STARTED, never as zero).
// Exit 1: a read failed or came back incomplete; scans by an observing build exist but an observation they point to
//         cannot be read; or decided readings were recorded with no observation. The reason is printed above.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { buildDays, barState, MIN_DAYS, MIN_DAYS_AWAY_FROM_COMMON_SIGN } from './lib/macro-sign-test.mjs';
import { assertReadable } from './lib/readable.mjs';

// 2026-11-17, INSTRUMENTATION OF THE REGISTERED BAR, NOT AN AMENDMENT TO IT (the reviewer). The bar is two conditions,
// 20 labelled days AND at least 5 away from the most common sign; a counter of the first alone says "on track" until
// the day it says "inconclusive". So both are printed, each counted by the registration's own code: buildDays (a day's
// label is its first Groq answer given the moves; a day counts only with shown EDGE signals first shown at or after
// it, with a close return) and barState, on core/edge-scoring.js's MACRO_ADJUSTMENTS, exactly as
// scripts/run-macro-sign-test.mjs runs the test. Counts and reasons only: no day's outcome is printed (reading the
// outcomes before the bar is met is the look the registration exists to prevent). It never changes the exit code on
// its own: a bar not yet met is a state, not a defect. A read that fails or is denied is.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The declared ending's cap (STATUS, "Declared 2026-11-17, before the bar was met"). Part of the registration as
// declared that day, not a parameter: changing it is an amendment, and an amendment is dated in STATUS first.
const ENDING_CAP = 40;
function macroAdjustments() {
  const edge = readFileSync(path.join(ROOT, 'core/edge-scoring.js'), 'utf8');
  const at = edge.indexOf('const MACRO_ADJUSTMENTS = {');
  const c = {};
  vm.createContext(c);
  vm.runInContext(edge.slice(at, edge.indexOf('\n};\n', at) + 4) + ';globalThis.T = MACRO_ADJUSTMENTS;', c);
  return c.T;
}

const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
const DECIDED = ['pattern', 'groq', 'pattern_groq_failed', 'unclassified']; // a reading ran; not_fetched: the quotes failed

// Every row of a query, paged, with the Content-Range total checked against what was read.
async function readAll(table, columns, filter, fetchImpl) {
  const out = [];
  let total = null;
  for (let from = 0; ; from += 1000) {
    const r = await fetchImpl(`${SUPABASE_URL}/rest/v1/${table}?select=${columns}${filter}&order=id.asc`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Range: `${from}-${from + 999}`, Prefer: 'count=exact' } });
    if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${await r.text()}`);
    const m = String(r.headers.get('content-range') || '').match(/\/(\d+)$/);
    if (!m) throw new Error(`${table}: no row count back, so completeness is unknown`);
    total = Number(m[1]);
    const page = await r.json();
    out.push(...page);
    if (out.length >= total || page.length < 1000) break;
  }
  if (out.length !== total) throw new Error(`${table}: read ${out.length} rows of ${total}`);
  return out;
}

export async function main({ fetchImpl = fetch, log = console.log, now = new Date() } = {}) {
  let scans, observations;
  try {
    scans = await readAll('rating_snapshots', 'id,captured_at,macro_path,macro_observation_id', '&macro_path=neq.unknown', fetchImpl);
    // + the columns the bar's label rule reads (firstLabel)
    observations = await readAll('macro_observations', 'id,fetched_at,trading_date,applied,pattern_condition,pattern_incomplete,groq_condition', '', fetchImpl);
  } catch (e) {
    log(`macro_observations count: COULD NOT READ (${e.message}) -- whether the macro reading is being recorded is unknown.`);
    return 1;
  }
  const at = `live at ${now.toISOString()}`;
  if (!scans.length) {
    log(`macro_observations count, ${at}: NOT STARTED -- no scan by a build that observes the macro (rating_snapshots has no macro_path other than 'unknown'). ${observations.length} observation(s) read.`);
    return 0;
  }
  const ids = new Set(observations.map(o => o.id));
  const pointed = [...new Set(scans.map(s => s.macro_observation_id).filter(Boolean))];
  const unreadable = pointed.filter(id => !ids.has(id));
  const decidedNoId = scans.filter(s => DECIDED.includes(s.macro_path) && !s.macro_observation_id);
  const notFetched = scans.filter(s => s.macro_path === 'not_fetched').length;
  const newest = observations.reduce((a, o) => (!a || String(o.fetched_at) > String(a.fetched_at) ? o : a), null);
  const days = new Set(observations.map(o => o.trading_date)).size;
  const firstScan = scans.reduce((a, s) => (!a || String(s.captured_at) < String(a) ? s.captured_at : a), null);
  log(`macro_observations count, ${at}: ${observations.length} observation(s) on ${days} trading day(s); newest ${newest ? newest.fetched_at : 'none'}.`);
  log(`  control: ${scans.length} rating_snapshots row(s) from observing builds since ${firstScan}, pointing to ${pointed.length} observation(s); ${notFetched} scanned with the quotes not fetched.`);
  let bad = false;
  if (unreadable.length) { log(`  DEFECT ${unreadable.length} observation(s) the scans point to cannot be read here (denied, or lost): ${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? ', ...' : ''}`); bad = true; }
  if (decidedNoId.length) { log(`  DEFECT ${decidedNoId.length} scan row(s) recorded a decided macro reading with no observation: the observation write failed (the banner said so on the phone).`); bad = true; }
  if (!observations.length && scans.some(s => DECIDED.includes(s.macro_path))) { log('  DEFECT scans by an observing build recorded decided readings, and macro_observations reads back empty: not written, or not readable.'); bad = true; }

  // Both halves of the bar.
  if (observations.length) {
    let signals;
    try {
      // signal_log can't be empty (tests/empty-read-controls.test.js): a denied read would otherwise drop every day as
      // "no shown signal" and report 0 labelled days as if counted.
      await assertReadable(SUPABASE_URL, { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, 'signal_log', fetchImpl);
      signals = await readAll('signal_log', 'id,signal_date,engine_source,tier,first_shown_at,ret_close,ret_close_split_in_window',
        // from (c)'s first observation day: no observation, so no label, exists before it (a constant the column walker can read)
        '&engine_source=eq.EDGE&tier=eq.SHOWN&signal_date=gte.2026-11-12', fetchImpl);
    } catch (e) {
      log(`  sign-test bar: COULD NOT READ signal_log (${e.message}) -- neither half of the bar can be counted.`);
      return 1;
    }
    const { days, dropped } = buildDays(observations, signals, macroAdjustments());
    const b = barState(days);
    log(`  sign-test bar (scripts/lib/macro-sign-test.mjs, the registration, unchanged): labelled days ${b.n} of ${MIN_DAYS}; ` +
        `by predicted sign + ${b.plus}, - ${b.minus}, 0 ${b.zero}; away from the most common sign ${b.awayFromCommon} of ${MIN_DAYS_AWAY_FROM_COMMON_SIGN}; ${b.met ? 'BAR MET' : 'not met'}.`);
    log(`  not labelled: ${dropped.length ? dropped.map(d => `${d.date} (${d.reason})`).join('; ') : 'none'}.`);
    // THE DECLARED ENDING (STATUS, "Declared 2026-11-17, before the bar was met"): from 20 labelled days, the window
    // extends until 5 are away from the most common sign or 40 labelled days, whichever comes first; at 40 with fewer
    // than 5 away, cannot conclude, and the test is closed. Judged on the first 40 labelled days in date order, so a
    // day after the close cannot reopen it. Counts only, as above.
    if (b.n >= MIN_DAYS) {
      const firstCap = days.slice().sort((x, y) => String(x.date).localeCompare(String(y.date))).slice(0, ENDING_CAP);
      const c = barState(firstCap);
      const state = c.met ? `BAR MET (${c.n} labelled days, ${c.awayFromCommon} away): the test may be run`
        : c.n >= ENDING_CAP ? `CANNOT CONCLUDE -- the reading did not vary enough to be tested: ${ENDING_CAP} labelled days, ${c.awayFromCommon} of ${MIN_DAYS_AWAY_FROM_COMMON_SIGN} away (+ ${c.plus}, - ${c.minus}, 0 ${c.zero}); the sign-test is closed`
        : `EXTENDED: ${c.n} of at most ${ENDING_CAP} labelled days, ${c.awayFromCommon} of ${MIN_DAYS_AWAY_FROM_COMMON_SIGN} away; it ends at 5 away or at ${ENDING_CAP} days`;
      log(`  declared ending (2026-11-17): ${state}.`);
    }
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
