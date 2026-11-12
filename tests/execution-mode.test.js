// tests/execution-mode.test.js — 2026-11-12. The app side of db/042 (+ db/043): every trade records whether it was
// placed at the broker. Ruled by the reviewer (2026-11-11):
//   - the Add button names the mode it will record; confirm RE-READS the toggle, and when the database doesn't confirm
//     exactly what the button said (the read failed, the toggle is unset, or it changed since the form opened) Roman
//     is asked, one tap; the tapped answer binds the trade as recorded_at_trade even if the setting can't be saved;
//   - a failed re-read never falls back to the cached mode, and never sets the toggle (the log would have to guess
//     what it changed from);
//   - settings first, then the change log; a log failure is shown, never silent;
//   - a sale copies its POSITION's mode, labelled copied_from_position; the toggle plays no part;
//   - the update path never rewrites a position's mode.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js'), store = readSource('core/store.js');
const fn = (src, name) => { const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src); assert.ok(m, name); return src.slice(m.index, src.indexOf('\n}\n', m.index) + 2); };
const constBlock = (src, name) => { const i = src.indexOf(`const ${name} = `); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('];\n', i) + 3); };

// eslint-disable-next-line no-eval
eval([fn(app, 'addButtonLabel'), fn(app, 'modeAtConfirm'), fn(app, 'saleModeColumns'), constBlock(app, 'MODE_CHOICES')].join('\n')
  + '\nglobal.__label = addButtonLabel; global.__at = modeAtConfirm; global.__sale = saleModeColumns; global.__choices = MODE_CHOICES;');

// A fake Supabase client: records every call; `respond(table, ops)` answers it.
function client(respond) {
  const calls = [];
  return {
    calls,
    from(table) {
      const ops = []; calls.push({ table, ops });
      const b = {};
      for (const m of ['update', 'insert', 'select', 'eq', 'limit', 'order', 'maybeSingle']) b[m] = (...a) => { ops.push([m, ...a]); return b; };
      b.then = (res, rej) => Promise.resolve(respond(table, ops)).then(res, rej);
      return b;
    },
  };
}
function loadStore(c, rowId = 3) {
  global.supabaseClient = c;
  // eslint-disable-next-line no-eval
  eval(`let settingsRowId = ${rowId};\n` + store.match(/^const SETTINGS_NOT_SAVED = [\s\S]*?;\n/m)[0]
    + [fn(store, 'readExecutionMode'), fn(store, 'writeExecutionMode')].join('\n')
    + '\nglobal.__read = readExecutionMode; global.__write = writeExecutionMode;');
}

