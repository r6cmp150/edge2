// tests/frozen-inputs-out.test.js -- 2026-11-27, THE SECOND STANDING CHECK (the reviewer, CC-the-inputs-were-free-and-
// the-check-only-covers-one-direction §1). The first check (frozen-references-out.test.js) asks whether frozen code
// CALLS an OUT name. renderPortfolioTab was invisible to it: it called frozen code and WROTE the state frozen code reads
// (peakPrice, momentumProtectionActivated, ...), so calcUnifiedRecommendation was a fixed formula over a moving
// argument. This pins the other direction, from scripts/lib/frozen-inputs.mjs:
//   - THE WRITE CHANNEL: every key an OUT declaration writes that frozen code reads, listed in the spec
//     (out_writes_read_by_frozen) with its writers and a reason;
//   - THE CALL CHANNEL (beyond the ruling, named): every OUT declaration that calls a frozen function, listed
//     (out_calls_frozen) with its callees and a reason, since a value passed as an argument is an input too.
// Both directions each: a new one fails until frozen or listed; a listed one no longer found fails.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const W = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/frozen-inputs.mjs')).href);
const spec = JSON.parse(readSource('data/forward-test/instrument-freeze-spec.json'));
const app = readSource('app.js');
const files = Object.fromEntries(Object.keys(spec.files.frozen).filter(f => /\.m?js$/.test(f)).map(f => [f, readSource(f)]));
const writesFound = (src, sp) => {
  const m = new Map();
  for (const h of W.outWritesReadByFrozen(src, sp, files)) (m.get(h.key) || m.set(h.key, []).get(h.key)).push(h.writer);
  return m;
};
const outOf = sp => new Set(Object.values(sp.app_js.out).flatMap(g => g.names));

await run('THE WRITE CHANNEL: every key an OUT declaration writes that frozen code reads is listed, with its writers and reason; nothing else', () => {
  const found = writesFound(app, spec), listed = spec.out_writes_read_by_frozen.names;
  const unlisted = [];
  for (const [k, ws] of found) {
    const l = listed[k];
    for (const w of ws) if (!l || !l.writers.includes(w)) unlisted.push(`${w} -> ${k}`);
  }
  assert.deepStrictEqual(unlisted, [], 'an OUT declaration writes what frozen code reads, with no reason: freeze it, or list it with why it may stay out');
  const stale = [];
  for (const [k, l] of Object.entries(listed)) for (const w of l.writers) if (!(found.get(k) || []).includes(w)) stale.push(`${w} -> ${k}`);
  assert.deepStrictEqual(stale, [], 'listed, but no longer found: remove it');
  for (const [k, l] of Object.entries(listed)) assert.ok(typeof l.why === 'string' && l.why.length > 40, `${k} carries its reason`);
  assert.ok(Object.keys(listed).length >= 1 && found.size === Object.keys(listed).length);
});

await run('THE CALL CHANNEL: every OUT declaration that calls a frozen function is listed, with its callees and reason; nothing else', () => {
  const found = W.outCallsFrozen(app, spec), listed = spec.out_calls_frozen.names;
  const wrong = [...found].filter(([c, fs]) => !listed[c] || JSON.stringify(listed[c].calls) !== JSON.stringify(fs)).map(([c, fs]) => `${c}: ${fs.join(',')}`);
  assert.deepStrictEqual(wrong, [], 'an OUT declaration calls frozen code (passing it values) with no reason, or with a changed set of callees');
  assert.deepStrictEqual(Object.keys(listed).filter(c => !found.has(c)), [], 'listed, but it calls no frozen function now: remove it');
  for (const [c, l] of Object.entries(listed)) assert.ok(typeof l.why === 'string' && l.why.length > 40, `${c} carries its reason`);
});

