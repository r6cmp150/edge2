// tests/rating-snapshots-retained.test.js — 2026-11-02. rating_snapshots is
// the only record of what the browser scans showed in the morning entry
// window (the GitHub-scheduled logger can't cover it), and the app deleted
// rows older than 90 days on every scan, plus a one-tap purge after the
// Settings archive download. Both purges are gone: the table is append-only,
// and the daily backup now treats any shrink as a defect (the anon key has
// a DELETE path on it).
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run, columnValidatorsSrc } = require('./_lib');

const app = readSource('app.js');
const code = app.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const grab = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };

run('a scan writes its snapshots and deletes nothing', async () => {
  const calls = [];
  const table = name => ({
    insert: async rows => { calls.push(['insert', name, rows.length]); return { error: null }; },
    delete: () => { calls.push(['delete', name]); const q = { lt: async () => ({ error: null }) }; return q; },
  });
  // CHANGED 2026-11-12, declared: the scan price history adds hooks these functions now call; stubbed here, held by tests/scan-history.test.js.
  const ctx = { console, Date, JSON, Math, supabaseClient: { from: table }, scanHistoryChanged: () => {} };
  vm.createContext(ctx);
  // CHANGED 2026-11-12, declared (carve of (c)): the writers call core/store.js's column validators; loaded here for real (tests/_lib.js columnValidatorsSrc), never stubbed.
  vm.runInContext(columnValidatorsSrc() + '\n' + app.match(/^const RATING_SNAPSHOT_MIN_SCORE = \d+;$/m)[0] + '\n' + grab('writeRatingSnapshots') + '\n;globalThis.__w = writeRatingSnapshots;', ctx);
  await ctx.__w([
    { ticker: 'A', signal: { ticker: 'A', score: 80, signal: 'SOFT BUY' }, shown: true, tier: 'SHOWN' },
    { ticker: 'B', signal: { ticker: 'B', score: 12, signal: 'WATCH' }, shown: false, tier: 'BELOW_THRESHOLD' },
    { ticker: 'C', signal: null, shown: false, tier: 'NOT_EVALUATED' },
  ]);
  assert.deepStrictEqual(calls, [['insert', 'rating_snapshots', 2]], 'one insert (every scored row), no delete');
});

run('every scored row is written with its tier; the scan passes all its results, not the shown list', async () => {
  const inserted = [];
  // CHANGED 2026-11-12, declared (carve of (c) onto main): the same scanHistoryChanged stub as the case above, which main
  // added for the scan price history after (c) wrote this case.
  const ctx = { console, Date, JSON, Math, supabaseClient: { from: () => ({ insert: async rows => { inserted.push(...rows); return { error: null }; } }) }, scanHistoryChanged: () => {} };
  vm.createContext(ctx);
  // CHANGED 2026-11-12, declared (carve of (c)): the writers call core/store.js's column validators; loaded here for real (tests/_lib.js columnValidatorsSrc), never stubbed.
  vm.runInContext(columnValidatorsSrc() + '\n' + app.match(/^const RATING_SNAPSHOT_MIN_SCORE = \d+;$/m)[0] + '\n' + grab('writeRatingSnapshots') + '\n;globalThis.__w = writeRatingSnapshots;', ctx);
  await ctx.__w([
    { ticker: 'A', signal: { ticker: 'A', score: 80, signal: 'SOFT BUY', price: 5, scoringVersion: 2, scoringHash: 'h' }, shown: true, tier: 'SHOWN' },
    { ticker: 'B', signal: { ticker: 'B', score: 12, signal: 'WATCH', price: 5 }, shown: false, tier: 'BELOW_THRESHOLD' },
    { ticker: 'C', signal: null, shown: false, tier: 'NOT_EVALUATED' },
  ]);
  assert.deepStrictEqual(inserted.map(r => [r.ticker, r.score, r.tier]), [['A', 80, 'SHOWN'], ['B', 12, 'BELOW_THRESHOLD']]);
  assert.deepStrictEqual([inserted[0].scoring_version, inserted[0].scoring_hash], [2, 'h'], 'which formula scored it');
  assert.deepStrictEqual([inserted[1].scoring_version, inserted[1].scoring_hash], [null, null], 'not recorded is null, never a guess');
  assert.ok(/writeRatingSnapshots\(state\.lastFullScanResults\)/.test(code), 'the scan hands over every result');
  assert.ok(!/writeRatingSnapshots\(state\.signals\)/.test(code), 'not the shown list');
});

