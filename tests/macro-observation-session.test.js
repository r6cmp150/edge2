// tests/macro-observation-session.test.js -- 2026-11-19 (the reviewer). An observation is written only if the regular
// session is open AT THE INSTANT ITS QUOTES ARE READ (core/macro.js macroObservationSession), checked on its own: a
// row that labels nothing must never sit in the data looking like a reading. The five clock cases, on a fixed clock,
// with the real core/clock.js (the calendar, early closes) and the real scan gate (scripts/lib/scan-gate.mjs).
// All instants are written in UTC; November is PST (UTC-8).
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

const c = {};
vm.createContext(c);
vm.runInContext(readSource('core/clock.js'), c);
vm.runInContext(readSource('core/macro.js') + '\n;globalThis.__session = macroObservationSession;', c);
const at = iso => c.__session(Date.parse(iso));

(async () => {

await run('1. a normal day: 12:59 PT writes; 13:00:00 PT does not (the close)', () => {
  const open = at('2026-11-19T20:59:59Z');
  assert.deepStrictEqual([open.allowed, open.session, open.hhmm], [true, 'REGULAR', '12:59']);
  const shut = at('2026-11-19T21:00:00Z');
  assert.deepStrictEqual([shut.allowed, shut.session, shut.hhmm], [false, 'AFTER_HOURS', '13:00']);
  assert.ok(/^no observation: AFTER_HOURS at 2026-11-19 13:00 PT/.test(shut.why), shut.why);
  assert.strictEqual(at('2026-11-19T14:29:00Z').allowed, false, 'before the open (06:29 PT) neither');
  assert.strictEqual(at('2026-11-19T14:30:00Z').allowed, true, 'from the open (06:30 PT)');
});

await run('2. the early close, 11-27: 09:59 PT writes; 10:00 PT does not', () => {
  assert.strictEqual(at('2026-11-27T17:59:00Z').allowed, true);
  const shut = at('2026-11-27T18:00:00Z');
  assert.deepStrictEqual([shut.allowed, shut.session], [false, 'AFTER_HOURS'], 'closed at 10:00 PT, though 10:00 is mid-session on a normal day');
});

await run('3. a holiday (11-26) and a Saturday never write, at any hour', () => {
  for (const iso of ['2026-11-26T15:00:00Z', '2026-11-26T18:00:00Z', '2026-11-26T20:30:00Z', '2026-11-21T15:00:00Z', '2026-11-21T18:00:00Z']) {
    const s = at(iso);
    assert.deepStrictEqual([s.allowed, s.session], [false, 'CLOSED'], iso);
  }
});

await run('4. a manual run after the close: the rule has no trigger input, so a dispatch cannot bypass it', () => {
  // The gate is skipped for workflow_dispatch (log-signals-edge.mjs); this rule never sees the trigger at all.
  const src = readSource('core/macro.js');
  const fn = src.slice(src.indexOf('function macroObservationSession('), src.indexOf('\n}\n', src.indexOf('function macroObservationSession(')));
  assert.ok(/^function macroObservationSession\(atMs\) \{/.test(fn), 'its only input is the instant');
  assert.ok(!/GITHUB_EVENT_NAME|process\.env|trigger|schedule|dispatch/.test(fn.replace(/^\s*\/\/.*$/gm, '')), 'no trigger read');
  assert.strictEqual(at('2026-11-19T22:30:00Z').allowed, false, 'a dispatch at 14:30 PT: no observation');
});

await run('5. the gate passes at 12:59:50 PT, the quotes are read at 13:00:05 PT: no observation', async () => {
  const { decideScheduledScan } = await import('../scripts/lib/scan-gate.mjs');
  const gateAt = Date.parse('2026-11-19T20:59:50Z');
  const g = c.ptDateTimeOf(gateAt);
  const gate = decideScheduledScan({ dateStr: g.date, hhmm: g.hhmm, sessionClass: c.classifySession(g.date, g.hhmm), nowMs: gateAt, recentStartedAts: [] });
  assert.strictEqual(gate.proceed, true, 'the run is let in');
  const quotes = at('2026-11-19T21:00:05Z');
  assert.deepStrictEqual([quotes.allowed, quotes.session], [false, 'AFTER_HOURS'], 'and its quotes, read after the close, write nothing');
});

})();
