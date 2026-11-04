// tests/write-failures-surfaced.test.js — 2026-11-02, auth plan step 1. Two
// writes failed quietly: a buy's signal_snapshot_at_buy row (counted only in
// a Settings line -- how 72 snapshots were lost) and a scan's rating_snapshots
// batch (console only). Both now reach the market banner with a Retry, and
// the failed row is kept (persisted) so Retry can land it.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run, settingLabelsSrc } = require('./_lib');

const app = readSource('app.js');
const grab = name => { const i = app.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
const line = prefix => { const i = app.indexOf(prefix); assert.ok(i >= 0, prefix); return app.slice(i, app.indexOf('\n', i) + 1); };

function ctx({ insertSnapshot, ratingInsert, ratingLanded = [], ratingVisible = [{ captured_at: '2026-08-13T00:00:00Z' }], ratingVisibleError = null } = {}) {
  const banner = { innerHTML: '', style: {} };
  const persisted = [];
  const calls = { ratingInserts: 0, snapshotInserts: 0 };
  const store = {};
  const c = {
    console: { error() {}, log() {}, warn() {} }, Date, JSON, Math, Object, Array, String, Promise,
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    document: { getElementById: id => id === 'market-banner' ? banner : null },
    getMarketStatus: () => ({ color: 'x', label: 'MARKET OPEN', countdown: '' }),
    persist: k => persisted.push(k),
    insertSignalSnapshotAtBuy: async row => { calls.snapshotInserts++; return insertSnapshot(row); },
    supabaseClient: {
      from: () => ({
        insert: async rows => { calls.ratingInserts++; return ratingInsert(rows); },
        select: () => ({
          eq: async () => ({ data: ratingLanded, error: null }),
          limit: async () => ({ data: ratingVisibleError ? null : ratingVisible, error: ratingVisibleError }),
        }),
      }),
    },
    state: { saleWriteFailures: {}, positionSaveFailures: {}, snapshotWriteFailures: {}, ratingWriteFailures: [], persistFailure: null },
  };
  vm.createContext(c);
  vm.runInContext([line('const SNAPSHOT_LOG_KEY = '), line('const RATING_FAILURES_KEPT = '), line('const RATING_SNAPSHOT_MIN_SCORE = '),
    ...['noteSnapshotWrite', 'recordSignalSnapshotAtBuy', 'noteSnapshotFailure', 'clearSnapshotFailure', 'retrySnapshotWrite',
      'writeRatingSnapshots', 'noteRatingFailure', 'retryRatingWrites', 'settingsBannerLine', 'updateMarketBanner'].map(grab), settingLabelsSrc()].join('\n')
    + '\n;Object.assign(globalThis, { recordSignalSnapshotAtBuy, retrySnapshotWrite, writeRatingSnapshots, retryRatingWrites, updateMarketBanner });', c);
  return { c, banner, persisted, calls };
}
const pos = { id: 'p1', ticker: 'ABC', codeVersion: null };

run('a failed buy snapshot reaches the banner with Retry, and the row is kept (persisted)', async () => {
  const { c, banner, persisted } = ctx({ insertSnapshot: async () => { throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' }); } });
  const ok = await c.recordSignalSnapshotAtBuy(pos, { ticker: 'ABC', score: 80 });
  assert.strictEqual(ok, false, 'the add is never failed by it');
  const f = c.state.snapshotWriteFailures.p1;
  assert.ok(f && f.row && f.row.position_id === 'p1' && f.row.snapshot.score === 80, 'the row is kept for Retry');
  assert.ok(persisted.includes('snapshotWriteFailures'), 'persisted');
  assert.ok(banner.innerHTML.includes('ABC buy snapshot NOT saved') && banner.innerHTML.includes("retrySnapshotWrite('p1')"), banner.innerHTML);
});

run('snapshot Retry: lands -> cleared; already landed (23505) -> cleared; still failing -> kept', async () => {
  let mode = 'fail';
  const { c, banner } = ctx({ insertSnapshot: async () => {
    if (mode === 'fail') throw Object.assign(new Error('boom'), { code: '500' });
    if (mode === 'dup') throw Object.assign(new Error('duplicate key'), { code: '23505' });
  } });
  await c.recordSignalSnapshotAtBuy(pos, { score: 1 });
  await c.retrySnapshotWrite('p1');
  assert.ok(c.state.snapshotWriteFailures.p1, 'still failing: kept');
  mode = 'dup';
  await c.retrySnapshotWrite('p1');
  assert.ok(!c.state.snapshotWriteFailures.p1, 'a duplicate means the first write landed: cleared');
  assert.ok(!banner.innerHTML.includes('NOT saved'), 'banner back to market status');
  mode = 'fail'; await c.recordSignalSnapshotAtBuy({ id: 'p2', ticker: 'XYZ' }, null);
  mode = 'ok'; await c.retrySnapshotWrite('p2');
  assert.ok(!c.state.snapshotWriteFailures.p2, 'lands: cleared');
});

run('a failed rating_snapshots batch reaches the banner; Retry checks it did not land before inserting again', async () => {
  let fail = true;
  const h = ctx({ ratingInsert: async () => (fail ? { error: { code: '42501', message: 'denied' } } : { error: null }) });
  await h.c.writeRatingSnapshots([{ ticker: 'A', score: 80, signal: 'SOFT BUY' }, { ticker: 'B', score: 70 }, { ticker: 'C', score: 40 }]);
  assert.strictEqual(h.c.state.ratingWriteFailures.length, 1);
  assert.strictEqual(h.c.state.ratingWriteFailures[0].rows.length, 2, 'the 60+ rows kept');
  assert.ok(h.banner.innerHTML.includes('1 scan snapshot batch NOT saved (2 rows)'), h.banner.innerHTML);
  fail = false;
  const before = h.calls.ratingInserts;
  await h.c.retryRatingWrites();
  assert.strictEqual(h.calls.ratingInserts, before + 1, 'not landed: inserted once');
  assert.strictEqual(h.c.state.ratingWriteFailures.length, 0, 'cleared');

  const landed = ctx({ ratingInsert: async () => ({ error: { message: 'x' } }), ratingLanded: [{ ticker: 'A' }, { ticker: 'B' }] });
  await landed.c.writeRatingSnapshots([{ ticker: 'A', score: 80 }, { ticker: 'B', score: 70 }]);
  const n = landed.calls.ratingInserts;
  await landed.c.retryRatingWrites();
  assert.strictEqual(landed.calls.ratingInserts, n, 'it had landed: NOT inserted again');
  assert.strictEqual(landed.c.state.ratingWriteFailures.length, 0);

  // Rows at the same instant but for OTHER tickers are not this batch: it
  // must still be inserted, never counted as landed (that would drop it).
  const others = ctx({ ratingInsert: async () => (others.c.state.ratingWriteFailures.length ? { error: null } : { error: { message: 'x' } }), ratingLanded: [{ ticker: 'Z1' }, { ticker: 'Z2' }] });
  await others.c.writeRatingSnapshots([{ ticker: 'A', score: 80 }, { ticker: 'B', score: 70 }]);
  const k = others.calls.ratingInserts;
  await others.c.retryRatingWrites();
  assert.strictEqual(others.calls.ratingInserts, k + 1, 'other tickers at that instant: still inserted');
  assert.strictEqual(others.c.state.ratingWriteFailures.length, 0);

  const partial = ctx({ ratingInsert: async () => ({ error: { message: 'x' } }), ratingLanded: [{ ticker: 'A' }] });
  await partial.c.writeRatingSnapshots([{ ticker: 'A', score: 80 }, { ticker: 'B', score: 70 }]);
  const m = partial.calls.ratingInserts;
  await partial.c.retryRatingWrites();
  assert.strictEqual(partial.calls.ratingInserts, m, 'partly landed: not retried (would duplicate)');
  assert.ok(/partly landed/.test(partial.c.state.ratingWriteFailures[0].message), 'kept, and says why');
});

run('Retry\'s fourth state, CANNOT TELL: a read that sees nothing (denied looks empty) or fails retries nothing and keeps every batch', async () => {
  // Empty landed-check AND an empty control: the 3-state logic alone would
  // call this "not landed" and insert again.
  for (const [label, opts] of [['control empty', { ratingVisible: [] }], ['control errors', { ratingVisibleError: { code: '42501', message: 'denied' } }]]) {
    const h = ctx({ ratingInsert: async () => ({ error: { message: 'x' } }), ...opts });
    await h.c.writeRatingSnapshots([{ ticker: 'A', score: 80 }, { ticker: 'B', score: 70 }]);
    await h.c.writeRatingSnapshots([{ ticker: 'C', score: 90 }]);
    const n = h.calls.ratingInserts;
    await h.c.retryRatingWrites();
    assert.strictEqual(h.calls.ratingInserts, n, `${label}: nothing inserted`);
    assert.strictEqual(h.c.state.ratingWriteFailures.length, 2, `${label}: every batch kept`);
    for (const f of h.c.state.ratingWriteFailures) assert.ok(/cannot tell whether it landed/.test(f.message), `${label}: says why: ${f.message}`);
    assert.ok(h.persisted.includes('ratingWriteFailures'), `${label}: persisted`);
  }
});

run('kept failures are capped, and what is dropped is counted on the banner, never hidden', async () => {
  const { c, banner } = ctx({ ratingInsert: async () => ({ error: { message: 'down' } }) });
  for (let i = 0; i < 25; i++) await c.writeRatingSnapshots([{ ticker: 'T' + i, score: 70 }]);
  assert.strictEqual(c.state.ratingWriteFailures.length, 20);
  assert.strictEqual(c.state.ratingWriteFailuresDropped, 5);
  assert.ok(banner.innerHTML.includes('5 older batch(es) dropped'), banner.innerHTML);
});

run('priority: an unrecorded sale outranks a snapshot notice; both lists survive a reload', async () => {
  const { c, banner } = ctx({ insertSnapshot: async () => { throw new Error('x'); } });
  await c.recordSignalSnapshotAtBuy(pos, { score: 1 });
  c.state.saleWriteFailures = { s1: { ticker: 'SOLD', code: 'SALE_FAILED', message: 'm', at: 'x', args: [] } };
  c.updateMarketBanner();
  assert.ok(banner.innerHTML.includes('SOLD sale NOT recorded') && !banner.innerHTML.includes('buy snapshot'));
  assert.ok(/'saleWriteFailures','snapshotWriteFailures','ratingWriteFailures'(,'[A-Za-z]+')*\]\.forEach\(k => \{/.test(app), 'restored by loadState');
});
