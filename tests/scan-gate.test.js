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
