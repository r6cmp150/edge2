// tests/read-only-runme-sql.test.js -- 2026-11-27 (the reviewer, CC-no-ci-install-step-and-the-index-fix-is-worth-
// more-than-stated §1). The read-only SQL Roman runs against PRODUCTION (RUN-ME-22 and RUN-ME-23, both again at the
// 2027-01-11 recheck) was proven to write nothing by a PGlite run inside a READ ONLY transaction. That proof is evidence
// about one exact file, not a CI step (db/harness is not installed in CI, by decision: STATUS, "db/harness is evidence,
// not CI"). So the file is pinned, and when it changes the pin's failure says what to do before it ships.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { run, readSource } = require('./_lib');

const sha = f => crypto.createHash('sha256').update(readSource(f).replace(/\r\n/g, '\n')).digest('hex');
const PINS = [
  { file: 'db/inspect-dead-space-read-only.sql', runMe: 'RUN-ME-23', sha: 'e500e2f07dc2dbe624f4fef6b67acc60c8b5dd6ee12d7b31dc23e14b06f371b8',
    redo: 'in db/harness (npm install there first), node run-dead-space.mjs ../inspect-dead-space-read-only.sql; it must print HARNESS PASS' },
  { file: 'db/inspect-sizes-read-only.sql', runMe: 'RUN-ME-22', sha: 'b188fd27ccb3bf5eaac180efe0899befe8a867f4216c85a66d7a0832faa965d2',
    redo: 'in db/harness (npm install there first), node run-sizes.mjs ../inspect-sizes-read-only.sql; it must print HARNESS PASS' },
];

(async () => {
for (const p of PINS) {
  await run(`${p.file} (${p.runMe}, run on production) is the file its read-only proof was made on`, () => {
    const harness = p.redo.match(/node (\S+\.mjs)/)[1];
    // the file's own query, not only the control write, runs inside the READ ONLY transaction
    assert.ok(/await db\.exec\('begin transaction read only'\);\s*const res = await db\.query\(sqlFile\b/.test(readSource(`db/harness/${harness}`)),
      `the proof the message names, db/harness/${harness}, exists and runs the file READ ONLY`);
    assert.strictEqual(sha(p.file), p.sha,
      `${p.file} changed, so its proof that it writes nothing no longer applies. Before a RUN-ME is generated from it: ` +
      `${p.redo}; record the output in the commit message and STATUS; then move this pin to the new sha256.`);
  });
}
})();
