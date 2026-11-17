// tests/macro-observation-count.test.js -- 2026-11-12, landing (c). scripts/count-macro-observations.mjs is the daily
// proof that the macro writer is writing (backup-tables.yml). Held here in every state it can report, against a fake that
// can fail in each of the ways the real read can: an HTTP error, a short read, and the RLS-denied read, which PostgREST
// answers with 200, an empty list and a count of 0 (the failure a count alone cannot see; the control is what does).
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');

const scan = (id, macro_path, macro_observation_id = null) => ({ id, captured_at: `2026-11-13T15:${String(id).padStart(2, '0')}:00Z`, macro_path, macro_observation_id });
const obs = (id, day = '2026-11-13') => ({ id, fetched_at: `${day}T14:30:00Z`, trading_date: day, applied: false });
// CHANGED 2026-11-17, declared: signal_log is read too (both halves of the sign-test bar). Its default is one shown
// signal, so the readability control passes and no labelled day exists unless a case builds one.
const SIG = { id: 's0', signal_date: '2026-11-13', engine_source: 'EDGE', tier: 'SHOWN', first_shown_at: '2026-11-13T15:00:00Z', ret_close: 0.01, ret_close_split_in_window: false };
function fakeFetch({ scans = [], observations = [], signals = [SIG], status = {}, short = null }) {
  return async url => {
    const table = url.split('/rest/v1/')[1].split('?')[0];
    if (status[table]) return { ok: false, status: status[table], text: async () => 'boom', headers: { get: () => null }, json: async () => [] };
    let rows = table === 'rating_snapshots' ? scans : table === 'signal_log' ? signals : observations;
    if (/limit=1(&|$)/.test(url)) rows = rows.slice(0, 1); // the positive-control read
    const total = short === table ? rows.length + 1 : rows.length;
    return { ok: true, status: 200, text: async () => '', headers: { get: k => (k === 'content-range' ? `0-${Math.max(0, rows.length - 1)}/${total}` : null) }, json: async () => rows };
  };
}
async function count(opts) {
  const { main } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/count-macro-observations.mjs')).href);
  const lines = [];
  const code = await main({ fetchImpl: fakeFetch(opts), log: l => lines.push(l), now: new Date('2026-11-13T23:00:00Z') });
  return { code, out: lines.join('\n') };
}

(async () => {
await run('no scan by an observing build yet: NOT STARTED, never "0 observations" read as a result', async () => {
  const r = await count({ scans: [], observations: [] });
  assert.strictEqual(r.code, 0);
  assert.ok(/NOT STARTED/.test(r.out), r.out);
});

await run('scans point to observations that read back: counted, with the newest, the days, and the control line', async () => {
  const r = await count({ scans: [scan(1, 'pattern', 'o1'), scan(2, 'groq', 'o2'), scan(3, 'not_fetched')], observations: [obs('o1', '2026-11-12'), obs('o2')] });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/2 observation\(s\) on 2 trading day\(s\); newest 2026-11-13T14:30:00Z/.test(r.out), r.out);
  assert.ok(/control: 3 rating_snapshots row\(s\) .* pointing to 2 observation\(s\); 1 scanned with the quotes not fetched/.test(r.out), r.out);
});

await run('THE DENIED READ: observations come back 200, empty, count 0, while the scans say readings were decided -- RED', async () => {
  const r = await count({ scans: [scan(1, 'pattern', 'o1')], observations: [] });
  assert.strictEqual(r.code, 1);
  assert.ok(/cannot be read here/.test(r.out) && /reads back empty: not written, or not readable/.test(r.out), r.out);
});

await run('an observation the scans point to is missing: RED, named', async () => {
  const r = await count({ scans: [scan(1, 'pattern', 'o1'), scan(2, 'groq', 'o9')], observations: [obs('o1')] });
  assert.strictEqual(r.code, 1);
  assert.ok(/1 observation\(s\) the scans point to cannot be read here .*o9/.test(r.out), r.out);
});

await run('a decided reading recorded with no observation id: the write failed -- RED', async () => {
  const r = await count({ scans: [scan(1, 'unclassified', null)], observations: [obs('o1')] });
  assert.strictEqual(r.code, 1);
  assert.ok(/recorded a decided macro reading with no observation/.test(r.out), r.out);
});

await run('only scans whose quotes were not fetched: no observation is owed, so empty is not a defect', async () => {
  const r = await count({ scans: [scan(1, 'not_fetched'), scan(2, 'not_fetched')], observations: [] });
  assert.strictEqual(r.code, 0, r.out);
});

await run('a failed or short read is COULD NOT READ, and red, never a count', async () => {
  for (const opts of [{ status: { macro_observations: 503 } }, { status: { rating_snapshots: 401 } }, { scans: [scan(1, 'pattern', 'o1')], observations: [obs('o1')], short: 'macro_observations' }]) {
    const r = await count(opts);
    assert.strictEqual(r.code, 1, JSON.stringify(opts));
    assert.ok(/COULD NOT READ/.test(r.out), r.out);
  }
});

// 2026-11-17: BOTH halves of the registered bar, counted by the registration's own code (buildDays, barState). Three
// labelled days, two signs: RISK_OFF (-1), SECTOR_WEAKNESS_TECH (-1), BROAD_RALLY (+1). Plus a day with only a pattern
// reading (no Groq answer given the moves: labels nothing) and a day whose signals all predate the label.
const lab = (id, day, condition, at = '14:30') => ({ id, fetched_at: `${day}T${at}:00Z`, trading_date: day, applied: false, pattern_condition: 'CHOPPY', pattern_incomplete: false, groq_condition: condition });
const sig = (id, day, at, ret) => ({ id, signal_date: day, engine_source: 'EDGE', tier: 'SHOWN', first_shown_at: `${day}T${at}:00Z`, ret_close: ret, ret_close_split_in_window: false });
await run('the sign-test bar: both halves printed, labelled days and the split by sign, and no outcome', async () => {
  const observations = [lab('a', '2026-11-13', 'RISK_OFF'), lab('b', '2026-11-16', 'SECTOR_WEAKNESS_TECH'), lab('c', '2026-11-17', 'BROAD_RALLY'),
    { ...lab('d', '2026-11-18', null), groq_condition: null }, lab('e', '2026-11-19', 'RISK_OFF', '16:00')];
  const signals = [sig('1', '2026-11-13', '15:00', 0.0123), sig('2', '2026-11-16', '15:00', -0.004), sig('3', '2026-11-17', '15:00', 0.02), sig('4', '2026-11-19', '15:00', 0.01)];
  const r = await count({ scans: ['a', 'b', 'c', 'd', 'e'].map((o, i) => scan(i + 1, 'groq', o)), observations, signals });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('labelled days 3 of 20; by predicted sign + 1, - 2, 0 0; away from the most common sign 1 of 5; not met.'), r.out);
  assert.ok(/not labelled: 2026-11-18 \(no Groq answer given the moves\); 2026-11-19 \(all 1 signal\(s\) were first shown before the label\)\./.test(r.out), r.out);
  assert.ok(!/1\.23|0\.4|2\.0\b|outcome/i.test(r.out.split('sign-test bar')[1]), 'no outcome printed: ' + r.out);
});

await run('the bar\'s signal_log read DENIED (200, empty): COULD NOT READ and red, never "0 labelled days"', async () => {
  const r = await count({ scans: [scan(1, 'groq', 'a')], observations: [lab('a', '2026-11-13', 'RISK_OFF')], signals: [] });
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/sign-test bar: COULD NOT READ signal_log/.test(r.out) && !/labelled days/.test(r.out), r.out);
});
})();
