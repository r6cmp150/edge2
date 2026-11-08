// tests/delete-position-outcome.test.js -- 2026-11-08. deletePositionFromSupabase treated
// "no error" as "deleted". portfolio has RLS off, so a delete that matches no row is a
// silent success: a sold position could stay open (a ghost), and a stale session's second
// sale went ahead unnoticed. The delete now returns its rows, and zero rows is followed up.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const store = readSource('core/store.js');
const grab = n => { const i = store.search(new RegExp(`^async function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return store.slice(i, store.indexOf('\n}\n', i) + 3); };

// A fake client: the delete's answer and the follow-up select's answer, and a log of calls.
function load({ del, check }) {
  const calls = [];
  const chain = (kind, answer) => {
    const c = {};
    for (const m of ['eq', 'select', 'limit', 'delete']) c[m] = (...a) => { calls.push(`${kind}.${m}(${a.map(x => JSON.stringify(x)).join(',')})`); return m === (kind === 'delete' ? 'select' : 'limit') ? Promise.resolve(answer) : c; };
    return c;
  };
  global.supabaseClient = { from: t => { calls.push(`from(${t})`); return { delete: () => { calls.push('delete()'); return chain('delete', del); }, select: (...a) => { calls.push(`select(${JSON.stringify(a[0])})`); return chain('check', check); } }; } };
  // eslint-disable-next-line no-eval
  eval(`${grab('deletePositionFromSupabase')}\nglobal.__d = deletePositionFromSupabase;`);
  return { del: global.__d, calls };
}
const rejects = async (p, code) => { try { await p; } catch (e) { assert.strictEqual(e.code, code, e.message); return e; } assert.fail(`expected ${code}, got a resolve`); };

run('the delete asks for its rows back, by position_id', async () => {
  const { del, calls } = load({ del: { data: [{ position_id: '1' }], error: null } });
  await del('1');
  assert.ok(calls.includes('delete.eq("position_id","1")') && calls.includes('delete.select("position_id")'), calls.join(' '));
});

run('a returned row: REMOVED, and no follow-up read', async () => {
  const { del, calls } = load({ del: { data: [{ position_id: '1' }], error: null } });
  assert.strictEqual(await del('1'), 'REMOVED');
  assert.ok(!calls.some(c => c.startsWith('check.')), 'no existence check when the delete returned the row');
});

run('no row deleted and none there: ALREADY_GONE (closed in another session), not REMOVED', async () => {
  const { del } = load({ del: { data: [], error: null }, check: { data: [], error: null } });
  assert.strictEqual(await del('1'), 'ALREADY_GONE');
});

run('no row deleted and the row is still there: throws POSITION_NOT_REMOVED (a ghost, said)', async () => {
  const { del } = load({ del: { data: [], error: null }, check: { data: [{ position_id: '1' }], error: null } });
  const e = await rejects(del('1'), 'POSITION_NOT_REMOVED');
  assert.ok(/still there/.test(e.message) && e.positionId === '1');
});

run('no row deleted and the check failed: throws POSITION_UNKNOWN, never a guess', async () => {
  const { del } = load({ del: { data: [], error: null }, check: { data: null, error: { message: 'boom' } } });
  const e = await rejects(del('1'), 'POSITION_UNKNOWN');
  assert.ok(/boom/.test(e.message));
});

run('a null body is zero rows, not success', async () => {
  const { del } = load({ del: { data: null, error: null }, check: { data: [{ position_id: '1' }], error: null } });
  await rejects(del('1'), 'POSITION_NOT_REMOVED');
});

run('a delete error is thrown as it came', async () => {
  const { del } = load({ del: { data: null, error: { code: '42501', message: 'denied' } } });
  await rejects(del('1'), '42501');
});

// What the sale path does with these outcomes (insert first; a throw becomes a "still
// shows as open" line, never a stopped sale) is tests/sale-write-order.test.js.
