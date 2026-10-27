// tests/scan-gate.test.js — scripts/lib/scan-gate.mjs's decideScheduledScan,
// the rule that replaced both loggers' fixed-target windows (2026-10-09):
// scan iff the regular session is open and no scan of this engine started
// within the last SPACING_MIN minutes.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');

run('scan gate: open session + 30-min spacing', async () => {
  const { decideScheduledScan, SPACING_MIN } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/scan-gate.mjs')).href);
  assert.strictEqual(SPACING_MIN, 30);
  const now = Date.parse('2026-10-09T14:00:00Z'); // 7:00am PDT
  const base = { dateStr: '2026-10-09', hhmm: '07:00', nowMs: now };

  // Open, nothing today -> scan. This is the case the old ±10-min window
  // turned into a silent no-op on almost every delivery.
  assert.strictEqual(decideScheduledScan({ ...base, sessionClass: 'REGULAR', recentStartedAts: [] }).proceed, true);

  // Not regular session -> no-op, whatever the history.
  for (const s of ['PRE_MARKET', 'AFTER_HOURS', 'CLOSED']) {
    const d = decideScheduledScan({ ...base, sessionClass: s, recentStartedAts: [] });
    assert.strictEqual(d.proceed, false);
    assert.match(d.reason, new RegExp(s));
  }

  // Spacing: 29 min ago blocks, exactly 30 min ago allows, 2h ago allows.
  const ago = (min) => new Date(now - min * 60000).toISOString();
  assert.strictEqual(decideScheduledScan({ ...base, sessionClass: 'REGULAR', recentStartedAts: [ago(29)] }).proceed, false);
  assert.strictEqual(decideScheduledScan({ ...base, sessionClass: 'REGULAR', recentStartedAts: [ago(30)] }).proceed, true);
  assert.strictEqual(decideScheduledScan({ ...base, sessionClass: 'REGULAR', recentStartedAts: [ago(120), ago(90)] }).proceed, true);
  // One recent row among older ones still blocks.
  assert.strictEqual(decideScheduledScan({ ...base, sessionClass: 'REGULAR', recentStartedAts: [ago(120), ago(5)] }).proceed, false);
});

// Per-engine spacing (2026-10-27). Warrior's re-aimed slots aim 15 min
// apart; at a shared 30 min, at most 4 of its 7 could ever scan. Two
// deliveries 40 min apart both scan for either engine.
run('scan gate: spacing per engine (EDGE 30, Warrior 15), and 40 min apart always both scan', async () => {
  const { decideScheduledScan, spacingMinFor, SPACING_MIN_BY_ENGINE } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/scan-gate.mjs')).href);
  assert.deepStrictEqual(SPACING_MIN_BY_ENGINE, { EDGE: 30, WARRIOR: 15 });
  assert.strictEqual(spacingMinFor('EDGE'), 30);
  assert.strictEqual(spacingMinFor('WARRIOR'), 15);
  assert.strictEqual(spacingMinFor('SOMETHING_NEW'), 30, 'unknown engine: the conservative default');
  const now = Date.parse('2026-11-02T15:00:00Z'); // 7:00am PST
  const base = { dateStr: '2026-11-02', hhmm: '07:00', nowMs: now, sessionClass: 'REGULAR' };
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const go = (eng, min) => decideScheduledScan({ ...base, recentStartedAts: [ago(min)], spacingMin: spacingMinFor(eng) }).proceed;
  assert.strictEqual(go('WARRIOR', 16), true, 'Warrior: a slot 16 min after a scan runs');
  assert.strictEqual(go('WARRIOR', 14), false);
  assert.strictEqual(go('EDGE', 16), false, 'EDGE keeps 30');
  assert.strictEqual(go('EDGE', 40) && go('WARRIOR', 40), true, '40 min apart: both scan, either engine');
  // Both loggers take the gate's own spacing, never a shared constant.
  const fs = require('fs');
  for (const f of ['scripts/log-signals-edge.mjs', 'scripts/log-signals-warrior.mjs']) {
    const s = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    assert.ok(!/\bSPACING_MIN\b/.test(s), `${f} still reads the shared SPACING_MIN`);
  }
  const gate = fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/scan-gate.mjs'), 'utf8');
  assert.ok(gate.includes('const spacingMin = spacingMinFor(engineSource);') && gate.includes('recentStartedAts, spacingMin });'), 'the I/O wrapper passes the per-engine spacing');
});
