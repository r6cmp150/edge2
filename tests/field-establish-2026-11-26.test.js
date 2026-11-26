// tests/field-establish-2026-11-26.test.js -- the six "not established" rows of docs/field-provenance.md, read and
// established (the reviewer, 2026-11-26: "reading is not changing"). Pinned to the backup @ 28610fb, PRE-START-LINE rows
// only (no forward-test position is read). Each figure the doc states is recomputed here, so a changed doc or a wrong
// figure fails.
'use strict';
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const SD = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/measure-selection-differential.mjs')).href);
const REV = '28610fb';
const show = f => (j => (Array.isArray(j) ? j : j.rows))(JSON.parse(execFileSync('git', ['show', `${REV}:${f}`], { cwd: REPO_ROOT, maxBuffer: 1e9 }).toString()));
// the reads were taken against the FIRST start line (2026-11-23T20:42:43.124Z); the restart of 2026-11-26 moved the
// line, not these measurements, so they keep the line they were taken on
const FIRST_START_LINE = '2026-11-23T20:42:43.124Z';
const T = show('data/backups/trades_v2.json').filter(r => SD.addedAt(r) <= Date.parse(FIRST_START_LINE));
const doc = readSource('docs/field-provenance.md');
const cnt = (xs, f) => xs.filter(f).length;
const ptClock = ms => new Date(ms).toLocaleString('en-CA', { timeZone: 'America/Los_Angeles', hour12: false });
// the session of a PT wall-clock date and time, as the add classifies it
const session = (date, time) => {
  const [h, m] = String(time).split(':').map(Number), mm = h * 60 + m, wd = new Date(`${String(date).slice(0, 10)}T12:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) return 'CLOSED';
  return mm >= 390 && mm < 780 ? 'REGULAR' : mm >= 780 && mm < 1020 ? 'AFTER_HOURS' : mm >= 60 && mm < 390 ? 'PRE_MARKET' : 'CLOSED';
};

await run('the reads are of pre-start rows only: 908 of the backup\'s rows, the 10 added after the start line excluded', () => {
  assert.strictEqual(T.length, 908);
  assert.strictEqual(show('data/backups/trades_v2.json').length - T.length, 10);
});

await run('buy_time: the add\'s clock (616 of 616); never outside the session; paper rows 155, unknown-mode 753', () => {
  const stamped = T.filter(r => Number(r.position_id) > 1.7e12);
  assert.strictEqual(stamped.length, 616);
  assert.strictEqual(cnt(stamped, r => String(r.buy_time).slice(0, 5) === ptClock(Number(r.position_id)).slice(12, 17)), 616);
  assert.strictEqual(cnt(stamped, r => session(r.buy_date, r.buy_time) !== 'REGULAR'), 0, 'none recorded outside 06:30-13:00 PT or on a weekend');
  assert.strictEqual(cnt(T, r => r.execution_mode === 'paper'), 155);
  assert.strictEqual(cnt(T, r => r.execution_mode === 'not_known'), 753);
  assert.ok(doc.includes('| `buy_time` on a PAPER trade | provenanced |') && doc.includes('| `buy_time` on a live trade or one of unknown mode | not established |'));
});

await run('buy_session: recomputed from buy_date and buy_time, it agrees on 908 of 908', () => {
  assert.strictEqual(cnt(T, r => r.buy_session === session(r.buy_date, r.buy_time)), 908);
  assert.strictEqual(cnt(T, r => r.buy_session === 'AFTER_HOURS'), 33);
  assert.ok(doc.includes('| `buy_session` | provenanced |'));
});

await run('rsi_at_buy: 908 of 908 strictly between 0 and 100; the one exact 50 earned its points', () => {
  assert.strictEqual(cnt(T, r => r.rsi_at_buy != null && Number(r.rsi_at_buy) > 0 && Number(r.rsi_at_buy) < 100), 908);
  const fifty = T.filter(r => Number(r.rsi_at_buy) === 50);
  assert.deepStrictEqual(fifty.map(r => [r.ticker, String(r.buy_date).slice(0, 10), Number(r.rsi_pts)]), [['LUNL', '2026-11-10', 15]]);
  assert.ok(doc.includes('| `rsi_at_buy` | provenanced |'));
});

await run('code_version: 616 stamps, every app stamp in index.html\'s history, every hash the known v2 hash; 292 absent before 10-27', () => {
  const cv = T.filter(r => r.code_version);
  assert.strictEqual(cv.length, 616);
  const history = new Set((execFileSync('git', ['log', '-p', '--format=', '--', 'index.html'], { cwd: REPO_ROOT, maxBuffer: 1e9 }).toString().match(/app\.js\?v=(\d{14})/g) || []).map(s => s.slice(9)));
  const apps = [...new Set(cv.map(r => r.code_version.app))];
  assert.strictEqual(apps.length, 16); assert.deepStrictEqual(apps.filter(a => !history.has(a)), []);
  assert.strictEqual(cnt(cv, r => r.code_version.scoring_hash === '8e10b278942271cdfb1944320de39b969a4585748edf9130c294545a9e7515e2' && r.code_version.scoring === 2), 616);
  assert.strictEqual(cnt(T, r => !r.code_version), 292);
  assert.strictEqual(cnt(T, r => !r.code_version && String(r.buy_date) >= '2026-10-27'), 0);
  assert.ok(doc.includes('| `code_version` | provenanced |'));
});

await run('threshold_at_buy: every value a line of its version (29/73 v1, 20/65 v2); no score below its threshold', () => {
  const vals = {}; for (const r of T) vals[String(r.threshold_at_buy)] = (vals[String(r.threshold_at_buy)] || 0) + 1;
  assert.deepStrictEqual(vals, { 20: 567, 29: 194, 65: 49, 73: 61, null: 37 });
  const lines = readSource('core/edge-scoring.js');
  assert.ok(/1:\s*\{\s*watch:\s*29,\s*soft:\s*73/.test(lines) && /2:\s*\{\s*watch:\s*20,\s*soft:\s*65/.test(lines), 'the version table holds those lines');
  assert.strictEqual(cnt(T, r => r.threshold_at_buy != null && r.signal_score != null && Number(r.signal_score) < Number(r.threshold_at_buy)), 0);
  assert.ok(doc.includes('| `threshold_at_buy` | provenanced |'));
});

await run('taken_resolution: "taken" is any same-ticker buy within 9 calendar days; 10 of 92 matches on the signal\'s date', () => {
  const S = ['2026-09', '2026-10', '2026-11'].flatMap(m => show(`data/backups/signal_log/${m}.json`));
  const all = show('data/backups/trades_v2.json'), byId = new Map(all.map(t => [String(t.id), t]));
  const m = S.filter(r => r.matched_trade_id != null);
  assert.strictEqual(m.length, 92);
  assert.strictEqual(cnt(m, r => byId.has(String(r.matched_trade_id))), 92);
  assert.strictEqual(cnt(m, r => { const t = byId.get(String(r.matched_trade_id)); return t.ticker === r.symbol && String(t.buy_date).slice(0, 10) === String(r.signal_date).slice(0, 10); }), 10);
  assert.strictEqual(cnt(all, t => t.signal_log_id != null), 0);
  assert.ok(readSource('scripts/fill-outcomes.mjs').includes('const TAKEN_WINDOW_CALENDAR_DAYS = 9;'));
  assert.ok(doc.includes('| `taken_resolution`, `matched_trade_id` | can be fabricated |'));
});

await run('the doc\'s count line matches its rows', () => {
  const rows = doc.split('\n').filter(l => /^\| `/.test(l) || /^\| the `/.test(l)), st = s => rows.filter(r => r.split('|')[2].trim() === s).length;
  assert.deepStrictEqual([rows.length, st('can be fabricated'), st('provenanced'), st('not established')], [45, 19, 25, 1]);
  assert.ok(doc.includes('Counted (2026-11-26): 45 rows, 19 can be fabricated, 25\nprovenanced, 1 not established'));
});
})();
