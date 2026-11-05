// tests/unpaged-reads.test.js — 2026-11-04. PostgREST answers any read with at
// most 1,000 rows, status 200 and no error. rating_snapshots (3,665) and signal_log
// (2,311) are past it. The score history said "Total snapshots recorded: 1000" with
// data ending 09-02, and fill-outcomes read exactly 1,000 pending rows on two runs.
//
// This enumerates every Supabase read in the app and in every script, and each has
// to be mechanically bounded (pages, limits, a head count, one row by id, its own
// write) or be listed below with why it can't reach 1,000. It fails both ways: a
// new unpaged read, and an entry whose read is gone. Keyed like empty-read-sites.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const { readSource, run, REPO_ROOT } = require('./_lib');

// Unpaged by design. Each says why it stays well under 1,000 rows.
const BOUNDED = {
  'app.js|analysis_periods': 'periods Roman starts by hand: 1 row at f66fe02',
  'core/store.js|portfolio': 'open positions and pending orders only, and every sale deletes its row: 11 live on 2026-11-05',
  'scripts/analyze-model-b-winners.mjs|trades_v2': 'one trade, by ticker, buy date and sell date',
  'scripts/fill-outcomes.mjs|trades_v2': 'one symbol, from a signal date across a 9-day window',
  'scripts/fill-outcomes.mjs|signal_log': 'later signals for one symbol and engine: at most a row per tier per day',
  'scripts/lib/scan-gate.mjs|scan_runs': 'one engine, one date',
  'scripts/log-signals-edge.mjs|signal_log': 'one scan session: about 80 symbols',
  'scripts/log-signals-warrior.mjs|signal_log': 'one scan session',
  'scripts/log-signals-warrior.mjs|setup_triggers': 'one scan session',
  'scripts/measure-gate-buyable.mjs|scan_runs': 'one engine, one session, a fixed list of dates',
  'scripts/measure-prefilter-feed.mjs|scan_runs': 'one engine, one session, a fixed list of dates',
};

const list = (dir, re) => fs.readdirSync(path.join(REPO_ROOT, dir)).filter(f => re.test(f)).map(f => `${dir}/${f}`);
const strip = src => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

