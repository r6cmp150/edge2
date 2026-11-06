// tests/anon-write-paths.test.js — 2026-11-02, db/037; rewritten with db/037 2026-11-06. Originally: db/037 revokes anon
// UPDATE and DELETE on every table where nothing uses them. It is safe only
// while the only UPDATE/DELETE the app, scripts and workflows perform AS ANON
// is on portfolio, settings, and workflow_runs' status columns. This test is
// that prerequisite, made permanent: it enumerates every such write in the
// code and fails if one lands on a table db/037 revokes (which would break
// the morning after the migration, silently: the app logs and moves on).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSource, run, REPO_ROOT } = require('./_lib');

const ALLOWED = { portfolio: ['update', 'delete'], settings: ['update'], workflow_runs: ['update'] };
const list = (dir, re) => fs.readdirSync(path.join(REPO_ROOT, dir)).filter(f => re.test(f)).map(f => path.join(dir, f));
const strip = src => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

// supabase-js chains: from('<table>') ... .update( / .delete( / .upsert( within the same statement
function appWrites(file) {
  const src = strip(readSource(file));
  const out = [];
  // The chain's verb follows .from(...) closely, but the statement can be long
  // (an insert's object literal runs to thousands of characters), so no
  // terminator is required: read up to 300 chars, cut at the first ';'.
  for (const m of src.matchAll(/\.from\('([a-z_0-9]+)'\)/g)) {
    // to the end of the statement, brackets and strings balanced (chainVerbs, below: hoisted)
    for (const v of chainVerbs(src, m.index + m[0].length)) if (/^(update|delete|upsert)$/.test(v)) out.push({ file, table: m[1], verb: v === 'upsert' ? 'update' : v });
  }
  return out;
}
// REST calls in scripts made with the anon key: PATCH/DELETE, or an upsert that merges (needs UPDATE)
function scriptWrites(file) {
  const src = strip(readSource(file));
  const out = [];
  for (const m of src.matchAll(/fetch\(`\$\{[A-Z_0-9]+\}\/rest\/v1\/([a-z_0-9]+)[\s\S]{0,400}?\}\)/g)) {
    const call = m[0];
    const verb = /method:\s*'PATCH'/.test(call) ? 'update' : /method:\s*'DELETE'/.test(call) ? 'delete'
      : /resolution=merge-duplicates/.test(call) ? 'update' : null;
    if (!verb) continue;
    const asRole = /roleHeaders|OUTCOME_FILLER_JWT/.test(call); // outcome_filler, not anon
    out.push({ file, table: m[1], verb, asRole });
  }
  return out;
}
function workflowWrites(file) {
  const out = [];
  for (const m of readSource(file).matchAll(/curl[^\n]*-X (PATCH|DELETE) "[^"]*\/rest\/v1\/([a-z_0-9]+)/g)) out.push({ file, table: m[2], verb: m[1] === 'PATCH' ? 'update' : 'delete' });
  return out;
}

const writes = [
  ...['app.js', ...list('core', /\.js$/), ...list('shell', /\.js$/), ...list('engines/warrior', /\.js$/)].flatMap(appWrites),
  ...[...list('scripts', /\.(mjs|cjs|js)$/), ...list('scripts/lib', /\.mjs$/)].flatMap(scriptWrites).filter(w => !w.asRole),
  ...list('.github/workflows', /\.yml$/).flatMap(workflowWrites),
];
// The probe and the grant tests are deliberate negative tests, not app paths.
const EXEMPT = new Set(['scripts/probe-anon-privileges.mjs', 'scripts/test-db023-grants.mjs', 'scripts/test-db019-db021-grants.mjs']);

run('every UPDATE/DELETE performed as anon is on portfolio, settings or workflow_runs', () => {
  const found = writes.filter(w => !EXEMPT.has(w.file.replace(/\\/g, '/')));
  assert.ok(found.some(w => w.table === 'portfolio' && w.verb === 'delete'), 'the enumeration finds the known portfolio delete (else it finds nothing)');
  assert.ok(found.some(w => w.table === 'settings' && w.verb === 'update'));
  assert.ok(found.filter(w => w.table === 'workflow_runs').length >= 6, 'all six workflows\' status PATCH');
  const bad = found.filter(w => !(ALLOWED[w.table] || []).includes(w.verb));
  assert.deepStrictEqual(bad.map(w => `${w.file}: ${w.verb} ${w.table}`), [], 'an anon write on a table db/037 revokes');
});

// db/037 (rewritten 2026-11-06): REVOKE ALL, then grant back only what the enumerated paths use. Exact both ways.
const EDGE = ['analysis_periods', 'db_meta', 'portfolio', 'rating_snapshots', 'scan_runs', 'settings', 'setup_triggers', 'signal_log', 'signal_snapshot_at_buy', 'trades', 'trades_v2', 'workflow_runs'];
const appFiles = ['app.js', ...list('core', /\.js$/), ...list('shell', /\.js$/), ...list('engines/warrior', /\.js$/)];
const scriptFiles = [...list('scripts', /\.(mjs|cjs|js)$/), ...list('scripts/lib', /\.mjs$/)].filter(f => !EXEMPT.has(f.replace(/\\/g, '/')));
// The chain's top-level method calls, from just after .from('t') to the end of its statement: brackets and strings
// are balanced, so an object literal thousands of characters long can't hide a method that follows it.
function chainVerbs(src, from) {
  const verbs = [];
  let depth = 0, quote = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
    else if (depth === 0 && ch === ';') break;
    else if (depth === 0 && ch === '.') { const m = src.slice(i).match(/^\.([a-zA-Z]+)\(/); if (m) verbs.push(m[1]); }
  }
  return verbs;
}
function needed() {
  const need = new Map(); // table -> Set of privileges anon needs
  const add = (t, p) => { if (EDGE.includes(t)) (need.get(t) || need.set(t, new Set()).get(t)).add(p); };
  for (const f of appFiles) {
    const src = strip(readSource(f));
    for (const m of src.matchAll(/\.from\('([a-z_0-9]+)'\)/g)) {
      for (const v of chainVerbs(src, m.index + m[0].length)) if (/^(select|insert|update|delete|upsert)$/.test(v)) add(m[1], v === 'upsert' ? 'UPDATE' : v.toUpperCase());
    }
  }
  for (const f of scriptFiles) {
    const src = strip(readSource(f));
    for (const m of src.matchAll(/fetch\(`\$\{[A-Z_0-9]+\}\/rest\/v1\/([a-z_0-9]+)[\s\S]{0,400}?\}\)/g)) {
      if (/roleHeaders|OUTCOME_FILLER_JWT/.test(m[0])) continue; // outcome_filler, not anon
      const method = (m[0].match(/method:\s*'([A-Z]+)'/) || [, 'GET'])[1];
      add(m[1], { GET: 'SELECT', POST: 'INSERT', PATCH: 'UPDATE', DELETE: 'DELETE' }[method]);
      if (/resolution=merge-duplicates/.test(m[0])) add(m[1], 'UPDATE');
      if (/return=representation/.test(m[0])) add(m[1], 'SELECT');
    }
  }
  for (const f of list('.github/workflows', /\.yml$/)) {
    for (const m of readSource(f).matchAll(/curl[^\n]*-X (POST|PATCH|DELETE) "[^"]*\/rest\/v1\/([a-z_0-9]+)/g)) add(m[2], { POST: 'INSERT', PATCH: 'UPDATE', DELETE: 'DELETE' }[m[1]]);
    if (/rest\/v1\/workflow_runs/.test(readSource(f)) && /return=representation/.test(readSource(f))) add('workflow_runs', 'SELECT');
  }
  // the backup reads every table in its rules with the anon key
  for (const m of readSource('scripts/lib/backup-rules.mjs').matchAll(/^\s{2}([a-z_0-9]+)\(fresh, prior\)/gm)) add(m[1], 'SELECT');
  return need;
}
function granted() {
  const sql = readSource('db/037_interim_anon_hardening.sql').split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  const g = new Map();
  for (const m of sql.matchAll(/^grant ([a-z, ]+?)(?: \(([a-z_, ]+)\))? on ([a-z_0-9]+) to anon;$/gm)) {
    for (const p of m[1].split(',').map(s => s.trim().toUpperCase())) (g.get(m[3]) || g.set(m[3], new Set()).get(m[3])).add(m[2] ? `${p}(columns)` : p);
  }
  return { g, sql };
}