(async () => {
await run('the Add button names the mode it records; unset names none (and the add will ask)', () => {
  assert.strictEqual(global.__label('live'), '+ Add as LIVE · placed at broker');
  assert.strictEqual(global.__label('paper'), '+ Add as PAPER · not at broker');
  for (const m of [null, undefined, '', 'not_known']) assert.strictEqual(global.__label(m), '+ Add', String(m));
  assert.deepStrictEqual(global.__choices.map(c => c.value), ['live', 'paper'], 'the prompt offers exactly the two modes');
});

await run('confirm: the database agreeing with the button records without asking; anything else asks', () => {
  assert.deepStrictEqual(global.__at('paper', { mode: 'paper' }), { mode: 'paper' });
  assert.deepStrictEqual(global.__at('live', { mode: 'live' }), { mode: 'live' });
  const unset = global.__at(null, { mode: null });
  assert.ok(unset.ask && unset.setToggle === true && unset.from === null && /not set yet/.test(unset.ask), 'unset: ask, and the answer sets it');
  const moved = global.__at('paper', { mode: 'live' });
  assert.ok(moved.ask && moved.setToggle === true && moved.from === 'live' && /This form said PAPER, but the setting is now LIVE/.test(moved.ask), 'changed elsewhere: ask, naming both');
  const late = global.__at(null, { mode: 'paper' });
  assert.ok(late.ask && /opened before Live\/Paper was set/.test(late.ask), 'a button that named no mode never records one silently');
  const failed = global.__at('paper', { failed: 'network down' });
  assert.ok(failed.ask && failed.setToggle === false && !('mode' in failed), 'a failed read asks; it never uses the cached mode the button showed');
  assert.ok(/could not be read \(network down\)/.test(failed.ask) && /The setting is not changed/.test(failed.ask));
});

await run('a sale copies its position\'s mode, labelled as copied; a position carrying none is not_known, never established', () => {
  for (const m of ['live', 'paper', 'not_known']) assert.deepStrictEqual(global.__sale({ executionMode: m }), { execution_mode: m, execution_mode_source: 'copied_from_position' }, m);
  for (const m of [undefined, null, 'LIVE']) assert.deepStrictEqual(global.__sale({ executionMode: m }), { execution_mode: 'not_known', execution_mode_source: null }, String(m));
});

await run('the add path: agrees -> recorded, no prompt; asks -> the tapped answer binds the trade, and only a confirmed read sets the toggle', async () => {
  const i = app.indexOf('let _addInFlight = false;'), j = app.indexOf('async function addWithMode(');
  const k = app.indexOf('\n}\n', j) + 2;
  const setup = ({ reread, writeResult = { settings: null, log: null } }) => {
    const seen = { finals: [], choices: [], writes: [], alerts: [] };
    global.document = { getElementById: id => ({ 'pf-shares': { value: '10' }, 'pf-price': { value: '5' }, 'pf-date': { value: '2026-11-12' } }[id] || null) };
    global.readOrderEntry = () => ({ orderType: 'market', filledAt: 'now' });
    global.showAlert = m => seen.alerts.push(m);
    global.showConfirm = () => { throw new Error('no listing confirm expected'); };
    global.fetchHeldListing = async () => ({ X: 'listed' });
    global.finalizeAddPortfolio = async (...a) => { seen.finals.push(a[6]); };
    global.readExecutionMode = async () => { if (reread instanceof Error) throw reread; return { mode: reread, setAt: 'READ-AT' }; };
    global.writeExecutionMode = async (to, from) => { seen.writes.push([to, from]); return { at: writeResult.settings ? null : 'WRITTEN-AT', ...writeResult }; };
    global.showChoice = (msg, opts, cb) => seen.choices.push({ msg, opts, cb });
    global.renderSettingsTab = () => {};
    global.state = { settings: { executionMode: 'paper' }, activeTab: 'portfolio' };
    // CHANGED 2026-11-12, declared: the banner and the mode re-read now redraw the LIVE band; stubbed here, held by tests/live-band.test.js.
    global.renderLiveBand = () => {};
    // eslint-disable-next-line no-eval
    eval(app.slice(i, k) + '\nglobal.__add = confirmAddPortfolio;');
    return seen;
  };
  const flush = () => new Promise(r => setTimeout(r, 0));

  let s = setup({ reread: 'paper' });
  await global.__add('X', { disabled: false }, 'paper');
  assert.deepStrictEqual(s.finals, ['paper']); assert.strictEqual(s.choices.length, 0); assert.deepStrictEqual(s.writes, []);

  s = setup({ reread: 'live' });
  await global.__add('X', { disabled: false }, 'paper');
  assert.deepStrictEqual([global.state.settings.executionMode, global.state.settings.executionModeSetAt], ['live', 'READ-AT'], 'the mode and its time come from the same read');
  assert.strictEqual(s.finals.length, 0, 'nothing recorded before the answer');
  assert.strictEqual(s.choices.length, 1);
  s.choices[0].cb('paper'); await flush();
  assert.deepStrictEqual(s.finals, ['paper'], 'the tapped answer, not the database\'s LIVE');
  assert.deepStrictEqual(s.writes, [['paper', 'live']], 'and it sets the toggle, from what was read');

  s = setup({ reread: new Error('offline') });
  await global.__add('X', { disabled: false }, 'paper');
  assert.strictEqual(s.choices.length, 1, 'a failed read asks; it does not record the cached PAPER');
  s.choices[0].cb('live'); await flush();
  assert.deepStrictEqual(s.finals, ['live']);
  assert.deepStrictEqual(s.writes, [], 'and changes no setting');

  s = setup({ reread: null, writeResult: { settings: 'Setting NOT saved', log: 'not attempted' } });
  await global.__add('X', { disabled: false }, '');
  s.choices[0].cb('live'); await flush();
  assert.deepStrictEqual(s.finals, ['live'], 'a failed settings write never blocks the trade');
  assert.ok(s.alerts.some(a => /recorded as LIVE\. The Live\/Paper setting was NOT changed/.test(a)), 'and the failure is shown');

  s = setup({ reread: null, writeResult: { settings: null, log: 'permission denied' } });
  await global.__add('X', { disabled: false }, '');
  s.choices[0].cb('paper'); await flush();
  assert.strictEqual(global.state.settings.executionMode, 'paper');
  assert.strictEqual(global.state.settings.executionModeSetAt, 'WRITTEN-AT', 'Settings shows the instant written, never the load\'s');
  assert.ok(s.alerts.some(a => /was not logged: permission denied/.test(a)), 'a log failure is shown, never silent');
});

await run('the store: the toggle read is fresh and never turns "unreadable" into "never set"', async () => {
  loadStore(client(() => ({ data: [{ execution_mode: 'live', execution_mode_set_at: '2026-11-12T00:00:00Z' }], error: null })));
  assert.deepStrictEqual(await global.__read(), { mode: 'live', setAt: '2026-11-12T00:00:00Z' }, 'the mode with its own time, from one read');
  loadStore(client(() => ({ data: [{ execution_mode: null, execution_mode_set_at: null }], error: null })));
  assert.deepStrictEqual(await global.__read(), { mode: null, setAt: null }, 'null is never set');
  loadStore(client(() => ({ data: [], error: null })));
  await assert.rejects(global.__read(), /could not be read/, 'an empty read throws: unknown, not unset');
  loadStore(client(() => ({ data: null, error: { message: 'denied' } })));
  await assert.rejects(global.__read());
  const c = client(() => ({ data: [{ execution_mode: 'paper' }], error: null }));
  loadStore(c, null);
  await assert.rejects(global.__read(), /no settings row confirmed/);
  assert.deepStrictEqual(c.calls, [], 'no row confirmed: nothing read');
});

await run('the store: settings first, then the log; a failed setting writes no log row', async () => {
  let c = client((table, ops) => (table === 'settings' ? { data: [{ id: 3 }], error: null } : { error: null }));
  loadStore(c);
  const ok = await global.__write('live', 'paper');
  assert.deepStrictEqual(c.calls.map(x => x.table), ['settings', 'execution_mode_changes'], 'settings, then the log');
  const upd = c.calls[0].ops.find(o => o[0] === 'update')[1];
  assert.deepStrictEqual(ok, { settings: null, log: null, at: upd.execution_mode_set_at }, 'it returns the instant it wrote');
  assert.strictEqual(upd.execution_mode, 'live'); assert.ok(upd.execution_mode_set_at);
  assert.deepStrictEqual(c.calls[0].ops.find(o => o[0] === 'eq'), ['eq', 'id', 3], 'exactly the loaded row');
  const log = c.calls[1].ops.find(o => o[0] === 'insert')[1][0];
  assert.deepStrictEqual([log.from_mode, log.to_mode], ['paper', 'live']);
  assert.strictEqual(log.changed_at, upd.execution_mode_set_at, 'one instant for the change and its log row');

  c = client(table => (table === 'settings' ? { data: [{ id: 3 }], error: null } : { error: null }));
  loadStore(c);
  await global.__write('paper', null);
  assert.strictEqual(c.calls[1].ops.find(o => o[0] === 'insert')[1][0].from_mode, null, 'the first time it is set');

  c = client(table => (table === 'settings' ? { data: [], error: null } : { error: null }));
  loadStore(c);
  const r = await global.__write('live', 'paper');
  assert.ok(r.settings && /NOT saved/.test(r.settings));
  assert.deepStrictEqual(c.calls.map(x => x.table), ['settings'], 'no log row for a change that did not happen');

  c = client(table => (table === 'settings' ? { data: [{ id: 3 }], error: null } : { error: { message: 'denied' } }));
  loadStore(c);
  const logFailed = await global.__write('live', null);
  assert.ok(logFailed.settings === null && logFailed.log === 'denied' && logFailed.at, 'the setting saved, its log not');

  c = client(() => ({ data: [{ id: 3 }], error: null }));
  loadStore(c);
  for (const [to, from] of [['not_known', null], ['live', 'nope'], [undefined, null]]) {
    assert.ok((await global.__write(to, from)).settings, `${to}/${from} refused`);
  }
  assert.deepStrictEqual(c.calls, [], 'refused before anything is written');
});

await run('Settings: a change whose current value cannot be read changes nothing', async () => {
  const seen = { writes: [], alerts: [] };
  global.readExecutionMode = async () => { throw new Error('offline'); };
  global.writeExecutionMode = async (...a) => { seen.writes.push(a); return { settings: null, log: null }; };
  global.showAlert = m => seen.alerts.push(m);
  global.renderSettingsTab = () => {};
  global.state = { settings: { executionMode: 'paper' } };
  // eslint-disable-next-line no-eval
  eval(fn(app, 'changeExecutionMode') + '\nglobal.__change = changeExecutionMode;');
  await global.__change('live', null);
  assert.deepStrictEqual(seen.writes, []);
  assert.ok(/NOT changed: the current setting could not be read \(offline\)/.test(seen.alerts[0]));
  assert.strictEqual(global.state.settings.executionMode, 'paper');
  global.readExecutionMode = async () => ({ mode: 'live', setAt: 'READ-AT' });
  global.writeExecutionMode = async (...a) => { seen.writes.push(a); return { settings: null, log: null, at: 'WRITTEN-AT' }; };
  await global.__change('paper', null);
  assert.deepStrictEqual(seen.writes, [['paper', 'live']], 'the log records what it really changed from');
  assert.deepStrictEqual([global.state.settings.executionMode, global.state.settings.executionModeSetAt], ['paper', 'WRITTEN-AT'], 'the time shown is the instant written');
  await global.__change('paper', null); // already PAPER in the database: nothing written, the read's own time shown
  global.readExecutionMode = async () => ({ mode: 'paper', setAt: 'READ-AT-2' });
  await global.__change('paper', null);
  assert.strictEqual(global.state.settings.executionModeSetAt, 'READ-AT-2');
});

await run('a position\'s mode is written once, at the insert: read back for the sale, never sent by the update path', () => {
  const toRow = fn(store, 'mapPositionToSupabaseRow'), fromRow = fn(store, 'mapSupabasePortfolioRowToPosition');
  assert.ok(!/execution_mode/.test(toRow), 'mapPositionToSupabaseRow (the update path) never names the mode');
  assert.ok(fromRow.includes('executionMode: row.execution_mode ?? null') && fromRow.includes('executionModeSource: row.execution_mode_source ?? null'));
  assert.ok(fn(store, 'insertPositionToSupabase').includes('...recordedModeColumns(position.executionMode)'));
  assert.ok(fn(app, 'writeTradeToSupabase').includes('...saleModeColumns(pos),'), 'the sale row carries the copied mode');
  const fin = fn(app, 'finalizeAddPortfolio');
  assert.ok(fin.includes('executionMode,\n') && fin.includes("executionModeSource: 'recorded_at_trade',"));
});
})();
