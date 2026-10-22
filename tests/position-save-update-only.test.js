// tests/position-save-update-only.test.js — the sold-position resurrection
// race (phase-10 spec §7.5). savePositionToSupabase used to be an upsert, so
// a background save from a session still holding a position sold in another
// session re-created the row: nine positions recorded as two sales each.
// Now only the add forms insert; every other save is update-only, and an
// update that matches no row is classified, never silently "succeeded":
//   POSITION_MISSING    -- follow-up select confirms the row is gone
//   POSITION_UNWRITABLE -- the row exists; the update was refused
//   POSITION_UNKNOWN    -- the follow-up select failed
// Only MISSING may stop the session saving (and showing) the position; all
// failures must reach the market banner, not just the console.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const fnSrc = (file, name) => {
  const m = readSource(file).match(new RegExp(`(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`could not extract ${name}() from ${file}`);
  return m[0];
};

// Recording supabase-js stand-in. Every chain is logged as [table, ...ops];
// `respond(ops)` decides what the awaited chain resolves to.
function mockClient(respond) {
  const calls = [];
  return {
    calls,
    from(table) {
      const ops = [];
      calls.push({ table, ops });
      const b = {};
      for (const m of ['update', 'insert', 'upsert', 'delete', 'select', 'eq', 'limit']) {
        b[m] = (...args) => { ops.push([m, ...args]); return b; };
      }
      b.then = (res, rej) => Promise.resolve(respond(ops)).then(res, rej);
      return b;
    },
  };
}
const verbs = client => client.calls.map(c => c.ops.find(o => ['update', 'insert', 'upsert', 'delete', 'select'].includes(o[0]))[0]);

function loadStore(client) {
  global.supabaseClient = client;
  global.mapPositionToSupabaseRow = p => ({ position_id: p.id, ticker: p.ticker });
  global.currentCodeVersion = () => ({ app: 'test', scoring: 2, scoring_hash: 'h' }); // db/028 writer (tests/code-version.test.js covers it)
  // eslint-disable-next-line no-eval
  eval([fnSrc('core/store.js', 'insertPositionToSupabase'), fnSrc('core/store.js', 'savePositionToSupabase')].join('\n')
    + '\nglobal.__insert = insertPositionToSupabase; global.__save = savePositionToSupabase;');
}
(async () => {
const POS = { id: '1727815398000', ticker: 'SNXX' };
const isUpdate = ops => ops[0][0] === 'update';

await run('save against a missing position_id writes nothing and reports POSITION_MISSING', async () => {
  const client = mockClient(ops => isUpdate(ops) ? { data: [], error: null } : { data: [], error: null });
  loadStore(client);
  await assert.rejects(global.__save(POS), e => e.code === 'POSITION_MISSING' && e.positionId === POS.id && /not re-created/.test(e.message));
  assert.deepStrictEqual(verbs(client), ['update', 'select'], 'one update, one existence check -- no insert, no upsert');
  assert.deepStrictEqual(client.calls[0].ops.find(o => o[0] === 'eq'), ['eq', 'position_id', POS.id], 'update is scoped to this position_id');
});

await run('zero rows updated but the row exists -> POSITION_UNWRITABLE, never MISSING', async () => {
  const client = mockClient(ops => isUpdate(ops) ? { data: [], error: null } : { data: [{ position_id: POS.id }], error: null });
  loadStore(client);
  await assert.rejects(global.__save(POS), e => e.code === 'POSITION_UNWRITABLE');
  assert.deepStrictEqual(verbs(client), ['update', 'select']);
});

await run('zero rows updated and the existence check errors -> POSITION_UNKNOWN, never MISSING', async () => {
  const client = mockClient(ops => isUpdate(ops) ? { data: [], error: null } : { data: null, error: { message: 'network down' } });
  loadStore(client);
  await assert.rejects(global.__save(POS), e => e.code === 'POSITION_UNKNOWN' && /network down/.test(e.message));
});

await run('save against an existing row is exactly one update and no check', async () => {
  const client = mockClient(() => ({ data: [{ position_id: POS.id }], error: null }));
  loadStore(client);
  await global.__save(POS);
  assert.deepStrictEqual(verbs(client), ['update']);
});

await run('an update error is thrown as-is, without a zero-row code', async () => {
  const client = mockClient(() => ({ data: null, error: Object.assign(new Error('boom'), { code: '42501' }) }));
  loadStore(client);
  await assert.rejects(global.__save(POS), e => e.message === 'boom');
  assert.deepStrictEqual(verbs(client), ['update'], 'no existence check when the update itself failed');
});

await run('the add path inserts, with code_version on the inserted row', async () => {
  const client = mockClient(() => ({ data: null, error: null }));
  loadStore(client);
  const pos = { ...POS };
  await global.__insert(pos);
  assert.deepStrictEqual(verbs(client), ['insert']);
  const inserted = client.calls[0].ops.find(o => o[0] === 'insert')[1][0];
  assert.deepStrictEqual(inserted.code_version, { app: 'test', scoring: 2, scoring_hash: 'h' }, 'db/028: the insert carries the version');
  assert.deepStrictEqual(pos.codeVersion, inserted.code_version, 'the in-memory position keeps it, so the sale can copy it');
});

// backgroundSavePosition (app.js): only a confirmed MISSING touches
// deletedPositionIds; every failure reaches positionSaveFailures + banner.
async function background(code) {
  global.state = { deletedPositionIds: new Set(), positionSaveFailures: {} };
  let banners = 0;
  global.updateMarketBanner = () => { banners++; };
  let behaviour = code;
  global.savePositionToSupabase = async () => {
    if (behaviour === 'OK') return;
    throw Object.assign(new Error(`${behaviour} msg`), behaviour === 'PLAIN' ? {} : { code: behaviour });
  };
  // eslint-disable-next-line no-eval
  eval(fnSrc('app.js', 'backgroundSavePosition') + '\nglobal.__bg = backgroundSavePosition;');
  const tick = () => new Promise(r => setImmediate(r));
  // Quiet the helper's own console.error, and ALWAYS put it back: run()
  // reports FAIL through console.error, so a leaked stub hides every later
  // failure (exit code 1, no FAIL line -- found by the mutation check).
  const realError = console.error;
  console.error = () => {};
  try {
    global.__bg(POS); await tick();
    const after = { deleted: global.state.deletedPositionIds.has(POS.id), failure: global.state.positionSaveFailures[POS.id], banners };
    behaviour = 'OK';
    global.__bg(POS); await tick();
    after.afterSuccess = global.state.positionSaveFailures[POS.id];
    return after;
  } finally {
    console.error = realError;
  }
}

await run('background save: only POSITION_MISSING suppresses the position', async () => {
  const missing = await background('POSITION_MISSING');
  assert.strictEqual(missing.deleted, true);
  assert.strictEqual(missing.failure.code, 'POSITION_MISSING');
  assert.ok(missing.banners >= 1, 'banner told');
  assert.ok(missing.afterSuccess, 'a confirmed-missing notice stays until reload');
  for (const code of ['POSITION_UNWRITABLE', 'POSITION_UNKNOWN', 'PLAIN']) {
    const r = await background(code);
    assert.strictEqual(r.deleted, false, `${code} must never hide a real position`);
    assert.ok(r.failure && r.banners >= 1, `${code} reaches the banner, not just the console`);
    assert.strictEqual(r.afterSuccess, undefined, `${code} clears on the next successful save`);
  }
});

await run('banner says the position was closed elsewhere, and how to fix it', () => {
  const el = { style: {}, innerHTML: '' };
  global.document = { getElementById: () => el };
  global.getMarketStatus = () => ({ color: 'x', label: 'OPEN', countdown: '' });
  // eslint-disable-next-line no-eval
  eval(fnSrc('app.js', 'updateMarketBanner') + '\nglobal.__banner = updateMarketBanner;');
  global.state = { persistFailure: null, positionSaveFailures: { a: { ticker: 'SNXX', code: 'POSITION_MISSING', message: '' } } };
  global.__banner();
  assert.ok(/SNXX was closed in another session/.test(el.innerHTML) && /Refresh to update/.test(el.innerHTML), el.innerHTML);
  global.state.positionSaveFailures = { a: { ticker: 'SNXX', code: 'POSITION_UNWRITABLE', message: '' } };
  global.__banner();
  assert.ok(/Couldn't save SNXX/.test(el.innerHTML) && !/closed in another session/.test(el.innerHTML));
  // persistFailure outranks it -- and the position notice is queued, not
  // dropped: it shows again the moment the persist failure clears.
  global.state.positionSaveFailures = { a: { ticker: 'SNXX', code: 'POSITION_MISSING', message: '' } };
  global.state.persistFailure = { key: 'ownedPrevRSI', message: 'quota', at: 'x' };
  global.__banner();
  assert.ok(/Save failed — ownedPrevRSI/.test(el.innerHTML) && !/SNXX/.test(el.innerHTML), 'persistFailure wins the banner');
  assert.ok(global.state.positionSaveFailures.a, 'the position notice survives being outranked');
  global.state.persistFailure = null;
  global.__banner();
  assert.ok(/SNXX was closed in another session/.test(el.innerHTML), 'and returns once persistFailure clears');
  global.state.positionSaveFailures = {};
  global.__banner();
  assert.ok(/OPEN/.test(el.innerHTML), 'no failures -> normal market status');
});

// Static guard: the shape can't quietly come back.
await run('only the two add forms create portfolio rows; nothing upserts portfolio', () => {
  const files = ['app.js', 'core/store.js', 'engines/warrior/index.js'];
  for (const f of files) {
    const src = readSource(f);
    assert.ok(!/from\('portfolio'\)[\s\S]{0,120}?\.upsert\(/.test(src), `${f}: no upsert into portfolio`);
    assert.ok(!/function savePortfolioToSupabase/.test(src), `${f}: the bulk-upsert helper stays deleted`);
  }
  assert.strictEqual((readSource('core/store.js').match(/from\('portfolio'\)\.insert\(/g) || []).length, 1, 'one insert site: insertPositionToSupabase');
  const calls = f => (readSource(f).match(/await insertPositionToSupabase\(/g) || []).length;
  assert.strictEqual(calls('app.js'), 1, 'EDGE add form');
  assert.strictEqual(calls('engines/warrior/index.js'), 1, 'WARRIOR add form');
  assert.ok(!/savePositionToSupabase\(p\)\.catch/.test(readSource('app.js')), 'background saves go through backgroundSavePosition');
});
})();
