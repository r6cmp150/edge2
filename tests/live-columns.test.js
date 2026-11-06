// tests/live-columns.test.js — 2026-11-06. MAIN IS DEPLOYABLE AT EVERY COMMIT: pushing main deploys the app against
// the live database, so nothing on main may WRITE a column the live schema lacks (PostgREST refuses the whole insert
// over one unknown column, and the insert that fails is a buy or a sale). Every (table, column) the app, the scripts and
// the workflows write is enumerated from the code and checked against db/live-columns.json, which lists only columns a
// capture of the live database has shown.
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
const list = (dir, re) => fs.readdirSync(path.join(REPO_ROOT, dir)).filter(f => re.test(f)).map(f => `${dir}/${f}`);
// Comments out, everything else in place (newlines kept, so line numbers hold). A lexer, not a regex: "core/*.js" inside
// a // comment once opened a block comment that swallowed code up to a later "*/". Strings, template literals and
// regex literals (a "/" after an operator, a bracket or a keyword) are kept whole.
function strip(src) {
  let out = '', i = 0, prev = '';
  const regexAllowed = () => /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(return|typeof|case|in|of|void|throw)$/.test(prev) || prev === '';
  while (i < src.length) {
    const ch = src[i], nx = src[i + 1];
    if (ch === '/' && nx === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && nx === '*') { const e = src.indexOf('*/', i + 2); const body = src.slice(i, e < 0 ? src.length : e + 2); out += body.replace(/[^\n]/g, ''); i += body.length; continue; }
    if (ch === "'" || ch === '"' || ch === '`' || (ch === '/' && regexAllowed())) {
      let j = i + 1, cls = false;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === '\\') { j++; continue; }
        if (ch === '/') { if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break; else if (c === '\n') break; }
        else if (c === ch) break;
      }
      out += src.slice(i, j + 1); i = j + 1; prev = 'x'; continue;
    }
    out += ch;
    if (!/\s/.test(ch)) prev = (prev + ch).slice(-8);
    i++;
  }
  return out;
}

// The text of a balanced (), {} or [] starting at s[i], strings and template literals skipped.
function balanced(s, i) {
  const open = s[i], close = { '(': ')', '{': '}', '[': ']' }[open];
  let depth = 0, q = null;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { depth--; if (depth === 0) return s.slice(i, j + 1); }
  }
  return null;
}
// Top-level entries of an object literal's text: "key: value", "key" (shorthand), "...expr", "[computed]: value".
function entries(obj) {
  const body = obj.slice(1, -1), out = [];
  let depth = 0, q = null, start = 0;
  for (let j = 0; j <= body.length; j++) {
    const ch = body[j];
    if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
    if (ch && '([{'.includes(ch)) depth++;
    else if (ch && ')]}'.includes(ch)) depth--;
    else if ((ch === ',' && depth === 0) || j === body.length) { const e = body.slice(start, j).trim(); if (e) out.push(e); start = j + 1; }
  }
  return out;
}

