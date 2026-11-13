// tests/_lib.js — shared plumbing for the plain-node test scripts in this
// directory. No framework: each test file is runnable standalone via
// `node tests/<name>.js`, uses Node's built-in assert module, and exits
// non-zero on failure. This file only removes literal duplication of the
// "read a core/*.js file and eval it with mocked globals" pattern every
// test needs — it has no discovery, no runner, no assertion DSL of its own.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Reads a file relative to the repo root (e.g. 'core/market-data.js').
function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// Evals `src` with the given globals present, then exposes the listed
// top-level const/let bindings onto `global` so the calling test can
// reference them afterward. Necessary because direct eval() in Node scopes
// let/const to the eval call itself — only function declarations leak out
// in sloppy mode — so bindings that need to survive past this call must be
// named explicitly. `mocks` are assigned onto `global` before the eval so
// the source can reference them as ambient globals (matching how these
// files actually run in the browser, as classic scripts sharing one global
// scope).
function evalModule(src, { mocks = {}, expose = [] } = {}) {
  for (const [name, value] of Object.entries(mocks)) {
    global[name] = value;
  }
  const exposeStatements = expose.map(name => `global.${name} = ${name};`).join(' ');
  // eslint-disable-next-line no-eval
  eval(src + '\n' + exposeStatements);
}

// A clock the test owns (2026-11-03), for anything whose assertion is about
// time. Shadow the globals at the top of the test file and any source eval'd
// there picks them up too:
//   const clock = virtualClock(); const { Date, setTimeout } = clock;
// Time moves only when clock.runUntil(promise) moves it, to the next timer, so
// machine load cannot change a measured rate. A timer-based wait that nothing
// will ever fire is a thrown deadlock, not a hang.
function virtualClock(start = 1800000000000) {
  const RealDate = global.Date;
  let now = start, seq = 0;
  const timers = [];
  class VirtualDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(now); }
    static now() { return now; }
  }
  const setVirtualTimeout = (fn, ms = 0) => { timers.push({ at: now + ms, seq: seq++, fn }); return seq; };
  const drainMicrotasks = () => new Promise(r => setImmediate(r));
  async function runUntil(promise) {
    let settled = false;
    const mark = () => { settled = true; };
    promise.then(mark, mark);
    for (;;) {
      await drainMicrotasks();
      if (settled) return promise;
      if (!timers.length) throw new Error('virtualClock: deadlock, nothing pending and the promise never settled');
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = timers.shift();
      now = t.at;
      t.fn();
    }
  }
  return { Date: VirtualDate, setTimeout: setVirtualTimeout, runUntil, now: () => now };
}

// Minimal pass/fail runner: runs an async fn, prints PASS/FAIL, sets
// process.exitCode so `node tests/x.js` is a valid CI-style check without
// needing a framework to interpret its output.
//
// The apparatus must not lose what it was built to report (2026-11-04, phase-10
// §7.7). A test that muted console hid another test's PASS line, and earlier a stub
// that swapped console.error hid FAIL output. So:
//   - tests in a file run one at a time, whether or not the caller awaits;
//   - any test that leaves console, Date, fetch, timers or process.env changed
//     FAILS, naming what it left, and it is put back for the next test;
//   - results print through streams kept at load, which no test can swap;
//   - the file's total goes to the runner, which fails a file whose lines don't add up.
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
const realInspect = require('util').inspect;
const WATCHED = [
  ['console.log', () => console.log, v => { console.log = v; }],
  ['console.warn', () => console.warn, v => { console.warn = v; }],
  ['console.error', () => console.error, v => { console.error = v; }],
  ['console.info', () => console.info, v => { console.info = v; }],
  ['fetch', () => global.fetch, v => { global.fetch = v; }],
  ['Date', () => global.Date, v => { global.Date = v; }],
  ['Date.now', () => global.Date.now, v => { global.Date.now = v; }],
  ['setTimeout', () => global.setTimeout, v => { global.setTimeout = v; }],
  ['setInterval', () => global.setInterval, v => { global.setInterval = v; }],
];
function snapshotGlobals() {
  return { values: WATCHED.map(([, get]) => get()), env: { ...process.env } };
}
// What a test left changed, each restored. Date is restored before Date.now, which reads it.
function restoreLeaks(before) {
  const leaked = [];
  WATCHED.forEach(([name, get, set], i) => {
    if (get() !== before.values[i]) { leaked.push(name); set(before.values[i]); }
  });
  for (const k of new Set([...Object.keys(process.env), ...Object.keys(before.env)])) {
    if (process.env[k] !== before.env[k]) {
      leaked.push(`process.env.${k}`);
      if (before.env[k] === undefined) delete process.env[k]; else process.env[k] = before.env[k];
    }
  }
  return leaked;
}
// For a test that stubs a global it doesn't otherwise clean up: says so, and puts it back.
const restoring = fn => async () => {
  const before = snapshotGlobals();
  try { return await fn(); } finally { restoreLeaks(before); }
};
let tail = Promise.resolve();
let ran = 0;
async function runOne(name, fn) {
  ran++;
  const before = snapshotGlobals();
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  const leaked = restoreLeaks(before);
  if (!error && leaked.length) error = new Error(`this test left global state changed: ${leaked.join(', ')}. Restore it, or it can hide another test's result.`);
  if (error) {
    realErr(`\nFAIL: ${name}\n${realInspect(error)}\n`);
    process.exitCode = 1;
  } else {
    realOut(`\nPASS: ${name}\n`);
  }
}
function run(name, fn) {
  tail = tail.then(() => runOne(name, fn));
  return tail;
}
process.on('exit', () => { if (ran) realOut(`\nTESTS RUN: ${ran}\n`); });

// app.js's SETTING_LABELS table, as source: updateMarketBanner calls
// settingsBannerLine (2026-11-02), which reads it, so a test that evals the
// banner in isolation needs both.
function settingLabelsSrc() {
  const s = readSource('app.js');
  const i = s.indexOf('const SETTING_LABELS = {');
  if (i < 0) throw new Error('app.js: SETTING_LABELS not found');
  return s.slice(i, s.indexOf('};', i) + 2);
}

// core/store.js's column validators, as source (carve of (c), 2026-11-12): MACRO_PATHS and RATING_TIERS with
// checkedMacroPath, macroPathColumn and checkedRatingTier. Every writer of a macro path or a rating tier calls them,
// so a test that evals a writer in isolation loads the real ones, never a stub that could accept what they refuse.
function columnValidatorsSrc() {
  const s = readSource('core/store.js');
  const i = s.indexOf('const MACRO_PATHS = [');
  const j = s.indexOf('function checkedRatingTier(');
  if (i < 0 || j < 0) throw new Error('core/store.js: the column validators not found');
  return s.slice(i, s.indexOf('\n}\n', j) + 3);
}

// app.js's failed-save detail (2026-11-13): updateMarketBanner calls persistFailureDetail, which reads NEVER_CLEAR, so a
// test that evals the banner in isolation loads both, for real.
function persistFailureDetailSrc() {
  const s = readSource('app.js');
  const i = s.indexOf('const NEVER_CLEAR = ');
  const j = s.indexOf('function persistFailureDetail(');
  if (i < 0 || j < 0) throw new Error('app.js: persistFailureDetail not found');
  return s.slice(i, s.indexOf('\n}\n', j) + 3); // NEVER_CLEAR, MEASURED_STATE_NAMES and the function, contiguous
}

module.exports = {
  virtualClock, readSource, evalModule, run, restoring, REPO_ROOT, settingLabelsSrc, columnValidatorsSrc, persistFailureDetailSrc };
