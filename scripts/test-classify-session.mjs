#!/usr/bin/env node
// Unit tests for core/clock.js's classifySession() -- pure, no network.
// Same check()/fail-loud pattern as scripts/test-hardfail-negative-control.mjs.
// Loaded via the same eval+stripExportSyntax-free approach fill-outcomes.mjs
// uses for core/*.js (classic scripts, no export statements to strip here).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clockSrc = readFileSync(path.join(REPO_ROOT, 'core', 'clock.js'), 'utf8');
// eslint-disable-next-line no-eval
eval(clockSrc + '\nglobal.classifySession = classifySession;');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`[PASS] ${label}`);
  else { console.error(`[FAIL] ${label}${detail ? ' -- ' + detail : ''}`); failures++; }
}

// Real rows, phase-9-entry-exit-spec.md §0.4/§1.3 -- pulled live from
// trades_v2 2026-09-15.
check('TENX (bought 16:25 PT on a Tuesday) -> AFTER_HOURS',
  global.classifySession('2026-08-25', '16:25') === 'AFTER_HOURS');
check('KEEL (bought 14:06 PT) -> AFTER_HOURS',
  global.classifySession('2026-08-17', '14:06') === 'AFTER_HOURS');
check('NEOG (bought 14:12 PT) -> AFTER_HOURS',
  global.classifySession('2026-08-19', '14:12') === 'AFTER_HOURS');

// Boundary values -- exact window edges, both sides.
check('06:29am (389 min, just before open) -> PRE_MARKET', global.classifySession('2026-08-17', '06:29') === 'PRE_MARKET');
check('06:30am (390 min, open) -> REGULAR', global.classifySession('2026-08-17', '06:30') === 'REGULAR');
check('12:59pm (779 min, last regular minute) -> REGULAR', global.classifySession('2026-08-17', '12:59') === 'REGULAR');
check('01:00pm (780 min, close) -> AFTER_HOURS', global.classifySession('2026-08-17', '13:00') === 'AFTER_HOURS');
check('04:59pm (1019 min, last AH minute) -> AFTER_HOURS', global.classifySession('2026-08-17', '16:59') === 'AFTER_HOURS');
check('05:00pm (1020 min) -> CLOSED', global.classifySession('2026-08-17', '17:00') === 'CLOSED');
check('12:59am (59 min, just before PRE_MARKET) -> CLOSED', global.classifySession('2026-08-17', '00:59') === 'CLOSED');
check('01:00am (60 min) -> PRE_MARKET', global.classifySession('2026-08-17', '01:00') === 'PRE_MARKET');

// Weekend / holiday overrides -- CLOSED regardless of time-of-day.
check('Saturday at 10:00am PT -> CLOSED (weekend overrides time-of-day)', global.classifySession('2026-08-22', '10:00') === 'CLOSED');
check('Sunday at 10:00am PT -> CLOSED', global.classifySession('2026-08-23', '10:00') === 'CLOSED');
check('2026-09-07 (Labor Day, a Monday, in HOLIDAYS) at 10:00am PT -> CLOSED', global.classifySession('2026-09-07', '10:00') === 'CLOSED');

// Early closes (day after Thanksgiving, Christmas Eve -- both 10:00am PT).
check('2026-11-27 (day after Thanksgiving) at 09:59am PT -> REGULAR (before the early close)', global.classifySession('2026-11-27', '09:59') === 'REGULAR');
check('2026-11-27 at 10:00am PT -> AFTER_HOURS (the early close itself)', global.classifySession('2026-11-27', '10:00') === 'AFTER_HOURS');
check('2026-11-27 at 12:30pm PT -> AFTER_HOURS (still within the 4h extended session after an early close)', global.classifySession('2026-11-27', '12:30') === 'AFTER_HOURS');
check('2026-11-27 at 02:00pm PT -> CLOSED (4h after a 10am close is 2pm)', global.classifySession('2026-11-27', '14:00') === 'CLOSED');
check('2026-11-27 at 01:00pm PT -> AFTER_HOURS (would be REGULAR on a normal day -- the bug this fix closes)', global.classifySession('2026-11-27', '13:00') === 'AFTER_HOURS');
check('2026-12-24 (Christmas Eve) at 10:00am PT -> AFTER_HOURS', global.classifySession('2026-12-24', '10:00') === 'AFTER_HOURS');
check('A normal (non-early-close) day at 01:00pm PT is still REGULAR-boundary AFTER_HOURS, unaffected by EARLY_CLOSES', global.classifySession('2026-08-17', '13:00') === 'AFTER_HOURS');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
