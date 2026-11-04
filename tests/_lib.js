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
async function run(name, fn) {
  try {
    await fn();
    console.log(`\nPASS: ${name}`);
  } catch (e) {
    console.error(`\nFAIL: ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

module.exports = { virtualClock, readSource, evalModule, run, REPO_ROOT };
