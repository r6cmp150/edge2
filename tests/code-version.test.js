// tests/code-version.test.js — db/028 code_version writers (phase-10 spec
// §7.6 step 1d and the §7.7 write-once trigger trip-wire). Static and offline.
// The live proof is scripts/test-db028-roundtrip.mjs, run against the real
// table and trigger; this file keeps the same rules guarded on every run.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const fn = (file, name) => {
  const m = readSource(file).match(new RegExp(`(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} found in ${file}`);
  return m[0];
};
const code = s => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

run('portfolio: code_version is written only by the insert, never by the shared mapper', () => {
  assert.ok(!/code_version/.test(code(fn('core/store.js', 'mapPositionToSupabaseRow'))),
    'mapPositionToSupabaseRow must not emit code_version: it also feeds the update-only save, and the write-once trigger rejects a changed (or nulled) version on every peak-price save');
  const ins = code(fn('core/store.js', 'insertPositionToSupabase'));
  assert.ok(/code_version: position\.codeVersion/.test(ins), 'the insert writes code_version');
  assert.ok(/codeVersion: row\.code_version \?\? null/.test(fn('core/store.js', 'mapSupabasePortfolioRowToPosition')),
    'the read mapper brings code_version back, so the sale can copy it');
  assert.ok(!/code_version/.test(code(fn('core/store.js', 'savePositionToSupabase'))), 'the update path never names code_version');
});

run('currentCodeVersion reads the loaded app.js stamp, never a constant', () => {
  const src = fn('core/store.js', 'currentCodeVersion');
  global.SCORING_VERSION = 2; global.SCORING_HASH = 'h';
  global.document = { querySelector: () => ({ getAttribute: () => 'app.js?v=20261022000000' }) };
  // eslint-disable-next-line no-eval
  eval(src + '\nglobal.__cv = currentCodeVersion;');
  assert.deepStrictEqual(global.__cv(), { app: '20261022000000', scoring: 2, scoring_hash: 'h' });
  global.document = { querySelector: () => null };
  assert.strictEqual(global.__cv().app, 'unavailable', 'a missing tag is an explicit value, never a guess and never a thrown error that blocks recording');
  assert.ok(!/\bVERSION\b(?!_)/.test(code(src).replace(/SCORING_VERSION/g, '')), 'not read from the hand-maintained VERSION constant');
});

run('trades_v2: the buy version is copied, the sale writes its own, and the label uses the buy thresholds', () => {
  const w = code(fn('app.js', 'writeTradeToSupabase'));
  assert.ok(/code_version: pos\.codeVersion \?\? null/.test(w), 'code_version copied from the position (NULL for pre-writer positions, never guessed)');
  assert.ok(/sale_code_version: currentCodeVersion\(\)/.test(w), 'sale_code_version is the running code');
  assert.ok(/scoreLabel\(pos\.scoreAtBuy, buyScoringVersion\)/.test(w), 'signal_label comes from the buy scoring version');
  assert.ok(!/>= ?116|>= ?73/.test(w), 'no literal thresholds left in the sale path');
});

run('loggers write code_version from scripts/lib/code-version.mjs and no longer write build_version', () => {
  for (const f of ['scripts/log-signals-edge.mjs', 'scripts/log-signals-warrior.mjs']) {
    const src = code(readSource(f));
    assert.ok(src.includes("import { codeVersionForRun } from './lib/code-version.mjs'"), `${f} imports codeVersionForRun (the never-throwing wrapper)`);
    assert.strictEqual((src.match(/code_version: CODE_VERSION/g) || []).length, 2, `${f} writes code_version on the scan_runs row and on every signal_log row`);
    assert.ok(!/build_version:/.test(src), `${f} no longer writes the stale build_version`);
    assert.ok(/resolution=ignore-duplicates/.test(src), `${f}: the signal_log upsert must stay ignore-duplicates; a merge would UPDATE and hit the write-once trigger after any mid-day deploy (§7.7 trip-wire)`);
  }
});

