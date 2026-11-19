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
// CHANGED 2026-11-19, declared: a label row is an ask on the CURRENT instrument (no headlines) unless a case says otherwise;
// the bar now counts the current instrument alone (STATUS, "Declared 2026-11-19").
const lab = (id, day, condition, at = '14:30', headlines = 'without') => ({ id, fetched_at: `${day}T${at}:00Z`, trading_date: day, applied: false, pattern_condition: 'CHOPPY', pattern_incomplete: false, groq_condition: condition, groq_asked: true, groq_headlines_empty: headlines === 'without' ? true : headlines === 'with' ? false : null });
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

// 2026-11-17: the DECLARED ENDING (STATUS). From 20 labelled days: extended until 5 away or 40 days; at 40 with fewer
// than 5 away, cannot conclude and closed; judged on the first 40 days in date order, so a later day cannot reopen it.
// `conds` is one condition per labelled day, in date order.
async function bar(conds) {
  const day = i => new Date(Date.UTC(2026, 11, 1) + i * 86400e3).toISOString().slice(0, 10);
  const observations = conds.map((c, i) => lab(`o${i}`, day(i), c));
  const signals = conds.map((c, i) => sig(`s${i}`, day(i), '15:00', 0.001 * (i % 7)));
  return count({ scans: conds.map((_, i) => scan(i + 1, 'groq', `o${i}`)), observations, signals });
}
const rep = (c, n) => Array(n).fill(c);
await run('the declared ending: not printed below 20 labelled days', async () => {
  const r = await bar(rep('RISK_OFF', 19));
  assert.ok(r.out.includes('labelled days 19 of 20') && !/declared ending/.test(r.out), r.out);
});
await run('the declared ending: 20 days, 4 away -> EXTENDED, with how far to each end', async () => {
  const r = await bar([...rep('RISK_OFF', 16), ...rep('BROAD_RALLY', 4)]);
  assert.ok(r.out.includes('declared ending (2026-11-17): EXTENDED: 20 of at most 40 labelled days, 4 of 5 away; it ends at 5 away or at 40 days.'), r.out);
  assert.strictEqual(r.code, 0, 'a state, never red');
});
await run('the declared ending: met inside the extension (27 days, 5 away; CHOPPY counts as away) -> BAR MET', async () => {
  const r = await bar([...rep('RISK_OFF', 22), ...rep('CHOPPY', 2), ...rep('BROAD_RALLY', 3)]);
  assert.ok(r.out.includes('declared ending (2026-11-17): BAR MET (27 labelled days, 5 away): the test may be run.'), r.out);
});
await run('the declared ending: 40 days, 4 away -> CANNOT CONCLUDE and closed; a 5th away on day 41 does not reopen it', async () => {
  const r = await bar([...rep('RISK_OFF', 36), ...rep('BROAD_RALLY', 4), 'BROAD_RALLY']);
  assert.ok(r.out.includes('declared ending (2026-11-17): CANNOT CONCLUDE -- the reading did not vary enough to be tested: 40 labelled days, 4 of 5 away (+ 4, - 36, 0 0); the sign-test is closed.'), r.out);
  assert.ok(r.out.includes('labelled days 41 of 20'), 'the plain count still reports all 41');
  assert.ok(!/outcome|0\.00[1-6]/i.test(r.out.split('sign-test bar')[1]), 'still no outcome');
});

