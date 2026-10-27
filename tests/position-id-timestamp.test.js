// tests/position-id-timestamp.test.js — 2026-10-27. A position's id is
// generated as Date.now() for uniqueness, and that format became load-bearing
// without anyone deciding it should: the id is the join key to
// signal_snapshot_at_buy (db/033), the unique trades_v2.position_id that
// makes a sale retry safe, AND the record of when the add happened, which
// scripts/audit-recording-lag.cjs parses as a timestamp. A switch to
// crypto.randomUUID() would serve the first two and silently end the third.
// This evaluates the id expression actually written at each add site and
// requires a plausible epoch-ms value the audit's own parse accepts. To
// change the format, store the add time explicitly in the same change and
// update this test and the audit together.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const SITES = [
  ['app.js', 'finalizeAddPortfolio'],
  ['engines/warrior/index.js', '_confirmAddPosition'],
];
// The audit's own rule (scripts/audit-recording-lag.cjs).
const audit = readSource('scripts/audit-recording-lag.cjs');
const parseRule = audit.match(/const id = Number\(p\.position_id\); const t = Number\.isFinite\(id\) && id > ([\d.e]+) \? id :/);

run('the audit still reads position_id as epoch ms', () => {
  assert.ok(parseRule, 'audit-recording-lag.cjs no longer parses position_id as a timestamp: update this test with it');
});

run('every add site generates an id the audit can date (epoch ms, now)', () => {
  const floor = Number(parseRule[1]);
  for (const [file, fn] of SITES) {
    const src = readSource(file);
    const i = src.search(new RegExp(`(async )?function ${fn}\\(`));
    assert.ok(i >= 0, `${file}: ${fn} not found`);
    const body = src.slice(i, src.indexOf('\n}\n', i));
    const m = body.match(/const position = \{\s*(?:\/\/[^\n]*\n\s*)*id: ([^,\n]+),/);
    assert.ok(m, `${file} ${fn}: no "id:" as the position's first field`);
    assert.ok(/TRIP-WIRE \(2026-10-27\): this id's FORMAT is data/.test(body), `${file} ${fn}: the trip-wire comment is gone`);
    // eslint-disable-next-line no-eval
    const before = Date.now(); const id = eval(m[1]); const after = Date.now();
    const n = Number(id);
    assert.ok(Number.isFinite(n) && Number.isInteger(n), `${file} ${fn}: id ${JSON.stringify(id)} is not an integer: the audit can't date new trades (store the add time explicitly first)`);
    assert.ok(n > floor, `${file} ${fn}: id ${id} is below the audit's epoch floor ${floor}`);
    assert.ok(n >= before && n <= after, `${file} ${fn}: id ${id} is not the add's own Date.now()`);
    assert.strictEqual(typeof id, 'string', 'stored as text (portfolio.position_id and trades_v2.position_id are text)');
  }
});