// Resolves an expression to the set of columns it writes, or throws NotEnumerable naming why.
class NotEnumerable extends Error {}
function resolve(expr, src, at, ctx, depth = 0) {
  if (depth > 6) throw new NotEnumerable(`too deep: ${expr.slice(0, 40)}`);
  expr = expr.trim();
  if (expr.startsWith('[')) { const inner = balanced(expr, 0); return resolve(inner.slice(1, -1).trim(), src, at, ctx, depth + 1); }
  if (expr.startsWith('{')) return literal(balanced(expr, 0), src, at, ctx, depth);
  let m;
  if ((m = expr.match(/^([A-Za-z_$][\w$]*)\s*\(/))) return fnReturn(m[1], ctx, depth); // a builder call
  // x.map(r => ({ ... })), also at the end of a chain: x.filter(...).map(r => ({ ... })), up to the statement's end
  // the FIRST .map(x => ({ in this statement (a greedy prefix once matched a later .map in another statement)
  if (/^[\w$.]+/.test(expr) && (m = /\.map\(\s*\(?\s*[\w$]+\s*\)?\s*=>\s*\(\{/.exec(expr)) && !/;/.test(expr.slice(0, m.index))) {
    return literal(balanced(expr, m.index + m[0].length - 1), src, at, ctx, depth);
  }
  if ((m = expr.match(/^([A-Za-z_$][\w$]*)$/))) return identifier(m[1], src, at, ctx, depth);
  if (ctx.aliases[expr]) return resolveSite(ctx.aliases[expr], ctx, depth + 1);
  throw new NotEnumerable(`an expression the walker can't read: ${expr.slice(0, 50)}`);
}
function literal(obj, src, at, ctx, depth) {
  const cols = new Set();
  for (const e of entries(obj)) {
    if (e.startsWith('...')) { for (const c of resolve(e.slice(3), src, at, ctx, depth + 1)) cols.add(c); continue; }
    if (e.startsWith('[')) throw new NotEnumerable(`a computed key: ${e.slice(0, 40)}`);
    const k = e.match(/^['"]?([A-Za-z_$][\w$]*)['"]?\s*(:|$)/);
    if (!k) throw new NotEnumerable(`an entry the walker can't read: ${e.slice(0, 40)}`);
    cols.add(k[1]);
  }
  return cols;
}
// The nearest preceding assignment of a variable in this source; a parameter is traced to its callers.
// The text of the innermost block ({ ... }) enclosing position i.
function enclosingBlock(src, i) {
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    if (src[j] === '}') depth++;
    else if (src[j] === '{') { if (depth === 0) return { start: j, text: balanced(src, j) || src.slice(j) }; depth--; }
  }
  return { start: 0, text: src };
}
// Columns written onto an object by property assignment, within the block the variable lives in. A computed
// assignment (v[k] = ...) is a column the walker can't see.
function assigned(name, block) {
  const cols = [...block.matchAll(new RegExp(`\\b${name}\\.([a-z_]\\w*)\\s*=[^=]`, 'g'))].map(x => x[1]);
  // a computed key is enumerable only when it is a loop variable over a literal list, or a template on one
  for (const c of block.matchAll(new RegExp(`\\b${name}\\s*\\[([^\\]]+)\\]\\s*=[^=]`, 'g'))) {
    const key = c[1].trim();
    const v = key.match(/^([A-Za-z_$][\w$]*)$/) || key.match(/^`\$\{([A-Za-z_$][\w$]*)\}([\w]*)`$/);
    const values = v && loopValues(v[1], block);
    if (!values) throw new NotEnumerable(`${name}[${key}] = ...`);
    for (const x of values) cols.push(x + (v[2] || ''));
  }
  return cols;
}
// The values a loop variable takes, when the loop is over a literal in the same block:
// for (const [V, ..] of Object.entries(O)) / for (const V of Object.keys(O)) with const O = { k: .. }, or for (const V of ['a', 'b']).
function loopValues(v, block) {
  let m = block.match(new RegExp(`for\\s*\\(\\s*const\\s*(?:\\[\\s*${v}\\s*,[^\\]]*\\]|${v})\\s+of\\s+Object\\.(?:entries|keys)\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)`));
  if (m) {
    const o = block.match(new RegExp(`const\\s+${m[1]}\\s*=\\s*\\{`));
    if (!o) return null;
    return entries(balanced(block, o.index + o[0].length - 1)).map(e => (e.match(/^['"]?([A-Za-z_$][\w$]*)['"]?\s*:/) || [])[1]).filter(Boolean);
  }
  m = block.match(new RegExp(`for\\s*\\(\\s*const\\s+${v}\\s+of\\s+\\[([^\\]]*)\\]\\s*\\)`));
  if (m) return [...m[1].matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)].map(x => x[1]);
  return null;
}
// What was put into a collection C: C.set(k, X), C.push([k, X]) or C.push(X); and C = [...M.entries()] follows M.
function collected(coll, src, ctx, depth) {
  const from = src.match(new RegExp(`(?:const|let|var)\\s+${coll}\\s*=\\s*\\[\\s*\\.\\.\\.([A-Za-z_$][\\w$]*)\\.(?:entries|values)\\(\\)\\s*\\]`));
  if (from) return collected(from[1], src, ctx, depth + 1);
  const cols = new Set();
  let found = 0;
  for (const c of src.matchAll(new RegExp(`\\b${coll}\\.(set|push)\\(`, 'g'))) {
    const args = entries(`{${balanced(src, c.index + c[0].length - 1).slice(1, -1)}}`);
    let v = c[1] === 'set' ? args[1] : args[0];
    if (c[1] === 'push' && v && v.startsWith('[')) v = entries(`{${balanced(v, 0).slice(1, -1)}}`)[1];
    if (!v) continue;
    found++;
    if (/^\{\s*\}$/.test(v)) {
      // an empty object filled later: the function that set it returns it, and its callers assign properties
      const fn = [...src.slice(0, c.index).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].pop();
      if (!fn) throw new NotEnumerable(`${coll} holds {} filled somewhere the walker can't follow`);
      for (const d of src.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${fn[1]}\\(`, 'g'))) {
        for (const x of assigned(d[1], enclosingBlock(src, d.index).text)) cols.add(x);
      }
      continue;
    }
    for (const x of resolve(v, src, c.index, ctx, depth + 1)) cols.add(x);
  }
  if (!found) throw new NotEnumerable(`nothing is ever put into ${coll}`);
  return cols;
}
function identifier(name, src, at, ctx, depth) {
  const before = src.slice(0, at);
  // a loop variable: for (const [k, name] of C) / for (const name of C) -> what was put into C
  const loops = [...before.matchAll(new RegExp(`for\\s*\\(\\s*(?:const|let)\\s+(?:\\[[^\\]]*\\b${name}\\b[^\\]]*\\]|${name})\\s+of\\s+([A-Za-z_$][\\w$]*)\\s*\\)`, 'g'))];
  // the LATEST assignment before the write: a declaration, or a plain re-assignment (let rows = null; ... rows = x.map(..))
  const decls = [...before.matchAll(new RegExp(`(?:(?:const|let|var)\\s+|(?<![\\w$.]))${name}\\s*=(?![=>])\\s*`, 'g'))]
    .filter(d => !/^\s*(null|undefined)\s*;/.test(src.slice(d.index + d[0].length, d.index + d[0].length + 12)));
  const loop = loops[loops.length - 1], decl = decls[decls.length - 1];
  if (loop && (!decl || loop.index > decl.index)) return collected(loop[1], src, ctx, depth);
  if (decl) {
    const rhsAt = decl.index + decl[0].length;
    const rhs = src.slice(rhsAt, rhsAt + 4000);
    // an object built by property assignment within its own block: v = {} / v = f(..), then v.col = ...
    if (/^(\{\s*\}|[A-Za-z_$][\w$]*\([^)]*\))\s*;/.test(rhs)) {
      const block = enclosingBlock(src, decl.index).text;
      const cols = assigned(name, block);
      if (cols.length || /^\{\s*\}/.test(rhs)) return new Set(cols);
    }
    return resolve(rhs, src, rhsAt, ctx, depth + 1);
  }
  // a parameter of the enclosing function: resolve what every caller passes
  const fn = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)].pop();
  if (fn && fn[2].split(',').map(s => s.trim()).includes(name)) {
    const pos = fn[2].split(',').map(s => s.trim()).indexOf(name);
    const cols = new Set();
    let callers = 0;
    for (const [file, s] of ctx.sources) {
      for (const c of s.matchAll(new RegExp(`\\b${fn[1]}\\(`, 'g'))) {
        if (/function\s+$/.test(s.slice(Math.max(0, c.index - 9), c.index))) continue;
        const args = balanced(s, c.index + c[0].length - 1);
        const arg = entries(`{${args.slice(1, -1)}}`)[pos];
        if (!arg) continue;
        callers++;
        for (const x of resolve(arg, s, c.index, { ...ctx, file }, depth + 1)) cols.add(x);
      }
    }
    if (!callers) throw new NotEnumerable(`parameter ${name} of ${fn[1]}: no caller found`);
    return cols;
  }
  throw new NotEnumerable(`no assignment of ${name} before the write`);
}
function fnReturn(name, ctx, depth) {
  for (const [, s] of ctx.sources) {
    const m = s.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`));
    if (!m) continue;
    const body = balanced(s, m.index + m[0].length - 1);
    const r = body.match(/\breturn\s*\{/);
    if (!r) throw new NotEnumerable(`${name}() does not return an object literal`);
    return literal(balanced(body, r.index + r[0].length - 1), s, m.index, ctx, depth + 1);
  }
  throw new NotEnumerable(`no function ${name}() found`);
}

// The write sites.
function sites() {
  const appFiles = ['app.js', ...list('core', /\.js$/), ...list('shell', /\.js$/), ...list('engines/warrior', /\.js$/)];
  const scriptFiles = [...list('scripts', /\.mjs$/), ...list('scripts/lib', /\.mjs$/)].filter(f => !/scripts\/(test-|probe-)/.test(f));
  const sources = new Map([...appFiles, ...scriptFiles].map(f => [f, strip(readSource(f))]));
  const out = [];
  for (const f of appFiles) {
    const s = sources.get(f);
    for (const m of s.matchAll(/\.from\('([a-z_0-9]+)'\)\s*\.(insert|update|upsert)\(/g)) {
      const arg = balanced(s, m.index + m[0].length - 1);
      out.push({ where: `${f}:${s.slice(0, m.index).split('\n').length}`, file: f, table: m[1], verb: m[2], expr: arg.slice(1, -1), at: m.index });
    }
  }
  for (const f of scriptFiles) {
    const s = sources.get(f);
    // rest/v1/rpc/<fn> is a FUNCTION call, named as such: it is live only once its migration has run
    for (const m of s.matchAll(/fetch\(`\$\{[A-Z_0-9]+\}\/rest\/v1\/((?:rpc\/)?[a-z_0-9]+)/g)) {
      const call = balanced(s, m.index + 5);
      if (!call || !/method:\s*'(POST|PATCH|PUT)'/.test(call)) continue;
      const body = call.match(/body:\s*JSON\.stringify\(/);
      if (!body) { out.push({ where: `${f}:${s.slice(0, m.index).split('\n').length}`, file: f, table: m[1], verb: 'write', expr: '(no JSON body)', at: m.index }); continue; }
      const arg = balanced(call, body.index + body[0].length - 1);
      out.push({ where: `${f}:${s.slice(0, m.index).split('\n').length}`, file: f, table: m[1], verb: /'PATCH'/.test(call) ? 'update' : 'insert', expr: arg.slice(1, -1), at: m.index });
    }
  }
  // workflows: curl POST/PATCH to rest/v1/<table>, body inline (-d "{\"col\": ...}") or a $VAR set earlier in the file
  for (const f of list('.github/workflows', /\.yml$/)) {
    const y = readSource(f);
    for (const m of y.matchAll(/curl[^\n]*-X (POST|PATCH) "[^"]*\/rest\/v1\/([a-z_0-9]+)[\s\S]*?-d "([^\n]*)"/g)) {
      let d = m[3];
      const v = d.match(/^\$\{?([A-Z_]+)\}?$/);
      if (v) { const set = [...y.slice(0, m.index).matchAll(new RegExp(`${v[1]}="([^\\n]*)"`, 'g'))].pop(); d = set ? set[1] : null; }
      out.push({ where: `${f}:${y.slice(0, m.index).split('\n').length}`, file: f, table: m[2], verb: m[1] === 'PATCH' ? 'update' : 'insert', workflowBody: d });
    }
  }
  return { out, sources };
}
// A retry writes the object its first attempt built, so its columns are that object's. Each alias names the first
// attempt's call and the variable it passed; if either disappears, the alias fails rather than passing.
//   b.rows  the rating-snapshot retry (app.js): a batch the first write stored on failure
//   f.row   the signal_snapshot_at_buy retry (app.js): the row the first insert stored on failure
const ALIASES = {
  'b.rows': { file: 'app.js', marker: ".from('rating_snapshots').insert(rows)", name: 'rows' },
  'f.row': { file: 'app.js', marker: 'return insertSignalSnapshotAtBuy(row)', name: 'row' },
};
function resolveSite(alias, ctx, depth) {
  const s = ctx.sources.get(alias.file), i = s.indexOf(alias.marker);
  if (i < 0) throw new NotEnumerable(`alias: the first attempt "${alias.marker}" is not in ${alias.file}`);
  return identifier(alias.name, s, i, { ...ctx, file: alias.file }, depth + 1);
}
function enumerate() {
  const { out, sources } = sites();
  return out.map(site => {
    try {
      if ('workflowBody' in site) {
        if (site.workflowBody == null) throw new NotEnumerable('the body variable is never set');
        const cols = [...site.workflowBody.matchAll(/\\"([a-z_]\w*)\\"\s*:/g)].map(x => x[1]);
        if (!cols.length) throw new NotEnumerable(`no "column": in the body ${site.workflowBody.slice(0, 40)}`);
        return { ...site, state: 'ENUMERATED', cols: new Set(cols) };
      }
      return { ...site, state: 'ENUMERATED', cols: resolve(site.expr, sources.get(site.file), site.at, { sources, aliases: ALIASES, file: site.file }) };
    } catch (e) {
      if (!(e instanceof NotEnumerable)) throw e;
      return { ...site, state: 'NOT ENUMERABLE', why: e.message };
    }
  });
}

(async () => {
await run('the walker: literals, builders, spreads, .map, property assignment and parameters resolve; a computed key does not', () => {
  const ctx = src => ({ sources: new Map([['x.js', src]]), aliases: {}, file: 'x.js' });
  const r = (src, expr) => [...resolve(expr, src, src.length, ctx(src))].sort();
  assert.deepStrictEqual(r('', "{ a: 1, b, 'c': f(x, { d: 2 }) }"), ['a', 'b', 'c'], 'nested braces are not keys');
  assert.deepStrictEqual(r('function mk(p) { return { x: p.x, y: 1 }; }', '{ ...mk(p), z: 1 }'), ['x', 'y', 'z']);
  assert.deepStrictEqual(r('const rows = list.map(s => ({ t: s.t, u: "a,b" }));', 'rows'), ['t', 'u'], 'commas in strings');
  assert.deepStrictEqual(r('const p = patchFor(id);\np.ret_5m = 1;\nif (q) p.ret_1d = 2; if (p.ret_5m == null) {}', 'p'), ['ret_1d', 'ret_5m'], '== is a read, not a write');
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

await run('MAIN IS DEPLOYABLE: every column anything writes exists live (db/live-columns.json)', () => {
  const ahead = [];
  for (const s of enumerate().filter(s => s.state === 'ENUMERATED')) {
    if (!LIVE[s.table]) { ahead.push(`${s.where}: ${s.table.startsWith('rpc/') ? `function ${s.table.slice(4)}` : `table ${s.table}`} is not live`); continue; }
    for (const c of s.cols) if (!LIVE[s.table].includes(c)) ahead.push(`${s.where}: ${s.table}.${c}`);
  }
  assert.deepStrictEqual(ahead, [], 'code writes a column the live schema lacks: the insert would fail on a live buy or sale');
});
})();

