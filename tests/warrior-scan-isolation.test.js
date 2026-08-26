// tests/warrior-scan-isolation.test.js — engines/warrior/index.js's scan
// interval error boundary. docs/warrior-engine-spec-v2.md Phase 2
// acceptance item: "Throw deliberately inside the Warrior scan interval ->
// only Warrior stops; EDGE polling continues."
//
// Extracts the REAL _startScanInterval/_stopScanInterval/_handleScanError/
// _tag from engines/warrior/index.js — not a reimplementation — and only
// substitutes two things: the interval period (60s -> a few ms, so the
// test doesn't take a minute) and the internal _scanTick() call (swapped
// for an injectable function, so the test controls what "the scan" does:
// throw synchronously, reject asynchronously, or succeed). The try/catch
// structure under test — the actual thing this acceptance item cares
// about — is the unmodified production code.
//
// "EDGE polling continues" is simulated with a genuinely separate
// setInterval in this test file, started independently and never touched
// by anything Warrior-side — proving isolation, not just asserting it.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const warriorSrc = readSource('engines/warrior/index.js');

function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, 'm');
  const m = warriorSrc.match(re);
  if (!m) throw new Error(`could not extract ${name} from engines/warrior/index.js`);
  return m[0];
}

function loadScanInterval(injectedScanTick) {
  const startFn = extractFn('_startScanInterval')
    .replace('_scanTick()', '__injectedScanTick()');
  const stopFn = extractFn('_stopScanInterval');
  const handleFn = extractFn('_handleScanError');
  const tagFn = extractFn('_tag');

  global.state = {};
  const toasts = [];
  global.showGlobalErrorToast = (msg) => toasts.push(msg);
  const errors = [];
  global.console = { ...console, error: (...args) => errors.push(args.join(' ')) };
  global.__injectedScanTick = injectedScanTick;

  const src = `
    const WARRIOR_SCAN_INTERVAL_MS = 15; // real 60s replaced for the test
    let _scanIntervalId = null;
    ${tagFn}
    ${handleFn}
    ${startFn}
    ${stopFn}
    global.__start = _startScanInterval;
    global.__stop = _stopScanInterval;
  `;
  // eslint-disable-next-line no-eval
  eval(src);
  return { start: global.__start, stop: global.__stop, toasts, errors };
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function testSyncThrowInScanTickIsContained() {
  let tickCount = 0;
  const { start, stop, toasts, errors } = loadScanInterval(() => {
    tickCount++;
    throw new Error('deliberate sync throw');
  });

  // A genuinely independent interval, standing in for EDGE's own polling —
  // never referenced by anything Warrior-side.
  let edgeTicks = 0;
  const edgeInterval = setInterval(() => { edgeTicks++; }, 15);

  start();
  await wait(80); // several Warrior ticks' worth
  stop();
  clearInterval(edgeInterval);

  console.log(`Warrior ticks (each threw): ${tickCount}, EDGE-analogue ticks: ${edgeTicks}`);
  console.log(`Warrior errors logged: ${errors.length}, toasts shown: ${toasts.length}`);

  assert.ok(tickCount >= 3, 'expected multiple Warrior ticks to have run despite each one throwing — the interval must not stop itself');
  assert.ok(edgeTicks >= 3, 'the independent (EDGE-analogue) interval must be unaffected by Warrior throwing');
  assert.strictEqual(errors.length, tickCount, 'every throw should have been caught and logged, not lost or left to crash the process');
  assert.ok(errors.every(e => e.includes('[Warrior]')), 'every logged error must carry the [Warrior] tag for attribution');
  assert.ok(toasts.every(t => t.includes('[Warrior]')), 'every toast must carry the [Warrior] tag');
}

async function testAsyncRejectionInScanTickIsContained() {
  let tickCount = 0;
  const { start, stop, errors } = loadScanInterval(async () => {
    tickCount++;
    throw new Error('deliberate async rejection');
  });

  start();
  await wait(80);
  stop();

  console.log(`Warrior ticks (each rejected): ${tickCount}, errors caught: ${errors.length}`);
  assert.ok(tickCount >= 3);
  assert.strictEqual(errors.length, tickCount, 'an async rejection from _scanTick must be caught the same as a sync throw — try/catch alone does not catch this, the .catch() on the returned promise does');
}

async function testStopActuallyStopsTicking() {
  let tickCount = 0;
  const { start, stop } = loadScanInterval(() => { tickCount++; });

  start();
  await wait(40);
  stop();
  const countAtStop = tickCount;
  await wait(60);

  console.log(`Ticks at stop: ${countAtStop}, ticks 60ms after stop: ${tickCount}`);
  assert.strictEqual(tickCount, countAtStop, '_stopScanInterval must actually clear the interval, not just be a no-op');
}

(async () => {
  await run('warrior-scan-isolation: sync throw in scan tick is contained, EDGE-analogue interval unaffected', testSyncThrowInScanTickIsContained);
  await run('warrior-scan-isolation: async rejection in scan tick is contained', testAsyncRejectionInScanTickIsContained);
  await run('warrior-scan-isolation: stop actually stops the interval', testStopActuallyStopsTicking);
})();
