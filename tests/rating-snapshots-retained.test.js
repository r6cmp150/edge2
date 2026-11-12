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
const { readSource, run } = require('./_lib');

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
  vm.runInContext(app.match(/^const RATING_SNAPSHOT_MIN_SCORE = \d+;$/m)[0] + '\n' + grab('writeRatingSnapshots') + '\n;globalThis.__w = writeRatingSnapshots;', ctx);
  await ctx.__w([{ ticker: 'A', score: 80, signal: 'SOFT BUY' }, { ticker: 'B', score: 40 }]);
  assert.deepStrictEqual(calls, [['insert', 'rating_snapshots', 1]], 'one insert (score >= 60 only), no delete');
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
