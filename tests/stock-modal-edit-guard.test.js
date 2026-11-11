// tests/stock-modal-edit-guard.test.js -- 2026-11-11. A condition that enforces itself.
//
// 4e71a4a added a capture to openStockModal (state.appShowedOnScreen) that reads five
// variables. If any were out of scope the modal would throw, show "Failed to load data"
// instead of the Add button, and Roman could not buy. Its only evidence was a ONE-OFF scope
// check on that exact tree. The owed fix is a standing test that renders the modal with
// fixture data and asserts the Add button is present and the capture runs, and it must land
// BEFORE THE NEXT EDIT TO openStockModal.
//
// So: this pins openStockModal's source as of 4e71a4a. Any edit to it fails here until
// tests/stock-modal-render.test.js exists. When that test lands, this one has done its job
// and passes whatever the function's hash.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readSource, run, REPO_ROOT } = require('./_lib');

const PINNED = 'e07fc0449864c822415efe34414749f558c7db91f58a4b3115a31d2b18329921'; // openStockModal @ 4e71a4a
const RENDER_TEST = path.join(REPO_ROOT, 'tests', 'stock-modal-render.test.js');

run('openStockModal is not edited before its standing render test exists', () => {
  if (fs.existsSync(RENDER_TEST)) return; // the owed test has landed: the condition is met
  const src = readSource('app.js');
  const i = src.search(/^async function openStockModal\(/m);
  assert.ok(i >= 0, 'openStockModal not found: if it was renamed or moved, the render test is owed first');
  const hash = crypto.createHash('sha256').update(src.slice(i, src.indexOf('\n}\n', i) + 3)).digest('hex');
  assert.strictEqual(hash, PINNED, 'openStockModal changed, and tests/stock-modal-render.test.js does not exist. Its capture is guarded only by a one-off scope check: land the render test (fixture data, the Add button present, the capture executed) BEFORE this edit.');
});
