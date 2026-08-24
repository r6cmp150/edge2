// tests/unhandled-rejection-modal.test.js — Bug B regression
// (docs/warrior-engine-spec-v2.md Phase 1): a Settings diagnostic handler
// with no try/catch around its `await diagnose*()` call left the modal
// stuck on its spinner forever when the request rejected. The rejected
// promise itself settles almost immediately — it's the awaiting async
// function that stops executing at that line, so the second showModal()
// call that would replace the spinner with real content (or an error)
// never runs. Confirmed live via a real Alpaca 403 before the fix.
//
// This file proves two things against the REAL current source (extracted
// from app.js, not reimplemented): 1) testUniverseEndpoints (now
// try/catch-wrapped) reaches showDiagnosticError, not a hang, when its
// diagnostic call rejects. 2) A reconstructed version WITHOUT the
// try/catch — the original bug's exact shape — actually hangs under the
// same test, proving this test has teeth: it would have caught Bug B, not
// just exercise code that happens to already be fixed.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const appSrc = readSource('app.js');

function extractFn(name, src) {
  const re = new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}

function extractShowDiagnosticError(src) {
  const re = /function showDiagnosticError\([^)]*\) \{[\s\S]*?\n\}/m;
  const m = src.match(re);
  if (!m) throw new Error('could not extract showDiagnosticError');
  return m[0];
}

function setUpDomMocks() {
  global.document = { getElementById: () => null };
  global.state = { settings: { alpacaKey: 'k', alpacaSecret: 's' } };
  global.persistApiKeys = () => {};
  global.buildAssetsHostRow = () => '';
  global.buildScreenerRow = () => '';
}

// Waits up to `timeoutMs` for `flag` (an object with a `.hit` property) to
// become true, polling frequently — used to prove "resolves quickly" vs
// "never resolves" without waiting the full timeout on the happy path.
function waitFor(flag, timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();
    const poll = () => {
      if (flag.hit || Date.now() - start > timeoutMs) return resolve(flag.hit);
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function testFixedHandlerReachesErrorPath() {
  setUpDomMocks();
  const modalCalls = [];
  global.showModal = (html) => { modalCalls.push(html); };
  global.diagnoseUniverseEndpoints = () => Promise.reject(new Error('Alpaca 403: subscription does not permit querying recent SIP data'));

  const src = extractShowDiagnosticError(appSrc) + '\n' + extractFn('testUniverseEndpoints', appSrc);
  const exposeCode = 'global.__testUniverseEndpoints = testUniverseEndpoints;';
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeCode);

  const flag = { hit: false };
  global.__testUniverseEndpoints().then(() => { flag.hit = true; });
  const reachedEnd = await waitFor(flag, 1000);

  console.log('Fixed handler (with try/catch) — reached end within 1s:', reachedEnd);
  console.log('showModal call count:', modalCalls.length, '(expect 2: spinner, then error)');
  console.log('Second call shows the error:', modalCalls[1]?.includes('Failed:'));

  assert.ok(reachedEnd, 'the fixed handler did not settle within 1s — regressed to hanging');
  assert.strictEqual(modalCalls.length, 2, 'expected exactly 2 showModal calls: spinner, then error');
  assert.ok(modalCalls[1].includes('Failed:'), 'expected the second showModal call to render the error via showDiagnosticError');
}

async function testUnprotectedVersionActuallyHangs() {
  // Reconstructs the ORIGINAL bug's exact shape — same handler, try/catch
  // removed — to prove this test suite can actually detect it, not just
  // exercise already-fixed code. If this test ever fails (i.e., the
  // "buggy" reconstruction stops hanging), the reconstruction no longer
  // matches the original bug and needs revisiting — it should NOT be
  // "fixed" by copying the real fix in here.
  setUpDomMocks();
  const modalCalls = [];
  global.showModal = (html) => { modalCalls.push(html); };
  global.diagnoseUniverseEndpoints = () => Promise.reject(new Error('Alpaca 403'));

  const buggySrc = `
async function buggyTestUniverseEndpoints() {
  showModal('<span class="spinner"></span> Testing…');
  const report = await diagnoseUniverseEndpoints(); // no try/catch — Bug B's exact shape
  showModal('report: ' + JSON.stringify(report));
}
`;
  const exposeCode = 'global.__buggy = buggyTestUniverseEndpoints;';
  // eslint-disable-next-line no-eval
  eval(buggySrc + '\n' + exposeCode);

  const flag = { hit: false };
  const p = global.__buggy();
  p.then(() => { flag.hit = true; }).catch(() => { /* rejection settles; the async fn's OWN forward progress is what's under test, not this handler */ });
  const reachedEnd = await waitFor(flag, 500);

  console.log('\nUnprotected reconstruction — reached its second showModal within 500ms:', reachedEnd);
  console.log('showModal call count:', modalCalls.length, '(expect 1 — only the spinner; the second call never runs)');

  assert.strictEqual(reachedEnd, false, 'the unprotected reconstruction unexpectedly completed — it no longer matches Bug B\'s shape, so it is not a valid negative control for the test above');
  assert.strictEqual(modalCalls.length, 1, 'expected only the spinner call — the post-await showModal must never run in the unprotected version');
}

(async () => {
  await run('unhandled-rejection-modal: fixed handler reaches the error path, not a hang', testFixedHandlerReachesErrorPath);
  await run('unhandled-rejection-modal: unprotected reconstruction actually hangs (negative control proving the test has teeth)', testUnprotectedVersionActuallyHangs);
})();
