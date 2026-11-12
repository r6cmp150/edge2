// tests/live-columns.test.js — 2026-11-06. MAIN IS DEPLOYABLE AT EVERY COMMIT: pushing main deploys the app against
// the live database, so nothing on main may WRITE or NAME a column the live schema lacks (PostgREST refuses the whole
// request over one unknown column, in a payload, a select, a filter or an order; the request that fails is a buy, a
// sale or a read). Every (table, column) the app, the scripts and the workflows write or name is enumerated from the
// code and checked against db/live-columns.json, which scripts/capture-live-columns.mjs generates from a capture of the
// live database (never a hand edit: its hashes and counts are recomputed below, and the migrations it is declared to
// reflect are checked against db/ and against the capture).
// Three states per write site: ENUMERATED (its columns are read from the code), NOT ENUMERABLE (the walker can't see
// its columns: a computed key, a spread of something it can't resolve) -- which FAILS, because a column the guard can't
// see is a hole in the guard -- and the columns' verdict against the live list.
// Direction: a migration run with nobody updating the file leaves the file behind, and the test still passes (harmless).
// It fails only when code gets AHEAD of the live schema.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { run, readSource, REPO_ROOT } = require('./_lib');

const LIVE = JSON.parse(readSource('db/live-columns.json')).tables;
const { ALIASES, BACKUP, FILTERS, HOLE, NAMES_NONE, NotEnumerable, array, assigned, backupSites, balanced, callsOf, chainCalls, chainNames, collected, column, enclosingBlock, enclosingFunction, entries, enumerate, enumerateNames, fnReturn, identifier, list, literal, logicTree, loopValues, named, plain, queryNames, resolve, resolveSite, selectList, shown, sites, splitTop, statementAt, strings, strip, template, templateEnd, ternary , stripSql } = require('./_write-walker');