function appReads() {
  const files = ['app.js', ...list('core', /\.js$/), ...list('shell', /\.js$/),
    ...fs.readdirSync(path.join(REPO_ROOT, 'engines')).flatMap(d => list(`engines/${d}`, /\.js$/))];
  const out = [];
  for (const f of files) {
    const src = strip(readSource(f));
    for (const m of src.matchAll(/\.from\('([a-z_0-9]+)'\)/g)) {
      const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 20000).split(';')[0];
      if (!/\.select\(/.test(tail)) continue;
      const head = src.slice(Math.max(0, m.index - 80), m.index);
      const bounded = /readAllRows\(\(\) =>[\s\S]*$/.test(head) || /\.limit\(|\.maybeSingle\(|head: true|\.insert\(|\.update\(|\.eq\('(id|captured_at)'/.test(tail);
      out.push({ key: `${f}|${m[1]}`, bounded });
    }
  }
  return out;
}
function scriptReads() {
  const out = [];
  const files = [...list('scripts', /\.(mjs|cjs|js)$/), ...list('scripts/lib', /\.(mjs|cjs|js)$/)];
  for (const f of files) {
    const src = strip(readSource(f));
    for (const m of src.matchAll(/(fetch(?:Impl|AllRows)?)\(\s*`[^`]*\/rest\/v1\/(\$\{[a-zA-Z]+\}|[a-z_0-9]+)([^`]*)`/g)) {
      const call = src.slice(m.index, m.index + 700);
      const end = call.indexOf(');');
      const stmt = end > 0 ? call.slice(0, end) : call;
      if (/method:\s*'(POST|PATCH|DELETE|HEAD)'/.test(stmt)) continue;
      const bounded = m[1] === 'fetchAllRows' || /Range:/.test(stmt) || /[?&]limit=/.test(m[3]) || /[?&]id=(eq|in)\./.test(m[3]) || /Range:/.test(src.slice(Math.max(0, m.index - 300), m.index + 700));
      out.push({ key: `${f}|${m[2]}`, bounded });
    }
  }
  return out;
}

run('enumeration finds the known reads, in the app and in scripts no workflow runs', () => {
  const found = new Set([...appReads(), ...scriptReads()].map(r => r.key));
  for (const k of ['app.js|rating_snapshots', 'app.js|trades_v2', 'core/store.js|portfolio', 'scripts/fill-outcomes.mjs|signal_log', 'scripts/audit-signal-log-splits.mjs|signal_log', 'scripts/measure-iex-vs-sip-scoring.mjs|signal_snapshot_at_buy'])
    assert.ok(found.has(k), `enumerator did not find ${k}`);
});

run('every read is bounded or says why it can stay unpaged, and no entry outlives its read', () => {
  const reads = [...appReads(), ...scriptReads()];
  const unbounded = [...new Set(reads.filter(r => !r.bounded).map(r => r.key))];
  const unexplained = unbounded.filter(k => !BOUNDED[k]);
  assert.deepStrictEqual(unexplained, [], 'an unpaged read truncates silently at 1,000 rows. Use readAllRows (app) or fetchAllRows (scripts), or say in BOUNDED why it cannot reach 1,000:\n  ' + unexplained.join('\n  '));
  const stale = Object.keys(BOUNDED).filter(k => !unbounded.includes(k));
  assert.deepStrictEqual(stale, [], 'no such unpaged read any more; remove:\n  ' + stale.join('\n  '));
});

run('the tables past 1,000 rows have no unpaged whole-table read anywhere', () => {
  const reads = [...appReads(), ...scriptReads()].filter(r => !r.bounded).map(r => r.key);
  for (const k of ['app.js|rating_snapshots', 'app.js|trades_v2', 'scripts/audit-signal-log-splits.mjs|signal_log', 'scripts/measure-iex-vs-sip-scoring.mjs|signal_snapshot_at_buy'])
    assert.ok(!reads.includes(k), `${k} reads unpaged`);
});

// A table behind the 1,000-row cap, as supabase-js sees it: one page per .range().
function capped(rows, opts = {}) {
  const calls = [];
  return {
    calls,
    query: () => ({
      range: async (from, to) => {
        calls.push([from, to]);
        if (opts.error) return { data: null, error: opts.error, count: null };
        return { data: rows.slice(from, Math.min(to + 1, from + (opts.cap || 1000))), error: null, count: opts.count === undefined ? rows.length : opts.count };
      },
    }),
  };
}
const appHelper = () => {
  const src = readSource('core/store.js');
  const a = src.indexOf('const READ_PAGE_SIZE');
  const b = src.indexOf('\n}\n', src.indexOf('async function readAllRows', a));
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b + 3) + '\n;globalThis.readAllRows = readAllRows;', ctx);
  return ctx.readAllRows;
};
const rows3628 = Array.from({ length: 3628 }, (_, i) => ({ id: i }));

run('readAllRows: all 3,628 behind a 1,000-row cap, in order', async () => {
  const readAllRows = appHelper();
  const t = capped(rows3628);
  const { data, error } = await readAllRows(t.query);
  assert.strictEqual(error, null);
  assert.strictEqual(data.length, 3628);
  assert.deepStrictEqual(Array.from(data, r => r.id), rows3628.map(r => r.id));
  assert.strictEqual(t.calls.length, 4);
});

run('readAllRows: a short read is an error, never a smaller answer; an empty table is an empty answer', async () => {
  const readAllRows = appHelper();
  const stops = capped(rows3628.slice(0, 1000), { count: 3628 });
  const out = await readAllRows(stops.query);
  assert.ok(out.error, 'count says 3,628, read 1,000');
  assert.strictEqual(out.data, null, 'and no partial rows to show');
  const noCount = await readAllRows(capped(rows3628, { count: null }).query);
  assert.ok(/completeness is unknown/.test(noCount.error.message), 'no count means completeness cannot be known');
  const fail = { code: '42501', message: 'denied' };
  assert.strictEqual((await readAllRows(capped([], { error: fail }).query)).error, fail, 'a refused read passes its error on');
  const empty = await readAllRows(capped([]).query);
  assert.strictEqual(empty.error, null);
  assert.strictEqual(empty.data.length, 0);
});

const fakeRes = (status, body, range) => ({ status, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => range } });
run('fetchAllRows: all rows across pages; a short read, no count, or a failure throws', async () => {
  const { fetchAllRows } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/read-all.mjs')).href);
  const server = n => async (url, { headers }) => {
    const [from, to] = headers.Range.split('-').map(Number);
    assert.strictEqual(headers.Prefer, 'count=exact');
    return fakeRes(206, rows3628.slice(from, Math.min(to + 1, from + 1000)), `${from}-${to}/${n}`);
  };
  assert.strictEqual((await fetchAllRows('u?order=id', {}, 'L', server(3628))).length, 3628);
  await assert.rejects(fetchAllRows('u?order=id', {}, 'L', server(5000)), /read 3628 rows of 5000/);
  await assert.rejects(fetchAllRows('u?order=id', {}, 'L', async () => fakeRes(200, rows3628.slice(0, 1000), null)), /no authoritative row count/);
  await assert.rejects(fetchAllRows('u?order=id', {}, 'L', async () => fakeRes(401, {}, null)), /L failed: 401/);
});

run('the pending-rows read cannot resolve part of a group again: it pages, and on a stable order', () => {
  const src = readSource('scripts/fill-outcomes.mjs');
  assert.ok(/fetchAllRows\(`\$\{SUPABASE_URL\}\/rest\/v1\/signal_log\?select=\$\{selectCols\}&signal_date=gte\.\$\{cutoff\}&\$\{orFilter\}&order=id`/.test(src), 'pending rows');
  assert.ok(/fetchAllRows\(`\$\{SUPABASE_URL\}\/rest\/v1\/signal_log\?select=id,symbol,signal_date,engine_source,tier&taken_resolution=eq\.unresolved&order=id`/.test(src), 'stale-unresolved check: 945 rows live on 2026-11-05');
});

run('a symbol-day group resolved in parts is detected, both ways', async () => {
  const { takenGroupProblems: p } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/taken-groups.mjs')).href);
  const row = (tier, res, id = null) => ({ signal_date: 'd', symbol: 'S', engine_source: 'EDGE', tier, taken_resolution: res, matched_trade_id: id });
  assert.deepStrictEqual(p([row('SHOWN', 'taken-exact', 't'), row('BELOW_THRESHOLD', 'not-taken-confirmed')]), [], 'a whole resolve');
  assert.deepStrictEqual(p([row('BELOW_THRESHOLD', 'traded-against-engine', 't')]), [], 'traded against, alone');
  const cases = [
    [[row('SHOWN', 'taken-exact', 't'), row('QUALIFIED', 'taken-by-fallback', 't')], 'two taken rows'],
    [[row('SHOWN', 'taken-exact', 't'), row('BELOW_THRESHOLD', 'traded-against-engine', 't')], 'taken and traded-against in one group'],
    [[row('SHOWN', 'not-taken-confirmed', 'a'), row('BELOW_THRESHOLD', 'not-taken-confirmed', 'b')], 'two matched trades'],
    [[row('SHOWN', 'unresolved'), row('BELOW_THRESHOLD', 'not-taken-confirmed')], 'part unresolved'],
    [[row('BELOW_THRESHOLD', 'taken-exact', 't'), row('SHOWN', 'not-taken-confirmed')], 'taken on a lower tier than a sibling'],
    [[row('NEAR_MISS', 'taken-exact', 't'), row('QUALIFIED', 'not-taken-confirmed')], 'taken on a lower tier than a sibling'],
  ];
  for (const [rows, why] of cases) assert.ok(p(rows).some(x => x.why === why), why);
});

run('the audit\'s answer is in the spec, with the runs and what they did', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('EVERY READ PAST 1,000 ROWS (2026-11-04)'));
  assert.ok(spec.includes('2026-11-03T02:33Z and 2026-11-05T00:59Z'), 'the two truncated runs');
  assert.ok(spec.includes('Total snapshots recorded: 1000'), 'the signature to look for in pasted reports');
});