// 2026-11-19 (the reviewer): the two instruments, reported separately and never pooled; the bar and the ending on the
// current one alone; and the instrument-change detector, in both directions.
const mixed = (heads, conds) => {
  const day = i => new Date(Date.UTC(2026, 11, 1) + i * 86400e3).toISOString().slice(0, 10);
  const observations = conds.map((c, i) => lab(`o${i}`, day(i), c, '14:30', heads[i]));
  const signals = conds.map((c, i) => sig(`s${i}`, day(i), '15:00', 0.001));
  return count({ scans: conds.map((_, i) => scan(i + 1, 'groq', `o${i}`)), observations, signals });
};
await run('by instrument: the bar counts the current instrument (without headlines) alone; the closed one is reported, not pooled', async () => {
  const r = await mixed(['with', 'with', 'without'], ['RISK_OFF', 'RISK_OFF', 'BROAD_RALLY']);
  assert.ok(r.out.includes('the current instrument, WITHOUT headlines, declared 2026-11-19): labelled days 1 of 20; by predicted sign + 1, - 0, 0 0'), r.out);
  assert.ok(r.out.includes('closed instrument (WITH headlines, until 2026-11-16; reported, not pooled): 2 labelled day(s); + 0, - 2, 0 0. Pooled across both, NOT the bar: 3.'), r.out);
});
await run('the declared ending is judged on the current instrument: 20 days with headlines start nothing', async () => {
  const r = await mixed(Array(20).fill('with'), Array(20).fill('RISK_OFF'));
  assert.ok(r.out.includes('labelled days 0 of 20') && !/declared ending/.test(r.out), r.out);
});
await run('a labelled day whose instrument cannot be placed is a DEFECT, red, named', async () => {
  const r = await mixed([null], ['RISK_OFF']);
  assert.strictEqual(r.code, 1);
  assert.ok(/DEFECT 1 labelled day\(s\) whose instrument cannot be placed/.test(r.out), r.out);
});
await run('the detector: an undeclared change in the headline state is red and named, in both directions; none is quiet', async () => {
  const back = await mixed(['without', 'without', 'with'], ['RISK_OFF', 'RISK_OFF', 'RISK_OFF']);
  assert.strictEqual(back.code, 1, 'the tags coming back is a change too');
  assert.ok(/INSTRUMENT CHANGE NOT DECLARED: without -> with headlines at 2026-12-03T14:30:00.000Z/.test(back.out), back.out);
  const gone = await mixed(['with', 'without'], ['RISK_OFF', 'RISK_OFF']);
  assert.strictEqual(gone.code, 1);
  assert.ok(/INSTRUMENT CHANGE NOT DECLARED: with -> without headlines at 2026-12-02T14:30:00.000Z/.test(gone.out), gone.out);
  const steady = await mixed(['without', 'without'], ['RISK_OFF', 'RISK_OFF']);
  assert.strictEqual(steady.code, 0);
  assert.ok(/headline-state changes: none\./.test(steady.out), steady.out);
});
await run('the detector: the declared 11-17 change is listed as declared and is not red', async () => {
  const observations = [lab('a', '2026-11-16', 'RISK_OFF', '16:37', 'with'), { ...lab('b', '2026-11-17', 'RISK_OFF', '14:59', 'without'), fetched_at: '2026-11-17T14:59:02.969+00:00' }];
  const r = await count({ scans: [scan(1, 'groq', 'a'), scan(2, 'groq', 'b')], observations, signals: [sig('1', '2026-11-16', '17:00', 0.01), sig('2', '2026-11-17', '15:00', 0.01)] });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('with -> without at 2026-11-17T14:59:02.969Z (declared)'), r.out);
});


await run('a day is placed by the ask behind its LABEL, not its last ask; a carried label row takes the ask before it', async () => {
  // labelled at 14:30 without headlines; the tags come back at 16:00 the same day: the day stays on the current instrument
  const mid = [lab('a', '2026-12-01', 'BROAD_RALLY', '14:30', 'without'), lab('b', '2026-12-01', 'RISK_OFF', '16:00', 'with')];
  const r = await count({ scans: [scan(1, 'groq', 'a'), scan(2, 'groq', 'b')], observations: mid, signals: [sig('1', '2026-12-01', '15:00', 0.01)] });
  assert.ok(r.out.includes('WITHOUT headlines, declared 2026-11-19): labelled days 1 of 20; by predicted sign + 1'), r.out);
  assert.ok(/INSTRUMENT CHANGE NOT DECLARED: without -> with/.test(r.out) && r.code === 1, 'and the change itself is still red');
  // the label row is CARRIED (no headline state of its own): the day's latest ask at or before it decides
  const carried = [lab('c', '2026-12-02', 'RISK_OFF', '13:00', 'with'), { ...lab('d', '2026-12-02', 'RISK_OFF', '14:00', null), groq_asked: false, groq_condition: 'RISK_OFF' }];
  carried[0].groq_condition = null; // the 13:00 ask labels nothing; the 14:00 carried row is the label
  const r2 = await count({ scans: [scan(1, 'groq', 'c'), scan(2, 'groq', 'd')], observations: carried, signals: [sig('2', '2026-12-02', '15:00', 0.01)] });
  assert.ok(r2.out.includes('closed instrument (WITH headlines, until 2026-11-16; reported, not pooled): 1 labelled day(s)'), r2.out);
});


await run('the bar\'s signal_log read DENIED (200, empty): COULD NOT READ and red, never "0 labelled days"', async () => {
  const r = await count({ scans: [scan(1, 'groq', 'a')], observations: [lab('a', '2026-11-13', 'RISK_OFF')], signals: [] });
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/sign-test bar: COULD NOT READ signal_log/.test(r.out) && !/labelled days/.test(r.out), r.out);
});
})();