(async () => {
await run('the walker: literals, builders, spreads, .map, property assignment and parameters resolve; a computed key does not', () => {
  const ctx = src => ({ sources: new Map([['x.js', src]]), aliases: {}, file: 'x.js' });
  const r = (src, expr) => [...resolve(expr, src, src.length, ctx(src))].sort();
  assert.deepStrictEqual(r('', "{ a: 1, b, 'c': f(x, { d: 2 }) }"), ['a', 'b', 'c'], 'nested braces are not keys');
  assert.deepStrictEqual(r('function mk(p) { return { x: p.x, y: 1 }; }', '{ ...mk(p), z: 1 }'), ['x', 'y', 'z']);
  assert.deepStrictEqual(r('const rows = list.map(s => ({ t: s.t, u: "a,b" }));', 'rows'), ['t', 'u'], 'commas in strings');
  assert.deepStrictEqual(r('const p = patchFor(id);\np.ret_5m = 1;\nif (q) p.ret_1d = 2; if (p.ret_5m == null) {}', 'p'), ['ret_1d', 'ret_5m'], '== is a read, not a write');
  // a map of patch objects filled through a builder, assigned both through a variable and on the call's result
  // (fill-outcomes.mjs's shape; the second form was invisible until 2026-11-11)
  const patchSrc = 'const patches = new Map();\nfunction patchFor(id) { if (!patches.has(id)) patches.set(id, {}); return patches.get(id); }\n'
    + 'const p = patchFor(1);\np.ret_5m = 1;\npatchFor(2).taken_resolution = cond ? "a" : "b";\nif (patchFor(3).x == null) {}\n';
  assert.deepStrictEqual([...collected('patches', patchSrc, ctx(patchSrc), 0)].sort(), ['ret_5m', 'taken_resolution'], 'fn(..).col = is a write; fn(..).col == is a read');
  assert.throws(() => collected('patches', patchSrc + 'patchFor(4)[k] = 1;\n', ctx(patchSrc), 0), NotEnumerable, 'a computed key on the call result');
  assert.throws(() => r('', '{ [k]: 1 }'), NotEnumerable, 'a computed key');
  assert.throws(() => r('const p = {};\np[col] = 1;', 'p'), NotEnumerable, 'a computed assignment');
  assert.throws(() => r('', 'somethingElse.call(x)'), NotEnumerable);
});

await run('the enumeration finds the known write sites, on every surface', () => {
  const e = enumerate();
  const has = (t, re) => e.some(s => s.table === t && re.test(s.where));
  assert.ok(has('trades_v2', /^app\.js/), 'the sale');
  assert.ok(has('portfolio', /^core\/store\.js/), 'positions');
  assert.ok(has('settings', /^core\/store\.js/), 'settings');
  assert.ok(has('rating_snapshots', /^app\.js/) && has('signal_snapshot_at_buy', /^core/));
  assert.ok(has('signal_log', /log-signals-edge/) && has('scan_runs', /log-signals-warrior/) && has('setup_triggers', /log-signals-warrior/));
  assert.ok(has('signal_log', /fill-outcomes/) && has('trades_v2', /fill-outcomes/), 'outcome_filler\'s PATCHes');
  assert.ok(e.filter(s => s.table === 'workflow_runs').length >= 12, 'every workflow\'s insert and PATCH');
});

await run('every write site is enumerable: a column the walker can\'t see is a hole in the guard', () => {
  const holes = enumerate().filter(s => s.state === 'NOT ENUMERABLE').map(s => `${s.where} ${s.table}: ${s.why}`);
  assert.deepStrictEqual(holes, []);
});

await run('names: select lists, logic filters, query strings and builder chains read; what can\'t be read is NOT ENUMERABLE', () => {
  assert.deepStrictEqual(selectList('id, b:ticker, captured_at::text, snap->>bars, *'), ['id', 'ticker', 'captured_at', 'snap']);
  assert.throws(() => selectList('id, trades_v2(id)'), NotEnumerable, 'an embedded resource');
  assert.deepStrictEqual(logicTree('(a.is.null,b.in.(1,2),and(c.gt.2,d.not.is.null),not.or(e.eq.1))'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepStrictEqual(queryNames('select=a,b&c=eq.x&order=d.desc,e.asc&on_conflict=f,g&or=(h.is.null)&limit=1&offset=2'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepStrictEqual(queryNames(`id=eq.${HOLE}&x=in.(${HOLE})`), ['id', 'x'], 'an unresolved VALUE is harmless');
  assert.throws(() => queryNames(`select=${HOLE}`), NotEnumerable, 'an unresolved column is not');
  assert.throws(() => queryNames(`order=${HOLE}.asc`), NotEnumerable);
  const chain = src => chainNames(chainCalls(src, 0));
  assert.deepStrictEqual(chain(".select('a, b').eq('c', x).gte('d', y).order('e', { ascending: false }).limit(1);"), ['a', 'b', 'c', 'd', 'e']);
  assert.deepStrictEqual(chain(".insert([{ z: 1 }]).select('id');"), ['id'], 'a write\'s columns are the write sites\'; its returning select is a name');
  assert.throws(() => chain('.eq(col, x);'), NotEnumerable, 'a computed filter column');
  assert.throws(() => chain('.select(cols);'), NotEnumerable, 'a computed select');
  assert.throws(() => chain('.frobnicate(1);'), NotEnumerable, 'an unknown call');
  const ctx = src => ({ sources: new Map([['x.mjs', src]]), aliases: {}, file: 'x.mjs', bind: null });
  const src = "const COLS = 'a,b';\nfunction q(t, sel = '*') { return `${U}/rest/v1/${t}?select=${sel}`; }\nq('t1', `${COLS},c`); q('t2');";
  const lit = src.match(/`\$\{U\}[^\n]*`/)[0], at = src.indexOf(lit), fn = enclosingFunction(src, at);
  const per = callsOf('q', 'x.mjs', ctx(src)).map(c => template(lit, src, at, { ...ctx(src), bind: { file: 'x.mjs', start: fn.start, end: fn.end, args: { t: { expr: c.args[0], src, at: c.at, file: 'x.mjs' }, sel: c.args[1] ? { expr: c.args[1], src, at: c.at, file: 'x.mjs' } : { expr: "'*'", src, at: fn.start, file: 'x.mjs' } } } }, 0, true));
  assert.deepStrictEqual(per, [[`${HOLE}/rest/v1/t1?select=a,b,c`], [`${HOLE}/rest/v1/t2?select=*`]], 'each caller binds the table and the columns together, never crossed');
});

await run('the name enumeration finds the known reads, filters and orders, on every surface', async () => {
  const e = await enumerateNames();
  const has = (t, re, col) => e.some(s => s.table === t && re.test(s.where) && s.state === 'ENUMERATED' && s.cols.has(col));
  assert.ok(has('workflow_runs', /^app\.js/, 'job_status') && has('workflow_runs', /^app\.js/, 'actual_fired_at'), 'a select and a filter (app)');
  assert.ok(has('rating_snapshots', /^app\.js/, 'captured_at'), 'an order (app)');
  assert.ok(has('portfolio', /^core\/store\.js/, 'position_id'), 'the save\'s .eq and its returning select');
  assert.ok(has('signal_log', /fill-outcomes/, 'taken_resolution') && has('signal_log', /fill-outcomes/, 'ret_5d'), 'fill-outcomes: its or= filter and its select constant');
  assert.ok(has('trades_v2', /select-by-ids.*fill-outcomes/, 'best_exit_price') && !e.some(s => s.table === 'signal_log' && /select-by-ids/.test(s.where) && s.cols && s.cols.has('best_exit_price')), 'a helper resolved per caller, never crossed');
  assert.ok(has('scan_runs', /schema-check.*log-signals-edge/, 'started_at') || has('scan_runs', /schema-check/, 'scan_date'), 'the schema check names what the logger writes');
  assert.ok(has('signal_log', /backup-tables/, 'outcomes_filled_at') && has('rating_snapshots', /backup-tables/, 'captured_at'), 'the backup\'s shard filters, from its own modules');
  assert.ok(has('workflow_runs', /\.github\/workflows/, 'id'), 'a workflow PATCH\'s ?id=eq.$ID');
});

await run('every name site is enumerable: a column the walker can\'t see is a hole in the guard', async () => {
  const holes = (await enumerateNames()).filter(s => s.state === 'NOT ENUMERABLE').map(s => `${s.where} ${s.table}: ${s.why}`);
  assert.deepStrictEqual(holes, []);
});

// db/live-columns.json is a CAPTURE, never a hand edit (scripts/capture-live-columns.mjs writes it): its hashes and counts
// recompute, and the migrations it is declared to reflect agree with db/ and with the capture itself.
const CAPTURE = JSON.parse(readSource('db/live-columns.json'));
const sha = s => require('crypto').createHash('sha256').update(s).digest('hex');
// Each numbered migration's added and dropped columns, and created and dropped tables (comments out; rollbacks and run
// files aren't migrations).
function migrations() {
  const out = new Map();
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'db')).filter(f => /^\d{3}_.*\.sql$/.test(f))) {
    const sql = stripSql(readSource(`db/${f}`)).toLowerCase(); // quote-aware: a "--" inside a literal is not a comment
    const adds = [], creates = [], drops = [];
    for (const a of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z_0-9]+)([\s\S]*?);/g)) {
      for (const c of a[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_0-9]+)/g)) adds.push(`${a[1]}.${c[1]}`);
      for (const c of a[2].matchAll(/drop\s+column\s+(?:if\s+exists\s+)?([a-z_0-9]+)/g)) drops.push(`${a[1]}.${c[1]}`);
    }
    for (const c of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_0-9]+)\s*\(/g)) {
      creates.push(c[1]);
      // its columns, by name: a misspelt column of a new table is not "introduced" by the migration that creates it
      for (const e of entries(`{${balanced(sql, c.index + c[0].length - 1).slice(1, -1)}}`)) {
        const col = e.match(/^([a-z_][a-z_0-9]*)\s/);
        if (col && !/^(constraint|primary|unique|check|foreign|exclude|like)$/.test(col[1])) adds.push(`${c[1]}.${col[1]}`);
      }
    }
    for (const c of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_0-9]+)/g)) drops.push(c[1]);
    for (const c of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_0-9]+)\s*\(/g)) creates.push(`rpc/${c[1]}`);
    out.set(Number(f.slice(0, 3)), { file: f, adds, creates, drops });
  }
  return out;
}
const pad = n => `db/${String(n).padStart(3, '0')}`;
// db/pending-migrations.json: a branch whose code depends on migrations not yet live DECLARES them, and the suite stays
// green with every column they introduce reported as PENDING, by name and by migration. A column ahead of the capture
// that no declared-pending migration introduces still FAILS. Main never declares any: scripts/check-push.mjs refuses a
// commit that does (--before, run ahead of the push), and refuses a declaration that is stale (a migration it lists that
// the capture shows applied). No file: nothing pending.
const PENDING = fs.existsSync(path.join(REPO_ROOT, 'db/pending-migrations.json')) ? JSON.parse(readSource('db/pending-migrations.json')).pending : [];
// Which declared-pending migration introduces (table, column), or null.
function pendingSource(table, col, mig) {
  for (const n of PENDING) {
    const x = mig.get(n);
    if (x && (x.adds.includes(`${table}.${col}`) || (col == null && x.creates.includes(table)))) return n;
  }
  return null;
}

