// tests/delete-position-outcome.test.js -- 2026-11-08. deletePositionFromSupabase treated
// "no error" as "deleted". portfolio has RLS off, so a delete that matches no row is a
// silent success: a sold position could stay open (a ghost), and a stale session's second
// sale went ahead unnoticed. The delete now returns its rows, and zero rows is followed up.
// CHANGED 2026-11-18, declared (the reviewer: "a bounded wait returns a value that cannot be mistaken for success -- or
// for failure"): the delete is bounded and RETURNS AN OUTCOME, never throws. Every case below is the old one in the new
// shape (REMOVED / ALREADY_GONE are OK; "still there" and a database refusal are FAILED; a check that could not answer
// is UNKNOWN), and the new cases are what the change is for: a write that got no answer is UNKNOWN, never FAILED.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const store = readSource('core/store.js');
const grab = n => { const i = store.search(new RegExp(`^async function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return store.slice(i, store.indexOf('\n}\n', i) + 3); };
const constLine = n => { const i = store.indexOf(`const ${n}`); assert.ok(i >= 0, n); return store.slice(i, store.indexOf('\n', i) + 1); };
const HANG = Symbol('no answer');

// A fake client: the delete's answer and the follow-up select's answer, and a log of calls. An answer of HANG never
// comes unless the request's abort signal fires; then it resolves with an AbortError, as supabase-js does.
function load({ del, check }) {
  const calls = [];
  const settle = (answer, sig) => answer === HANG
    ? new Promise(res => sig.addEventListener('abort', () => res({ data: null, error: { message: 'AbortError: The operation was aborted.', code: '' } })))
    : answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  const chain = (kind, answer) => {
    const c = {};
    for (const m of ['eq', 'select', 'limit', 'delete']) c[m] = (...a) => { calls.push(`${kind}.${m}(${a.map(x => JSON.stringify(x)).join(',')})`); return c; };
    c.abortSignal = sig => { calls.push(`${kind}.abortSignal`); return settle(answer, sig); };
    return c;
  };
  global.supabaseClient = { from: t => { calls.push(`from(${t})`); return { delete: () => { calls.push('delete()'); return chain('delete', del); }, select: (...a) => { calls.push(`select(${JSON.stringify(a[0])})`); return chain('check', check); } }; } };
  // eslint-disable-next-line no-eval
  eval(`${grab('boundedRequest')}\n${constLine('WRITE_TIMEOUT_MS')}\n${grab('deletePositionFromSupabase')}\nglobal.__d = deletePositionFromSupabase;`);
  return { del: global.__d, calls };
}
const plain = o => JSON.parse(JSON.stringify(o));

run('the delete asks for its rows back, by position_id, with a bounded wait', async () => {
  const { del, calls } = load({ del: { data: [{ position_id: '1' }], error: null } });
  await del('1');
  assert.ok(calls.includes('delete.eq("position_id","1")') && calls.includes('delete.select("position_id")') && calls.includes('delete.abortSignal'), calls.join(' '));
});

run('a returned row: OK REMOVED, and no follow-up read', async () => {
  const { del, calls } = load({ del: { data: [{ position_id: '1' }], error: null } });
  assert.deepStrictEqual(plain(await del('1')), { outcome: 'OK', removed: 'REMOVED' });
  assert.ok(!calls.some(c => c.startsWith('check.')), 'no existence check when the delete returned the row');
});

run('no row deleted and none there: OK ALREADY_GONE (closed in another session), not REMOVED', async () => {
  const { del } = load({ del: { data: [], error: null }, check: { data: [], error: null } });
  assert.deepStrictEqual(plain(await del('1')), { outcome: 'OK', removed: 'ALREADY_GONE' });
});

run('no row deleted and the row is still there: FAILED, said (a ghost, known)', async () => {
  const { del } = load({ del: { data: [], error: null }, check: { data: [{ position_id: '1' }], error: null } });
  const r = await del('1');
  assert.strictEqual(r.outcome, 'FAILED');
  assert.ok(/still there/.test(r.reason) && /position 1/.test(r.reason), r.reason);
});

run('no row deleted and the check could not answer: UNKNOWN, never a guess', async () => {
  for (const check of [{ data: null, error: { message: 'boom', code: '' } }, { data: null, error: { message: 'denied', code: '42501' } }]) {
    const { del } = load({ del: { data: [], error: null }, check });
    const r = await del('1');
    assert.strictEqual(r.outcome, 'UNKNOWN', JSON.stringify(check));
    assert.ok(/whether it is still open is not known/.test(r.reason), r.reason);
  }
});

run('a null body is zero rows, not success', async () => {
  const { del } = load({ del: { data: null, error: null }, check: { data: [{ position_id: '1' }], error: null } });
  assert.strictEqual((await del('1')).outcome, 'FAILED');
});

run('the database refusing the delete (a server error, with its code): FAILED, with its message', async () => {
  const { del } = load({ del: { data: null, error: { code: '42501', message: 'denied' } } });
  const r = await del('1');
  assert.deepStrictEqual([r.outcome, /denied/.test(r.reason)], ['FAILED', true]);
});

// THE CASES THE CHANGE IS FOR (2026-11-18): a write that got no answer may have landed. It is UNKNOWN, never FAILED,
// whatever shape the non-answer takes. Raced against a real timer: a write that never settles would otherwise leave node
// nothing to do, and the file would exit with this case unrun.
const REAL_TIMER = global.setTimeout;
const settles = (p, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = REAL_TIMER(() => rej(new Error(`${what}: no outcome within 3 s -- it hung`)), 3000); })]).finally(() => clearTimeout(t)); };
run('a delete that gets no answer is UNKNOWN, never FAILED: aborted at the bound, a transport error, a thrown request', async () => {
  for (const [label, answer] of [['no answer (aborted at the bound)', HANG], ['a transport error (no server code)', { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }], ['the request threw', new Error('network down')]]) {
    const { del } = load({ del: answer });
    global.setTimeout = fn => { setImmediate(fn); return 0; }; // the bound elapses at once
    let r;
    try { r = await settles(del('1'), label); } finally { global.setTimeout = REAL_TIMER; }
    assert.strictEqual(r.outcome, 'UNKNOWN', `${label}: ${JSON.stringify(r)}`);
    assert.ok(/whether it was applied is not known/.test(r.reason) && !/fail/i.test(r.reason.replace('Failed to fetch', '')), `${label}: ${r.reason}`);
  }
});

run('an existence check that gets no answer makes the outcome UNKNOWN, not FAILED', async () => {
  const { del } = load({ del: { data: [], error: null }, check: HANG });
  global.setTimeout = fn => { setImmediate(fn); return 0; };
  let r;
  try { r = await settles(del('1'), 'the check'); } finally { global.setTimeout = REAL_TIMER; }
  assert.strictEqual(r.outcome, 'UNKNOWN');
  assert.ok(/no answer within 8 s/.test(r.reason), r.reason);
});

// What the sale path does with these outcomes (insert first; a non-OK delete becomes a line, never a stopped sale, and
// UNKNOWN is never worded as a failure) is tests/sale-write-order.test.js.
