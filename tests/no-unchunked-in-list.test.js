// tests/no-unchunked-in-list.test.js — 2026-11-01. Fill outcomes failed five
// evenings because a re-select put every touched id in one PostgREST URL,
// `?id=in.(<all ids>)`: measured, 371 ids answers and 400 fails
// (UND_ERR_HEADERS_OVERFLOW). The list grows with data volume (452 to 597
// ids in four days), so the failure returns the moment anything else builds
// an in-list from an array. Every such list goes through
// scripts/lib/select-by-ids.mjs, which chunks it; this fails on any other.
// Same shape as the sw.js cache-name guard: a fact about the whole repo.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { run } = require('./_lib');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED = new Set([path.join('scripts', 'lib', 'select-by-ids.mjs')]);
// App code's ONE in-list (2026-11-12, accepted by the reviewer with three conditions): allowed by FUNCTION, never by
// file, so another .in( in core/store.js still fails. The function must chunk, page through readAllRows, and have
// its rows checked against the count (readAllRows does); the tests below hold all three.
const ALLOWED_FUNCTIONS = { [path.join('core', 'store.js')]: ['selectRatingSnapshotsByTickers'] };
function insideAllowedFunction(file, src, lineIndex) {
  const names = ALLOWED_FUNCTIONS[file];
  if (!names) return false;
  const at = src.split('\n').slice(0, lineIndex).join('\n').length;
  return names.some(n => {
    const i = src.search(new RegExp(`^async function ${n}\\(`, 'm'));
    return i >= 0 && at > i && at < src.indexOf('\n}\n', i);
  });
}
// An interpolated PostgREST in-list (`in.(${...})`), or supabase-js's
// .in('col', array), which builds the same URL.
const PATTERNS = [/in\.\(\$\{/, /\.in\(\s*['"`]/];

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...files(rel)); }
    else if (/\.(m|c)?js$/.test(e.name)) out.push(rel);
  }
  return out;
}

function offenders() {
  const all = ['app.js', ...['scripts', 'core', 'shell', 'engines'].filter(d => fs.existsSync(path.join(ROOT, d))).flatMap(files)];
  const hits = [];
  for (const f of all) {
    if (ALLOWED.has(f)) continue;
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (PATTERNS.some(p => p.test(line)) && !insideAllowedFunction(f, src, i)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  return hits;
}

run('no in-list built from an array outside the chunked helper', () => {
  const hits = offenders();
  assert.deepStrictEqual(hits, [], `use selectByIds (scripts/lib/select-by-ids.mjs):\n${hits.join('\n')}`);
});

run('the helper itself still chunks, at a size well under the measured ceiling', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'select-by-ids.mjs'), 'utf8');
  const n = Number(src.match(/export const SELECT_BY_IDS_CHUNK = (\d+);/)[1]);
  assert.ok(n > 0 && n <= 200, `chunk ${n}: 371 ids was the largest list measured to work`);
  assert.ok(/ids\.slice\(i, i \+ SELECT_BY_IDS_CHUNK\)/.test(src));
});

// The app's allowed helper, held to the three conditions it was allowed on (2026-11-12).
run('selectRatingSnapshotsByTickers: chunks, pages through readAllRows, and a short read is an error, not partial rows', async () => {
  const store = fs.readFileSync(path.join(ROOT, 'core', 'store.js'), 'utf8');
  const fnSrc = n => { const i = store.search(new RegExp(`^(async )?function ${n}\\(`, 'm')); return store.slice(i, store.indexOf('\n}\n', i) + 2); };
  const n = Number(store.match(/const TICKER_IN_CHUNK = (\d+);/)[1]);
  assert.ok(n > 0 && n <= 200, `chunk ${n}: 371 ids was the largest list measured to work`);
  assert.ok(/readAllRows\(\(\) => supabaseClient\.from\('rating_snapshots'\)/.test(fnSrc('selectRatingSnapshotsByTickers')), 'paged by readAllRows');
  const queries = [];
  const client = rowsFor => ({ from: table => {
    const q = { table, ops: [] }; queries.push(q);
    const b = {};
    for (const m of ['select', 'in', 'order']) b[m] = (...a) => { q.ops.push([m, ...a]); return b; };
    b.range = (lo, hi) => { q.ops.push(['range', lo, hi]); return b; };
    b.then = (res, rej) => Promise.resolve(rowsFor(q)).then(res, rej);
    return b;
  } });
  // eslint-disable-next-line no-eval
  eval(store.match(/^const READ_PAGE_SIZE = .*$/m)[0] + '\n' + store.match(/^const TICKER_IN_CHUNK = .*$/m)[0] + '\n' + fnSrc('readAllRows') + fnSrc('selectRatingSnapshotsByTickers')
    + '\nglobal.__sel = selectRatingSnapshotsByTickers;');
  const tickers = Array.from({ length: 250 }, (_, i) => `T${i}`);
  global.supabaseClient = client(q => { const chunk = q.ops.find(o => o[0] === 'in')[2]; return { data: chunk.map((t, i) => ({ id: `${t}-${i}`, ticker: t })), error: null, count: chunk.length }; });
  const ok = await global.__sel([...tickers, 'T0']);
  const ins = queries.map(q => q.ops.find(o => o[0] === 'in')[2]);
  assert.deepStrictEqual(ins.map(c => c.length), [100, 100, 50], 'chunked, each well under the ceiling, duplicates read once');
  assert.ok(ins.every(c => c.length <= n));
  assert.strictEqual(ok.data.length, 250);
  queries.length = 0;
  global.supabaseClient = client(q => ({ data: [{ id: 1, ticker: 'T0' }], error: null, count: 2 }));
  const short = await global.__sel(['T0']);
  assert.ok(short.data === null && /read 1 rows of 2/.test(short.error.message), 'a short read is an error, never partial rows');
});