// 2026-11-13 (the reviewer: a batch of independent rows does not fail as a batch). (c)'s validators throw on an
// off-list macro path or tier; one such row used to throw out of the build and drop the whole batch, not even kept
// for Retry. Now it is set aside and named, and every other row is written.
run('one off-list row is set aside and named; every other row of the scan is written, and nothing is dropped as a batch', async () => {
  const inserted = [];
  let banners = 0;
  const ctx = { console: { error() {}, log() {} }, Date, JSON, Math, String, supabaseClient: { from: () => ({ insert: async rows => { inserted.push(...rows); return { error: null }; } }) },
    scanHistoryChanged: () => {}, updateMarketBanner: () => { banners++; }, state: {} };
  vm.createContext(ctx);
  vm.runInContext(columnValidatorsSrc() + '\n' + app.match(/^const RATING_SNAPSHOT_MIN_SCORE = \d+;$/m)[0] + '\n' + grab('writeRatingSnapshots') + '\n;globalThis.__w = writeRatingSnapshots;', ctx);
  await ctx.__w([
    { ticker: 'A', signal: { ticker: 'A', score: 80, signal: 'SOFT BUY', price: 5, macroPath: 'pattern' }, tier: 'SHOWN' },
    { ticker: 'BAD', signal: { ticker: 'BAD', score: 70, signal: 'BUY', price: 5, macroPath: 'pattern' }, tier: 'NOT_A_TIER' },
    { ticker: 'C', signal: { ticker: 'C', score: 20, signal: 'WATCH', price: 5, macroPath: 'sideways' }, tier: 'BELOW_THRESHOLD' },
    { ticker: 'D', signal: { ticker: 'D', score: 15, signal: 'WATCH', price: 5, macroPath: 'not_fetched' }, tier: 'BELOW_THRESHOLD' },
  ]);
  assert.deepStrictEqual(inserted.map(r => r.ticker), ['A', 'D'], 'the valid rows are written, in one insert');
  const set = JSON.parse(JSON.stringify(ctx.state.ratingRowsSetAside || [])); // out of the VM's realm, for deepStrictEqual
  assert.deepStrictEqual(set.map(r => [r.ticker, r.tier, r.macroPath]), [['BAD', 'NOT_A_TIER', 'pattern'], ['C', 'BELOW_THRESHOLD', 'sideways']], 'each off-list row named with its rejected value');
  assert.ok(set.every(r => /not a (rating tier|macro path)/.test(r.reason)), 'with the validator\'s reason');
  assert.strictEqual(ctx.state.ratingWriteFailuresDropped, undefined, 'no batch was dropped');
  assert.ok(banners >= 1, 'the banner is told');
  // every row off-list: nothing is inserted, nothing throws, all are named
  inserted.length = 0; ctx.state.ratingRowsSetAside = [];
  await ctx.__w([{ ticker: 'X', signal: { ticker: 'X', score: 70, signal: 'BUY', price: 5, macroPath: 'zzz' }, tier: 'SHOWN' }]);
  assert.deepStrictEqual(inserted, []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state.ratingRowsSetAside.map(r => r.ticker))), ['X']);
  const banner = readSource('app.js');
  assert.ok(/scan snapshot row\$\{setAsideRows\.length === 1 \? '' : 's'\} not written: \$\{named\}/.test(banner), 'the banner names the set-aside rows');
});

run('the score history stays on the 60+ floor; the two eras are marked in the schema and the spec', () => {
  assert.ok(/from\('rating_snapshots'\)\.select\('id, ticker, captured_at, score', \{ count: 'exact' \}\)\.gte\('score', RATING_SNAPSHOT_MIN_SCORE\)/.test(code), 'history filters to the floor');
  const sql = readSource('db/038_macro_observe_only_and_settings.sql');
  assert.ok(/add column tier text check \(tier is null or tier in \('SHOWN', 'BELOW_THRESHOLD'\)\)/.test(sql), 'tier column, NULL stated (revision b: a CHECK must be definite)');
  assert.ok(/pg_get_constraintdef\(oid\) ~ '\(score\|label\)'/.test(sql), 'aborts on a CHECK that could refuse low rows');
  assert.ok(/add column scoring_version integer/.test(sql) && /add column scoring_hash text/.test(sql), 'the formula, version and hash both');
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('TWO ERAS OF rating_snapshots: NEVER POOL THEM WITHOUT SAYING SO'), 'era marked in the spec');
  assert.ok(spec.includes('tier IS NULL'), 'and how to tell them apart');
});

run('the panel does not claim a row limit the free plan does not have', () => {
  assert.ok(!code.includes('DB_ROW_LIMIT'), 'no invented row limit');
  assert.ok(!code.includes('Consider archiving'), 'no advice to archive an append-only table');
  assert.ok(code.includes("The free plan's limit is on database size"), 'says what the limit is on');
});

run('no delete call site on rating_snapshots anywhere in the app; the archive download offers no purge', () => {
  assert.ok(!/from\('rating_snapshots'\)\s*\.delete\(/.test(code), 'no .delete() on rating_snapshots');
  assert.ok(!/from\('rating_snapshots'\)[\s\S]{0,40}\.delete\(/.test(code), 'not even split across lines');
  assert.ok(!app.includes('function deleteOldRatingSnapshots('), 'the manual purge is gone');
  assert.ok(!/older than 90 days/.test(code.replace(/\/\/.*$/gm, '')), 'no 90-day purge offer or copy left in executable code');
});

run('the daily backup refuses ANY shrink of rating_snapshots (was: only > 20%)', async () => {
  // CHANGED 2026-11-02, declared: the rules moved to scripts/lib/backup-rules.mjs
  // (importable without running a backup); the rule is imported, not extracted.
  const { pathToFileURL } = require('url');
  const path = require('path');
  const { TABLE_RULES } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'lib', 'backup-rules.mjs')).href);
  const rule = TABLE_RULES.rating_snapshots;
  assert.strictEqual(rule(3184, 3184).ok, true, 'unchanged');
  assert.strictEqual(rule(3200, 3184).ok, true, 'grew');
  assert.strictEqual(rule(3183, 3184).ok, false, 'one row lost is a defect');
  assert.strictEqual(rule(0, 3184).ok, false, 'a wipe');
  assert.strictEqual(rule(5, 0).ok, true, 'first backup');
});