await run('the SQL reader is quote-aware: a "--" or "/*" inside a literal is not a comment, and the literal survives whole', () => {
  // the shape db/027 and db/016 carry (a COMMENT ON literal with " -- " in it), with DDL after it on the same line
  const sql = "comment on column t.a is 'order date -- the decision'; alter table t add column b text; -- a comment\n/* x */ select '/* not a comment */';";
  assert.strictEqual(stripSql(sql), "comment on column t.a is 'order date -- the decision'; alter table t add column b text; \n select '/* not a comment */';");
  assert.strictEqual(stripSql("select 'it''s -- fine' -- gone"), "select 'it''s -- fine' ");
});

await run('db/live-columns.json is a capture: query, row counts and sha256 recorded, and they recompute', () => {
  const s = CAPTURE._source;
  assert.ok(/^GENERATED by scripts\/capture-live-columns\.mjs/.test(CAPTURE._rule), 'written by the generator');
  assert.strictEqual(sha(readSource(s.query).replace(/\r\n/g, '\n')), s.query_sha256, `the capture came from ${s.query} as it is in the repo; if the query changed, re-capture`);
  // A day can hold two captures (2026-11-11: 03:11Z, then 23:17Z after db/043): a day's later captures take a letter,
  // so no capture is overwritten to make room and none carries a false date. The date in the name is the captured date.
  const named = /^live-schema-(\d{4}-\d{2}-\d{2})[a-z]?\.json$/.exec(s.capture_file);
  assert.ok(named && named[1] === s.captured && /^[0-9a-f]{64}$/.test(s.capture_sha256), 'the capture file named, dated and hashed');
  assert.ok(['db/inspect-public-schema-read-only.sql', 'db/inspect-public-schema-v2-read-only.sql'].includes(s.query), `an inspect query: ${s.query}`);
  assert.strictEqual(sha(JSON.stringify(CAPTURE.tables)), s.tables_sha256, 'the tables are exactly what the generator wrote: a hand edit changes this hash');
  assert.strictEqual(sha(JSON.stringify(CAPTURE.functions)), s.functions_sha256, 'and the functions');
  assert.strictEqual(sha(JSON.stringify(CAPTURE.checks)), s.checks_sha256, 'and the CHECK constraints');
  assert.strictEqual(Object.values(CAPTURE.checks).reduce((n, c) => n + Object.keys(c).length, 0), s.checks, 'and their count');
  assert.strictEqual(sha(JSON.stringify(CAPTURE.defaults)), s.defaults_sha256, 'and the column DEFAULTs');
  assert.strictEqual(Object.values(CAPTURE.defaults).reduce((n, d) => n + Object.keys(d).length, 0), s.defaults, 'and their count');
  assert.ok(CAPTURE.functions === null ? /read-only\.sql$/.test(s.query) && !s.query.includes('-v2-') : Array.isArray(CAPTURE.functions) && s.query.includes('-v2-'), 'functions: null exactly when the v1 query (which reads none) produced the capture');
  assert.strictEqual(Object.keys(CAPTURE.tables).length, s.tables);
  assert.strictEqual(Object.values(CAPTURE.tables).reduce((n, c) => n + c.length, 0), s.columns);
});