// Two ways a deploy could silently stop the loggers (a missing day of rows
// looks like a quiet day): readCodeVersion throws if it can't read this
// checkout, and log-signals-edge.mjs extracts the display-threshold block
// from app.js by an exact text anchor (zero or several matches throw).
run('the loggers can read this checkout: code version, and the threshold anchor in app.js', async () => {
  const { readCodeVersion } = await import('../scripts/lib/code-version.mjs');
  const { codeVersion: v, problems } = readCodeVersion(require('path').resolve(__dirname, '..'));
  assert.deepStrictEqual(problems, [], 'no degradation on the real checkout');
  assert.ok(typeof v.app === 'string' && /^\d{14}$/.test(v.app), `app stamp read from index.html: ${v.app}`);
  assert.ok(Number.isInteger(v.scoring) && /^[0-9a-f]{64}$/.test(v.scoring_hash), 'scoring version and computed hash');
  const logger = readSource('scripts/log-signals-edge.mjs');
  const anchor = logger.match(/loadFromAppJs\(appJsSrc,\s*'(const BASE_SCORE_THRESHOLD = [^']+)'/)[1];
  const hits = readSource('app.js').split(/\r?\n/).filter(l => l === anchor).length;
  assert.strictEqual(hits, 1, `app.js must contain the logger's anchor line exactly once: "${anchor}"`);
});

// The observer must not break the observed (2026-10-22): a version problem
// degrades the value, never the run. Three states: a real version, NULL
// (before db/028), and an explicit degraded value. Never a throw.
run('readCodeVersion never throws: unreadable parts give explicit, CHECK-valid values', async () => {
  const { readCodeVersion } = await import('../scripts/lib/code-version.mjs');
  const fs = require('fs'), os = require('os'), path = require('path');
  const shape = cv => typeof cv.app === 'string' && typeof cv.scoring === 'number' && typeof cv.scoring_hash === 'string'; // db/028's CHECK
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  fs.mkdirSync(path.join(dir, 'core'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<script src="app.js"></script>'); // no ?v=
  fs.writeFileSync(path.join(dir, 'core', 'edge-scoring.js'), 'function scoreStock() {}\n'); // no SCORING_VERSION
  const a = readCodeVersion(dir);
  assert.ok(shape(a.codeVersion), 'still passes the CHECK');
  assert.strictEqual(a.codeVersion.app, 'unavailable');
  assert.strictEqual(a.codeVersion.scoring, 0, '0 = unreadable; real versions start at 1');
  assert.strictEqual(a.problems.length, 2, 'both problems reported, for the ::error:: annotation');
  const b = readCodeVersion(path.join(dir, 'does-not-exist'));
  assert.ok(shape(b.codeVersion) && b.codeVersion.scoring_hash === 'unavailable' && b.problems.length === 2, 'a missing checkout degrades, never throws');
  fs.rmSync(dir, { recursive: true, force: true });
});

// state.ownedScores (phase-10 step 2): persisted across deploys, so a stored
// score is used only if the CURRENT formula produced it. Every reader goes
// through currentOwnedScore(); an unversioned or other-version entry is
// "not evaluated" with its reason, never a number from another formula.
run('ownedScores: versioned on write, read only through currentOwnedScore, stale entries not evaluated', () => {
  const app = readSource('app.js');
  const body = code(app);
  const directReads = (body.match(/state\.ownedScores\[[^\]]+\](?!\s*=)/g) || []);
  assert.strictEqual(directReads.length, 1, `only currentOwnedScore may read state.ownedScores directly, found: ${directReads.join(', ')}`);
  const writes = body.match(/state\.ownedScores\[ticker\] = \{[^}]*\}/g) || [];
  assert.ok(writes.length === 2 && writes.every(w => /scoringVersion: SCORING_VERSION/.test(w)), 'both writers record the scoring version');
  global.SCORING_VERSION = 2;
  global.state = { ownedScores: { A: { score: 70, label: 'SOFT BUY', scoringVersion: 2 }, B: { score: 80, label: 'SOFT BUY' }, C: { score: 90, label: 'SOFT BUY', scoringVersion: 1 } } };
  // eslint-disable-next-line no-eval
  eval(fn('app.js', 'currentOwnedScore') + '\nglobal.__cos = currentOwnedScore;');
  assert.strictEqual(global.__cos('A').score, 70, 'a current-version entry is used');
  for (const t of ['B', 'C']) {
    const r = global.__cos(t);
    assert.ok(r.score === null && /not|unrecorded|v1/.test(r.notEvaluatedReason), `${t}: a stale entry is not evaluated, with a reason (${r.notEvaluatedReason})`);
  }
  assert.strictEqual(global.__cos('Z'), null, 'no entry is no entry');
  assert.ok(/if \(currentSignal\?\.notEvaluatedReason\) add\(`Current score not evaluated/.test(app), 'the exit engine says it, rather than silently skipping the score factors');
});