await run('its first catch is frozen, not listed: the sale and buy-snapshot retry queues\' writers; and renderPortfolioTab stays in', () => {
  const out = outOf(spec);
  for (const n of ['noteSaleWrite', 'noteSnapshotFailure', 'clearSnapshotFailure', 'renderPortfolioTab']) {
    assert.ok(!out.has(n), `${n} is frozen`);
    assert.ok(!Object.values(spec.out_writes_read_by_frozen.names).some(l => l.writers.includes(n)) && !(n in spec.out_calls_frozen.names));
  }
  const a = spec.amended.find(x => /the second standing check/.test(x.ruling));
  assert.ok(a && a.date === '2026-11-27' && /^none: app\.js is byte-identical to b86d5c3/.test(a.content_changed));
});

await run('it fires on the case that found it: renderPortfolioTab back OUT is named for its writes AND its calls', () => {
  const sp = JSON.parse(JSON.stringify(spec)); sp.app_js.out.display.names.push('renderPortfolioTab');
  const found = writesFound(app, sp), by = k => (found.get(k) || []).includes('renderPortfolioTab');
  for (const k of ['.peakPrice', '.momentumProtectionActivated', '.rsiSuspendedAtGainPct', '.peakRsi', '.prevRSI', 'state.ownedPrevRSI', 'state.portfolioPrices'])
    assert.ok(by(k), `renderPortfolioTab -> ${k}`);
  const calls = W.outCallsFrozen(app, sp).get('renderPortfolioTab') || [];
  for (const f of ['calcUnifiedRecommendation', 'openMarkSoldModal', 'backgroundSavePosition']) assert.ok(calls.includes(f), `renderPortfolioTab calls ${f}`);
});

await run('it fires on a new write: an OUT screen setting a frozen reader\'s input is named', () => {
  // the Sold tab (OUT) starts writing the max-loss floor the frozen advice reads
  const mutated = app.replace("const engineFilter = state.soldEngineFilter || 'ALL';\n  const filteredSold", "const engineFilter = state.soldEngineFilter || 'ALL'; state.settings.maxLossPct = 5;\n  const filteredSold");
  assert.notStrictEqual(mutated, app);
  assert.ok((writesFound(mutated, spec).get('state.settings.maxLossPct') || []).includes('renderSoldTab'));
  assert.ok(!('state.settings.maxLossPct' in spec.out_writes_read_by_frozen.names), 'so the first test would fail on it');
});

await run('what counts as a write and as a read (the lib, on small cases)', () => {
  const top = new Set(['TICKERS', 'f']), w = t => [...W.writesOf(t, top, 'f')].sort();
  assert.deepStrictEqual(w('function f(p) { p.peakPrice = 1; }'), ['.peakPrice']);
  assert.deepStrictEqual(w('function f() { state.a[x] = 1; state.settings.b ||= 2; }'), ['state.a', 'state.settings.b']);
  assert.deepStrictEqual(w('function f(p) { if (p.x === 1 || p.y !== 2 || p.z <= 3) return q => q.w; }'), [], 'comparisons and arrows are not writes');
  assert.deepStrictEqual(w("function f() { persist('foo'); localStorage.setItem(KEY, 1); TICKERS = []; }"), ['state.foo', 'storage:KEY', 'var:TICKERS']);
  assert.deepStrictEqual(w('function f(p) { delete p.a; Object.assign(p.b, {}); state.list.push(1); p.n++; }'), ['.a', '.b', '.n', 'state.list']);
  assert.deepStrictEqual(w("function f(p) { const s = `Today's ${x}`; p.after = 1; }"), ['.after'], 'an apostrophe in a template literal does not hide the code after it');
  assert.strictEqual(W.reads('p.x = 1;', '.x'), false, 'a plain assignment in frozen code is its write, not a read');
  assert.strictEqual(W.reads('if (p.x == 1) go();', '.x'), true);
  assert.strictEqual(W.reads('p.x += 1;', '.x'), true, 'a compound assignment reads first');
});
})();