await run('every migration in db/ is declared applied or not; none newer than the capture\'s highest applied is assumed live', () => {
  const m = CAPTURE._migrations, files = [...migrations().keys()].sort((a, b) => a - b);
  // a branch's declared-pending migration is declared too: not applied, by the branch that depends on it
  const declared = [...new Set([...m.applied, ...m.not_applied, ...PENDING])];
  assert.deepStrictEqual(m.applied.filter(n => m.not_applied.includes(n)), [], 'in both lists');
  assert.deepStrictEqual(PENDING.filter(n => m.applied.includes(n)).map(pad), [], 'STALE: declared pending, but the capture shows it applied; take it out of db/pending-migrations.json');
  assert.deepStrictEqual(files.filter(n => !declared.includes(n)).map(pad), [], 'a migration in db/ the capture\'s declaration doesn\'t know: re-capture, or declare it not applied');
  assert.deepStrictEqual(declared.filter(n => !files.includes(n)).map(pad), [], 'declared, but no such migration file');
  assert.strictEqual(m.highest_applied, Math.max(...m.applied));
  assert.deepStrictEqual(files.filter(n => n > m.highest_applied && !m.not_applied.includes(n) && !PENDING.includes(n)).map(pad), [], 'newer than the highest migration the capture reflects');
});

