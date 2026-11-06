// tests/deliberate-raise-label.test.js — 2026-11-06. A behaviour run ends by raising on purpose, so its probes roll
// back; Supabase's editor labels any raise "Failed to run sql query". Roman read a PASS as a failure three times
// (db/035, db/040, db/037). So every file that raises on purpose says so first, in plain words, and points at the
// RESULT line. Fix the pattern, not the person.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { run, REPO_ROOT } = require('./_lib');

const MARK = 'SUPABASE WILL SAY "Failed to run sql query" FOR A PASS';
const deliberate = s => /raised on purpose|raise[a-z]* on purpose|on purpose so/i.test(s);

(async () => {
await run('the detector finds a deliberate raise, and not an ordinary abort', () => {
  assert.ok(deliberate("raise exception 'RESULT: %. This message is raised on purpose so everything rolls back.'"));
  assert.ok(!deliberate("raise exception 'db/041 ABORTED, nothing changed'"));
  // the phrasings in use: db/038 run 2 capitalises it, and db/039 run 2 words it differently
  assert.ok(deliberate("raise exception 'db/038 run 2 RESULT: %  Raised on purpose so everything rolls back'"), 'capitalised');
  assert.ok(deliberate("-- every probe raises on purpose so its write is undone"), 'another verb form');
});

await run('every migration file that raises on purpose opens by saying Supabase will label its PASS a failure', () => {
  const dir = path.join(REPO_ROOT, 'db');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]).filter(([, t]) => deliberate(t));
  assert.ok(files.length >= 5, `files that raise on purpose: ${files.length}`);
  const missing = files.filter(([, t]) => !t.split(/\r?\n/).slice(0, 3).join(' ').includes(MARK)).map(([f]) => f);
  assert.deepStrictEqual(missing, [], 'say it in the first lines, before anything else');
});
})();