run('the chain parser reaches the longest real chain: the sale insert\'s .select(\'id\') thousands of characters on', () => {
  const src = strip(readSource('app.js'));
  const i = src.indexOf("supabaseClient.from('trades_v2').insert([{");
  assert.ok(i >= 0, 'the sale insert');
  const start = i + "supabaseClient.from('trades_v2')".length;
  const verbs = chainVerbs(src, start);
  assert.deepStrictEqual(verbs.slice(0, 2), ['insert', 'select'], `its chain: ${verbs}`);
  assert.ok(src.indexOf(".select('id')", start) - start > 3000, 'and the select really is thousands of characters on');
  assert.deepStrictEqual(chainVerbs("x.insert({ a: ')', b: [1, 2] }).select('id'); y.delete()", 1), ['insert', 'select'], 'strings and brackets balanced; stops at the statement');
});

run('db/037 revokes everything from anon and authenticated on all 12 tables, and grants nothing to authenticated', () => {
  const { sql } = granted();
  for (const t of EDGE) assert.ok(sql.includes(`revoke all on ${t} from anon, authenticated;`), t);
  assert.ok(!/ to authenticated;/.test(sql), 'authenticated gets nothing until the auth cutover');
  assert.ok(!/outcome_filler;/.test(sql.replace(/'[^']*'/g, '')), 'outcome_filler is not touched');
});

run('every privilege db/037 grants anon is used by an enumerated path, and every path is granted (exact both ways)', () => {
  const need = needed(), { g } = granted();
  assert.ok(need.get('portfolio')?.has('DELETE') && need.get('trades_v2')?.has('INSERT') && need.get('trades')?.has('SELECT'), 'the enumeration finds the known paths');
  const missing = [], unused = [];
  for (const [t, ps] of need) for (const p of ps) {
    const ok = g.get(t)?.has(p) || (t === 'workflow_runs' && (p === 'INSERT' || p === 'UPDATE') && g.get(t)?.has(`${p}(columns)`));
    if (!ok) missing.push(`${t} ${p}`);
  }
  for (const [t, ps] of g) for (const p of ps) if (!p.endsWith('(columns)') && !need.get(t)?.has(p)) unused.push(`${t} ${p}`);
  assert.deepStrictEqual(missing, [], 'a path anon uses that db/037 does not grant: it would break the morning after');
  assert.deepStrictEqual(unused, [], 'a grant db/037 gives anon that nothing uses');
  assert.ok(!g.has('db_meta'), 'db_meta: nothing');
});