await run('the declaration agrees with the capture: a not-applied migration\'s columns are absent, an applied one\'s present', () => {
  const m = CAPTURE._migrations, mig = migrations(), T = CAPTURE.tables, F = CAPTURE.functions;
  const present = tc => { const [t, c] = tc.split('.'); return !!T[t] && T[t].includes(c); };
  const wrong = [];
  for (const n of [...new Set([...m.not_applied, ...PENDING])]) {
    const x = mig.get(n);
    for (const tc of x.adds) if (present(tc)) wrong.push(`${pad(n)} declared NOT applied, but ${tc} is live: is it applied?`);
    for (const t of x.creates.filter(t => !t.startsWith('rpc/'))) if (T[t]) wrong.push(`${pad(n)} declared NOT applied, but table ${t} is live`);
    // functions only when the capture read them (v2); a v1 capture can't confirm one either way
    if (F) for (const t of x.creates.filter(t => t.startsWith('rpc/'))) if (F.includes(t.slice(4))) wrong.push(`${pad(n)} declared NOT applied, but function ${t.slice(4)} is live`);
  }
  // what an applied migration adds is live unless a LATER applied migration drops it (db/010's armed_setup_id, db/013)
  const droppedAfter = (n, what) => m.applied.some(k => k > n && mig.get(k).drops.includes(what));
  for (const n of m.applied) {
    const x = mig.get(n);
    for (const tc of x.adds) if (!present(tc) && !droppedAfter(n, tc)) wrong.push(`${pad(n)} declared applied, but ${tc} is not in the capture`);
    if (F) for (const t of x.creates.filter(t => t.startsWith('rpc/'))) if (!F.includes(t.slice(4)) && !droppedAfter(n, t)) wrong.push(`${pad(n)} declared applied, but function ${t.slice(4)} is not in the capture`);
    for (const t of x.creates.filter(t => !t.startsWith('rpc/'))) if (!T[t] && !droppedAfter(n, t)) wrong.push(`${pad(n)} declared applied, but table ${t} is not in the capture`);
  }
  assert.deepStrictEqual(wrong, []);
});

await run('MAIN IS DEPLOYABLE: every column anything writes or names exists live (db/live-columns.json)', async () => {
  // three outcomes per (table, column): LIVE (in the capture), PENDING (a declared-pending migration introduces it, and
  // which), or FAIL (neither)
  const ahead = [], pending = new Map(), mig = migrations();
  const judge = (s, table, col, what) => {
    const n = pendingSource(table, col, mig);
    if (n == null) ahead.push(`${s.where}: ${what}`);
    else { if (!pending.has(n)) pending.set(n, new Set()); pending.get(n).add(table.startsWith('rpc/') ? `function ${table.slice(4)}` : `${table}.${col}`); }
  };
  for (const s of [...enumerate(), ...await enumerateNames()].filter(s => s.state === 'ENUMERATED')) {
    if (s.table.startsWith('rpc/')) {
      // live only when a capture that READ functions (v2) lists it; a v1 capture can't show one live
      if (!(Array.isArray(CAPTURE.functions) && CAPTURE.functions.includes(s.table.slice(4)))) judge(s, s.table, null, CAPTURE.functions ? `function ${s.table.slice(4)} is not live` : `function ${s.table.slice(4)}: the capture did not read functions (v1 query); re-capture with v2`);
      continue;
    }
    if (!LIVE[s.table]) {
      for (const c of s.cols.size ? s.cols : [null]) judge(s, s.table, c, c ? `${s.verb === 'names' ? 'names' : 'writes'} ${s.table}.${c} (table ${s.table} is not live)` : `table ${s.table} is not live`);
      continue;
    }
    for (const c of s.cols) if (!LIVE[s.table].includes(c)) judge(s, s.table, c, `${s.verb === 'names' ? 'names' : 'writes'} ${s.table}.${c}`);
  }
  for (const [n, cols] of [...pending].sort((a, b) => a[0] - b[0])) console.log(`PENDING on ${pad(n)} (declared in db/pending-migrations.json): ${[...cols].sort().join(', ')}`);
  for (const n of PENDING) if (!pending.has(n)) console.log(`PENDING on ${pad(n)}: declared, but nothing in the code needs it yet`);
  // whether this tree may go to main is check-push's decision (--before), not this test's: the runner gives every branch
  // CI's main-push environment, so a branch check here would make every gated branch red again
  assert.deepStrictEqual([...new Set(ahead)], [], 'code writes or names a column the live schema lacks and no declared-pending migration introduces: PostgREST refuses the whole request, a buy, a sale or a read');
});
})();

