// tests/write-walker-branches.test.js — 2026-11-12. The walker's BRANCH INVARIANT (tests/_write-walker.js fnReturn):
// a builder's return branches read must equal the `return`s its body contains, counted independently, or it fails.
// The third walker hole (a builder read only to its first `return {`) was found by the enumerated-value guard asking for
// declarations that weren't there; the independent count of sites could not have found it, because a missed branch is
// inside a site the count already matched. This holds the class, not the instance (ruled by the reviewer, 2026-11-12).
'use strict';
const assert = require('assert');
const { run } = require('./_lib');
const W = require('./_write-walker');

const build = (src, name) => W.fnReturn(name, { sources: new Map([['x.js', src]]), aliases: {}, file: 'x.js' }, 0);

(async () => {
await run('every return branch is read: the columns of the last branch count as much as the first', () => {
  const cols = build("function b(m) {\n  if (m === 1) return { a: 1 };\n  if (m === 2) return { a: 2, late: 3 };\n  return { a: 3, last: 4 };\n}\n", 'b');
  assert.deepStrictEqual([...cols].sort(), ['a', 'last', 'late']);
  assert.deepStrictEqual(W.BRANCHES.get('b'), { read: 3, contains: 3 });
});

await run('a return that is not an object literal fails, naming both numbers', () => {
  assert.throws(() => build("function b(m) {\n  if (m) return { a: 1 };\n  return null;\n}\n", 'b'), /read 1 of the 2 return branch/);
  assert.throws(() => build("function b(m) {\n  if (m) return { a: 1 };\n  return m ? { a: 2 } : { a: 3 };\n}\n", 'b'), /read 1 of the 2/);
});

await run('a builder holding a nested function is NOT ENUMERABLE: its returns cannot be told apart', () => {
  assert.throws(() => build("function b(xs) {\n  const f = x => { return { y: x }; };\n  return { a: f(xs) };\n}\n", 'b'), /nested function/);
  assert.throws(() => build("function b() {\n  function g() { return 1; }\n  return { a: g() };\n}\n", 'b'), /nested function/);
});

await run('the independent count reads code, not text: return inside a string or template is not a branch', () => {
  assert.deepStrictEqual(W.returnTokens("{ if (x) return { m: 'return now' }; return { m: `no return ${'here'}` }; }"), { returns: 2, nested: false });
  assert.deepStrictEqual(W.returnTokens('{ const returned = 1; return { returned }; }'), { returns: 1, nested: false }, 'a word that starts with return is not one');
  assert.strictEqual(W.returnTokens("{ return { s: '=> function' }; }").nested, false, 'an arrow inside a string is not a function');
});

await run('the real builders: every one the write sites reach is read in full, and printed', () => {
  W.BRANCHES.clear();
  const sites = W.enumerate();
  assert.ok(sites.every(s => s.state !== 'NOT ENUMERABLE' || !/return branch|nested function/.test(s.why || '')), 'no real builder breaks the invariant');
  const seen = [...W.BRANCHES].map(([n, b]) => `${n} ${b.read}/${b.contains}`);
  console.log(`  builders resolved: ${seen.join(', ')}`);
  for (const n of ['mapPositionToSupabaseRow', 'recordedModeColumns', 'saleModeColumns']) assert.ok(W.BRANCHES.has(n), `${n} resolved`);
  assert.deepStrictEqual(W.BRANCHES.get('saleModeColumns'), { read: 4, contains: 4 }, 'all four of the sale\'s branches');
  for (const [n, b] of W.BRANCHES) assert.strictEqual(b.read, b.contains, n);
});
})();
