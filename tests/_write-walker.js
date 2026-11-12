// tests/_write-walker.js -- 2026-11-11. The write-site and name walker, moved VERBATIM out of tests/live-columns.test.js
// so tests/enumerated-values.test.js uses the same code rather than a copy (spec 7.7: the same logic in two places
// drifts). Not a test file (the leading underscore). See live-columns.test.js's header for what it does and why.
//
// COVERAGE (2026-11-11; keep this list true when the walker changes). Three outcomes for any database access: RESOLVED
// (its columns read), NOT ENUMERABLE (seen, could not be read: fails loudly), and NEVER SEEN (passes in silence). Only the
// first two show in any report, so what follows is the record of the third.
//
// FILES SCANNED: app.js, core/*.js, shell/*.js, engines/warrior/*.js; scripts/*.mjs and scripts/lib/*.mjs EXCEPT
// scripts/test-* and scripts/probe-*; .github/workflows/*.yml.
// FILES NEVER SEEN: scripts/test-* and scripts/probe-* (hand-run probes; fill-outcomes.yml can run
// scripts/test-db019-db021-grants.mjs, which PATCHes production), any *.cjs, sw.js, engines/edge (no files today),
// index.html inline scripts, anything under tests/ and data/.
//
// WRITES recognised:
//   app files: supabaseClient-style `.from('<literal table>')` then (whitespace allowed) `.insert(` / `.update(` /
//     `.upsert(`; the payload resolved through literals, builder functions (fnReturn: every return branch, held by the
//     branch invariant below), spreads, `.map(x => ({..}))`,
//     identifiers to their declaration or a loop over a literal list, parameters to their callers (W.callsOf: same file
//     or an importing file), the ALIASES retries, and a Map/array of objects filled by `.set`/`.push`, including
//     properties assigned on a variable holding a builder's result (p.col = ..) and on the call itself (fn(..).col = ..).
//   scripts: fetch(`${UPPER_CASE_NAME}/rest/v1/<literal table or rpc/fn>...`, { method: 'POST' | 'PATCH' | 'PUT', ...,
//     body: JSON.stringify(<payload>) }), the payload resolved as above.
//   workflows: curl ... -X POST | PATCH "...rest/v1/<table>" ... -d "<one-line JSON>" or -d "$VAR" set earlier in the file.
// WRITES NOT recognised (NEVER SEEN): `.from(<non-literal>)` writes (the names half reports these NOT ENUMERABLE);
//   `.delete(` (a delete names filters, read by the names half, but is not a write site); `.rpc(` calls from app files;
//   fetch with a base URL not written `${UPPER_CASE}` (baseUrl, supabaseUrl) or via a wrapper (fetchImpl) for a WRITE;
//   method DELETE; a body that is not JSON.stringify(..); curl `--request`, DELETE, `--data @file`, or a -d spanning lines;
//   a callers search across files that share globals without importing (app.js -> core/*.js) -- tests/enumerated-values
//   adds that for values only.
// NAMES recognised: `.from('<literal>')` chains (select lists, filters, order, on_conflict), `/rest/v1/` inside a string
//   or template literal (helpers with a parameterised table read through their callers, "called from ..."),
//   backup-tables.mjs through its BACKUP model, workflow URLs. Not recognised: a URL built outside a literal on its line
//   (reported NOT ENUMERABLE), and the files never seen above.
//
// The independent check on this list is a deliberately dumb count of database syntax (.insert/.update/.upsert/.delete/
// .rpc, /rest/v1/, curl -X) compared with these sites: see STATUS.md, "walker coverage".
//
// WHICH INSTRUMENT ANSWERS WHICH QUESTION (2026-11-12). The count checks SITES: is every place that writes found? It is
// blind inside a site it already matched. The BRANCH INVARIANT (fnReturn) checks branches WITHIN a site: a builder's
// returns read must equal the `return`s its body contains, counted independently (returnTokens), or it fails; a builder
// holding a nested function is NOT ENUMERABLE. Found by the enumerated-value guard asking for declarations that weren't
// there (a builder read only to its first `return {`, 2026-11-12), not by the count, which could not have found it.
// Neither checks a value's text against the code's intent: the enumerated-value guard checks values against the CHECKs.
'use strict';
const fs = require('fs');
const path = require('path');
const { readSource, REPO_ROOT } = require('./_lib');
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
    // 2026-11-11, for tests/enumerated-values.test.js: report the entry's value text (the key itself for a shorthand
    // entry) and where it was read. Absent ctx.onEntry, nothing changes.
    if (ctx.onEntry) ctx.onEntry(k[1], k[2] === ':' ? e.slice(e.indexOf(':') + 1).trim() : k[1], src, at, ctx);
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
      // and properties assigned on the call's result directly: patchFor(row.id).taken_resolution = ... (2026-11-11:
      // fill-outcomes.mjs writes taken_resolution and matched_trade_id this way, and neither was enumerated)
      for (const d of src.matchAll(new RegExp(`(?<![\\w$.])${fn[1]}\\(`, 'g'))) {
        const call = balanced(src, d.index + d[0].length - 1);
        const after = src.slice(d.index + d[0].length - 1 + call.length);
        const m = after.match(/^\s*\.([a-z_]\w*)\s*=[^=]/);
        if (m) cols.add(m[1]);
        else if (/^\s*\[/.test(after) && /^\s*\[[^\]]*\]\s*=[^=]/.test(after)) throw new NotEnumerable(`${fn[1]}(...)[...] = ...`);
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
// Every builder fnReturn resolved, with { read, contains }: the branch invariant's two numbers, for any report to print.
const BRANCHES = new Map();
// The `return` keywords in a body, and whether it holds a nested function (`function` or `=>`), counted outside string
// and template literals, by its own scan rather than by the regex that reads the branches. (Comments are already gone:
// sources() strips them.) A regex literal holding the word return would count: that fails loudly, never silently.
function returnTokens(body) {
  let returns = 0, nested = false, q = null;
  for (let j = 0; j < body.length; j++) {
    const ch = body[j];
    if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === '`') { const e = templateEnd(body, j); if (e < 0) break; j = e; continue; }
    if (/[A-Za-z_$]/.test(ch) && !/[\w$]/.test(body[j - 1] || '')) {
      const w = body.slice(j).match(/^[A-Za-z_$][\w$]*/)[0];
      if (w === 'return') returns++;
      if (w === 'function') nested = true;
      j += w.length - 1;
      continue;
    }
    if (ch === '=' && body[j + 1] === '>') nested = true;
  }
  return { returns, nested };
}
function fnReturn(name, ctx, depth) {
  for (const [, s] of ctx.sources) {
    const m = s.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`));
    if (!m) continue;
    // EVERY return in the builder's body (2026-11-12; it read only the first `return {`, so a builder with a return per
    // branch had every later branch's columns and values unseen). Each must be an object literal: a builder that can
    // return anything else is NOT ENUMERABLE. A builder holding a nested function is NOT ENUMERABLE too: its returns and
    // the nested function's can't be told apart here.
    // THE BRANCH INVARIANT: the branches read must equal the `return`s the body contains, counted independently
    // (returnTokens: outside strings, templates and regexes), and a difference fails. The independent count of sites
    // cannot see this class (a missed branch is inside a site it already matched); this check can.
    const open = m.index + m[0].length - 1, body = balanced(s, open), cols = new Set();
    const lexed = returnTokens(body);
    if (lexed.nested) throw new NotEnumerable(`${name}() holds a nested function: its returns can't be told from the builder's`);
    let read = 0;
    for (const r of body.matchAll(/\breturn\s*\{/g)) {
      read++;
      for (const c of literal(balanced(body, r.index + r[0].length - 1), s, m.index, ctx, depth + 1)) cols.add(c);
    }
    BRANCHES.set(name, { read, contains: lexed.returns });
    if (read !== lexed.returns) throw new NotEnumerable(`${name}(): read ${read} of the ${lexed.returns} return branch(es) its body contains (a return that is not an object literal, or one the reader missed)`);
    if (!read) throw new NotEnumerable(`${name}() does not return an object literal`);
    return cols;
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
// onEntry (2026-11-11, optional): called as onEntry(site, column, valueText, src, at, ctx) for every payload entry read.
function enumerate(onEntry = null) {
  const { out, sources } = sites();
  return out.map(site => {
    try {
      if ('workflowBody' in site) {
        if (site.workflowBody == null) throw new NotEnumerable('the body variable is never set');
        const cols = [...site.workflowBody.matchAll(/\\"([a-z_]\w*)\\"\s*:/g)].map(x => x[1]);
        if (!cols.length) throw new NotEnumerable(`no "column": in the body ${site.workflowBody.slice(0, 40)}`);
        return { ...site, state: 'ENUMERATED', cols: new Set(cols) };
      }
      return { ...site, state: 'ENUMERATED', cols: resolve(site.expr, sources.get(site.file), site.at, { sources, aliases: ALIASES, file: site.file, ...(onEntry ? { onEntry: (...a) => onEntry(site, ...a) } : {}) }) };
    } catch (e) {
      if (!(e instanceof NotEnumerable)) throw e;
      return { ...site, state: 'NOT ENUMERABLE', why: e.message };
    }
  });
}

// ===== NAMES (2026-11-06). PostgREST refuses a request that NAMES an unknown column anywhere, not only in a payload:
// .select('a'), .eq('a', ..), .order('a'), ?a=eq.1, ?order=a.asc, ?or=(a.is.null), ?on_conflict=a. So the invariant is
// that main never NAMES a column the live schema lacks. The same three states as the writes.
const HOLE = '\u0002'; // an interpolation the walker can't resolve: harmless in a value, NOT ENUMERABLE in a column or table
const shown = s => s.replace(new RegExp(HOLE, 'g'), '${?}').slice(0, 60);
function splitTop(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let j = 0; j <= s.length; j++) {
    const ch = s[j];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if ((ch === ',' && depth === 0) || j === s.length) { out.push(s.slice(start, j).trim()); start = j + 1; }
  }
  return out.filter(Boolean);
}
function column(c, what) {
  if (!/^[a-z_][a-z_0-9]*$/.test(c)) throw new NotEnumerable(`${what}: a column the walker can't read: ${shown(c)}`);
  return c;
}
// "a, b:c, d::text, e->>f, *". An embedded resource rel(..) names another table: the walker doesn't follow it.
function selectList(s) {
  return splitTop(s).filter(i => i !== '*').map(i => {
    if (i.includes('(')) throw new NotEnumerable(`an embedded resource in a select: ${shown(i)}`);
    return column(i.replace(/^[A-Za-z_]\w*:(?!:)/, '').replace(/::\w+$/, '').replace(/->>?.*$/, ''), 'select');
  });
}
// "(a.is.null,b.eq.1,and(c.gt.2,d.is.null))": each condition's column is what precedes its operator.
function logicTree(s) {
  if (!/^\([\s\S]*\)$/.test(s)) throw new NotEnumerable(`a logic filter the walker can't read: ${shown(s)}`);
  return splitTop(s.slice(1, -1)).flatMap(c => {
    const nested = c.match(/^(?:not\.)?(?:and|or)(\([\s\S]*\))$/);
    return nested ? logicTree(nested[1]) : [column(c.split('.')[0], 'or/and')];
  });
}
// The columns a query string names. limit and offset name none; every other key is a column filter.
function queryNames(q) {
  const out = [];
  for (const p of q.split('&').filter(Boolean)) {
    const eq = p.indexOf('=');
    if (eq < 0) throw new NotEnumerable(`a query part the walker can't read: ${shown(p)}`);
    const k = p.slice(0, eq), v = p.slice(eq + 1);
    if (k === 'select') out.push(...selectList(v));
    else if (k === 'order') out.push(...splitTop(v).map(o => column(o.split('.')[0], 'order')));
    else if (k === 'on_conflict' || k === 'columns') out.push(...v.split(',').map(c => column(c.trim(), k)));
    else if (/^(not\.)?(or|and)$/.test(k)) out.push(...logicTree(v));
    else if (k !== 'limit' && k !== 'offset') out.push(column(k, 'filter'));
  }
  return out;
}

// The end of the template literal opening at t[i] (a backtick), interpolations skipped whole.
function templateEnd(t, i) {
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === '\\') { j++; continue; }
    if (t[j] === '$' && t[j + 1] === '{') { const b = balanced(t, j + 1); if (!b) return -1; j += b.length; continue; }
    if (t[j] === '`') return j;
  }
  return -1;
}
// a ? b : c at the top level -> [a, b, c]
function ternary(expr) {
  let depth = 0, q = null, qAt = -1, nest = 0;
  for (let j = 0; j < expr.length; j++) {
    const ch = expr[j];
    if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === '`') { j = templateEnd(expr, j); if (j < 0) return null; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0 && ch === '?' && !'.?'.includes(expr[j + 1]) && expr[j - 1] !== '?') { if (qAt < 0) qAt = j; else nest++; }
    else if (depth === 0 && ch === ':' && qAt >= 0) { if (nest) nest--; else return [expr.slice(0, qAt), expr.slice(qAt + 1, j), expr.slice(j + 1)]; }
  }
  return null;
}
// The rest of the statement starting at src[i]: up to the first ; or newline-ended line at depth 0.
function statementAt(src, i) {
  let depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === '`') { j = templateEnd(src, j); if (j < 0) return src.slice(i); continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) return src.slice(i, j); depth--; }
    else if (depth === 0 && (ch === ';' || (ch === '\n' && !/^\s*[.?:+]/.test(src.slice(j + 1, j + 40)) && !/[=,(+?:]\s*$/.test(src.slice(i, j))))) return src.slice(i, j);
  }
  return src.slice(i);
}
// The function whose body contains position i: { name, params: [{ name, dflt }], start, end }.
function enclosingFunction(src, i) {
  let found = null;
  for (const m of src.slice(0, i).matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const params = balanced(src, m.index + m[0].length - 1);
    const open = src.indexOf('{', m.index + m[0].length - 1 + params.length);
    const body = balanced(src, open);
    if (body && open + body.length > i) {
      found = { name: m[1], start: open, end: open + body.length, params: entries(`{${params.slice(1, -1)}}`).map(p => { const d = p.match(/^([A-Za-z_$][\w$]*)\s*(?:=\s*([\s\S]+))?$/); return d ? { name: d[1], dflt: d[2] } : { name: null }; }) };
    }
  }
  return found;
}
// Calls of a function, in its own file and in files that import it by name: [{ file, src, at, args }].
function callsOf(fn, file, ctx) {
  const base = path.basename(file);
  const out = [];
  for (const [f, s] of ctx.sources) {
    if (f !== file && !new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*'[^']*/${base.replace('.', '\\.')}'`).test(s)) continue;
    for (const c of s.matchAll(new RegExp(`(?<![\\w$.])${fn}\\(`, 'g'))) {
      if (/function\s+$/.test(s.slice(Math.max(0, c.index - 9), c.index))) continue;
      out.push({ file: f, src: s, at: c.index, args: entries(`{${balanced(s, c.index + c[0].length - 1).slice(1, -1)}}`) });
    }
  }
  return out;
}
// An identifier's value, by `how` (strings or array): a parameter bound to one caller's argument, a declaration before
// it, a loop over a literal list, or an unbound parameter (every caller's argument).
function named(name, src, at, ctx, depth, how) {
  const b = ctx.bind;
  if (b && b.file === ctx.file && at >= b.start && at < b.end && name in b.args) {
    const a = b.args[name];
    if (!a) throw new NotEnumerable(`parameter ${name}: the caller passes nothing`);
    return how(a.expr, a.src, a.at, { ...ctx, file: a.file, bind: null }, depth + 1);
  }
  const before = src.slice(0, at);
  const decl = [...before.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\s*=(?![=>])\\s*`, 'g'))].pop();
  const loop = [...before.matchAll(new RegExp(`for\\s*\\(\\s*const\\s+${name}\\s+of\\s+(\\[[^\\]]*\\])\\s*\\)`, 'g'))].pop();
  if (loop && (!decl || loop.index > decl.index)) return array(loop[1], src, loop.index, ctx, depth + 1);
  if (decl) return how(statementAt(src, decl.index + decl[0].length), src, decl.index, ctx, depth + 1);
  const fn = enclosingFunction(src, at);
  const p = fn && fn.params.find(x => x.name === name);
  if (p) {
    const out = [];
    for (const c of callsOf(fn.name, ctx.file, ctx)) out.push(...how(c.args[fn.params.indexOf(p)] ?? p.dflt ?? 'undefined', c.args[fn.params.indexOf(p)] ? c.src : src, c.at, { ...ctx, file: c.file, bind: null }, depth + 1));
    if (!out.length) throw new NotEnumerable(`parameter ${name} of ${fn.name}: no caller found`);
    return [...new Set(out)];
  }
  throw new NotEnumerable(`no value for ${name}`);
}
// The values a string expression can take.
function strings(expr, src, at, ctx, depth = 0) {
  if (depth > 10) throw new NotEnumerable(`too deep: ${expr.slice(0, 40)}`);
  expr = expr.trim();
  let m;
  if ((m = expr.match(/^'([^'\\]*)'$/) || expr.match(/^"([^"\\]*)"$/))) return [m[1]];
  if (expr.startsWith('`') && templateEnd(expr, 0) === expr.length - 1) return template(expr, src, at, ctx, depth, false);
  const t = ternary(expr);
  if (t) return [...new Set([...strings(t[1], src, at, ctx, depth + 1), ...strings(t[2], src, at, ctx, depth + 1)])];
  if ((m = expr.match(/^([\s\S]+)\.join\(\s*'([^']*)'\s*\)$/))) return [array(m[1], src, at, ctx, depth + 1).join(m[2])];
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) return named(expr, src, at, ctx, depth, strings);
  throw new NotEnumerable(`a string the walker can't read: ${expr.slice(0, 50)}`);
}
// The strings an array expression holds (the union, where it depends on a condition).
function array(expr, src, at, ctx, depth = 0) {
  if (depth > 10) throw new NotEnumerable(`too deep: ${expr.slice(0, 40)}`);
  expr = expr.trim();
  let m;
  if (expr.startsWith('[') && balanced(expr, 0) === expr) {
    return [...new Set(entries(`{${expr.slice(1, -1)}}`).flatMap(e => {
      const s = e.match(/^\.\.\.new Set\(([\s\S]*)\)$/);
      return s ? array(s[1], src, at, ctx, depth + 1) : e.startsWith('...') ? array(e.slice(3), src, at, ctx, depth + 1) : strings(e, src, at, ctx, depth + 1);
    }))];
  }
  // X.flatMap(([, p]) => Object.keys(p)), X = [...M.entries()] (filtered or not): the keys of what was put into M
  if ((m = expr.match(/^([A-Za-z_$][\w$]*)\.flatMap\(\(\[\s*,\s*([\w$]+)\s*\]\)\s*=>\s*Object\.keys\(\2\)\)$/))) {
    const d = src.slice(0, at).match(new RegExp(`(?:const|let)\\s+${m[1]}\\s*=\\s*\\[\\s*\\.\\.\\.([A-Za-z_$][\\w$]*)\\.entries\\(\\)\\s*\\]`));
    if (!d) throw new NotEnumerable(`${m[1]} is not the entries of a collection`);
    return [...collected(d[1], src, { aliases: {}, ...ctx }, 0)];
  }
  if ((m = expr.match(/^Object\.keys\(([\s\S]*?)(\[0\])?\)$/))) return [...resolve(m[1], src, at, { aliases: {}, ...ctx }, 0)]; // resolve() keeps its own depth budget
  const t = ternary(expr);
  if (t) return [...new Set([...array(t[1], src, at, ctx, depth + 1), ...array(t[2], src, at, ctx, depth + 1)])];
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) return named(expr, src, at, ctx, depth, array);
  throw new NotEnumerable(`an array the walker can't read: ${expr.slice(0, 50)}`);
}
// A template's values. With holes, an interpolation the walker can't resolve becomes HOLE (fine in a value position);
// without, it is NotEnumerable.
function template(t, src, at, ctx, depth, holes) {
  let alts = [''];
  for (let j = 1; j < t.length - 1; j++) {
    if (t[j] === '\\') { alts = alts.map(a => a + t[j + 1]); j++; continue; }
    if (t[j] === '$' && t[j + 1] === '{') {
      const b = balanced(t, j + 1);
      let vals;
      try { vals = strings(b.slice(1, -1), src, at, ctx, depth + 1); } catch (e) { if (!(e instanceof NotEnumerable) || !holes) throw e; vals = [HOLE]; }
      alts = alts.flatMap(a => vals.map(v => a + v));
      if (alts.length > 512) throw new NotEnumerable(`too many values: ${t.slice(0, 50)}`);
      j += b.length;
      continue;
    }
    alts = alts.map(a => a + t[j]);
  }
  return [...new Set(alts)];
}

// scripts/backup-tables.mjs reads every table its rules list, each query built from data in the modules it imports. Its
// names are computed from those same modules; the templates below are what that computation models, and if any of them
// changes the model is stale and the site is NOT ENUMERABLE.
const BACKUP = {
  file: 'scripts/backup-tables.mjs',
  urls: ['`${SUPABASE_URL}/rest/v1/${table}?${query}`', '`${SUPABASE_URL}/rest/v1/${table}?select=id`'],
  queries: ["fetchTable(table, `select=*&order=id${filter ? `&${filter}` : ''}`)", 'fetchTable(table, `select=*&order=${key}`)', 'const key = WHOLE_FILE_KEY[table];'],
};
async function backupSites() {
  const s = readSource(BACKUP.file), where = BACKUP.file;
  const stale = [...BACKUP.urls, ...BACKUP.queries].filter(m => !s.includes(m));
  if ((s.match(/\bfetchTable\(/g) || []).length !== 3) stale.push('fetchTable is called somewhere new');
  if (stale.length) return [{ where, file: where, table: '(backup)', verb: 'names', state: 'NOT ENUMERABLE', why: `the model of its reads is stale: ${stale.join(' | ')}` }];
  const load = f => import(require('url').pathToFileURL(path.join(REPO_ROOT, f)).href);
  const rules = await load('scripts/lib/backup-rules.mjs'), shards = await load('scripts/lib/backup-shards.mjs');
  return Object.keys(rules.TABLE_RULES).map(t => {
    const qs = shards.SHARDED[t] ? [`select=*&order=id&${shards.dailyFilter(t, [{ id: 1 }], Date.now(), new Date().toISOString())}`, 'select=id'] : [`select=*&order=${rules.WHOLE_FILE_KEY[t]}`];
    try { return { where: `${where} (${t})`, file: where, table: t, verb: 'names', state: 'ENUMERATED', cols: new Set(qs.flatMap(queryNames)) }; }
    catch (e) { if (!(e instanceof NotEnumerable)) throw e; return { where: `${where} (${t})`, file: where, table: t, verb: 'names', state: 'NOT ENUMERABLE', why: e.message }; }
  });
}

// The top-level calls of a builder chain after position `from`: [{ name, args }].
function chainCalls(src, from) {
  const calls = [];
  let depth = 0, q = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
    // a top-level ',' ends the chain too (2026-11-12): inside Promise.all([a.from(..)..., b.from(..)...]) the next
    // element is not this chain's next call. Found when the lexer stripped a comment it had been leaving in, which had
    // been ending such a chain by accident (an apostrophe in the comment opened a "string").
    else if (depth === 0 && (ch === ';' || ch === ',')) break;
    else if (depth === 0 && ch === '.') {
      const m = src.slice(i).match(/^\.([a-zA-Z]+)\(/);
      if (m) { const args = balanced(src, i + m[0].length - 1); calls.push({ name: m[1], args: entries(`{${args.slice(1, -1)}}`) }); i += m[0].length - 1 + args.length - 1; }
    }
  }
  return calls;
}
const FILTERS = /^(eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|containedBy|overlaps|textSearch|order|filter|not|likeAllOf|likeAnyOf|ilikeAllOf|ilikeAnyOf|rangeGt|rangeGte|rangeLt|rangeLte|rangeAdjacent)$/;
const NAMES_NONE = /^(insert|update|upsert|delete|limit|range|single|maybeSingle|csv|abortSignal|returns|throwOnError|then|catch|finally)$/;
const plain = a => { const m = a && (a.match(/^'([^'\\]*)'$/) || a.match(/^"([^"\\]*)"$/)); return m ? m[1] : null; };
function chainNames(calls) {
  const cols = [];
  for (const { name, args } of calls) {
    if (name === 'select') { if (args.length) { const s = plain(args[0]); if (s == null) throw new NotEnumerable(`.select(${args[0].slice(0, 30)})`); cols.push(...selectList(s)); } }
    else if (FILTERS.test(name)) { const c = plain(args[0]); if (c == null) throw new NotEnumerable(`.${name}(${(args[0] || '').slice(0, 30)}, ..)`); cols.push(column(c, `.${name}()`)); }
    else if (name === 'or') { const s = plain(args[0]); if (s == null) throw new NotEnumerable(`.or(${(args[0] || '').slice(0, 30)})`); cols.push(...logicTree(`(${s})`)); }
    else if (name === 'match') { if (!args[0] || !args[0].startsWith('{')) throw new NotEnumerable('.match() of something not a literal'); cols.push(...literal(args[0], '', 0, { aliases: {} }, 0)); }
    else if (!NAMES_NONE.test(name)) throw new NotEnumerable(`.${name}(): a call the walker doesn't know names no column`);
    if (/^(insert|upsert)$/.test(name) && args[1]) {
      const oc = args[1].match(/onConflict:\s*([^,}]+)/);
      if (oc) { const s = plain(oc[1].trim()); if (s == null) throw new NotEnumerable('onConflict not a literal'); cols.push(...s.split(',').map(c => column(c.trim(), 'onConflict'))); }
    }
  }
  return cols;
}

async function enumerateNames() {
  const { sources } = sites();
  const ctx = { sources, aliases: ALIASES };
  const out = [];
  const site = (where, file, table, fn) => {
    try { out.push({ where, file, table, verb: 'names', state: 'ENUMERATED', cols: new Set(fn()) }); }
    catch (e) { if (!(e instanceof NotEnumerable)) throw e; out.push({ where, file, table, verb: 'names', state: 'NOT ENUMERABLE', why: e.message }); }
  };
  const line = (s, i) => s.slice(0, i).split('\n').length;
  for (const [f, s] of sources) {
    for (const m of s.matchAll(/\.from\('([a-z_0-9]+)'\)/g)) site(`${f}:${line(s, m.index)}`, f, m[1], () => chainNames(chainCalls(s, m.index + m[0].length)));
    for (const m of s.matchAll(/\b([A-Za-z_$][\w$]*)\.from\((?!')/g)) if (!/^(Array|\w+Array|Buffer|Set|Map|Object|Promise)$/.test(m[1])) site(`${f}:${line(s, m.index)}`, f, '(computed)', () => { throw new NotEnumerable('.from() of a table that is not a literal'); });
    for (const m of s.matchAll(/\/rest\/v1\//g)) {
      // the literal holding this URL: back to its opening quote on the same line
      let start = m.index;
      while (start > 0 && !"`'\"\n".includes(s[start - 1])) start--;
      const where = `${f}:${line(s, m.index)}`;
      const q = s[start - 1];
      if (start === 0 || q === '\n') { site(where, f, '(url)', () => { throw new NotEnumerable('a URL outside a literal on its line'); }); continue; }
      const end = q === '`' ? templateEnd(s, start - 1) : s.indexOf(q, start);
      const lit = s.slice(start - 1, end + 1);
      if (f === BACKUP.file && BACKUP.urls.includes(lit)) continue; // modelled in backupSites()
      const fn = enclosingFunction(s, start);
      const callers = fn && fn.params.length && /\$\{/.test(lit) ? callsOf(fn.name, f, ctx) : [];
      const binds = callers.length ? callers.map(c => ({ via: ` (called from ${c.file}:${line(c.src, c.at)})`, bind: { file: f, start: fn.start, end: fn.end, args: Object.fromEntries(fn.params.map((p, k) => [p.name, c.args[k] ? { expr: c.args[k], src: c.src, at: c.at, file: c.file } : p.dflt ? { expr: p.dflt, src: s, at: fn.start, file: f } : null])) } })) : [{ via: '', bind: null }];
      for (const { via, bind } of binds) {
        let urls;
        try { urls = q === '`' ? template(lit, s, start, { ...ctx, file: f, bind }, 0, true) : [lit.slice(1, -1)]; }
        catch (e) { if (!(e instanceof NotEnumerable)) throw e; site(where + via, f, '(url)', () => { throw e; }); continue; }
        const byTable = new Map();
        for (const u of urls) {
          const rest = u.slice(u.indexOf('/rest/v1/') + 9), qm = rest.indexOf('?');
          const table = qm < 0 ? rest : rest.slice(0, qm);
          if (!byTable.has(table)) byTable.set(table, []);
          byTable.get(table).push(qm < 0 ? '' : rest.slice(qm + 1));
        }
        for (const [table, qs] of byTable) {
          site(where + via, f, table, () => {
            if (!/^(rpc\/)?[a-z_][a-z_0-9]*$/.test(table)) throw new NotEnumerable(`a table the walker can't read: ${shown(table)}`);
            return qs.flatMap(queryNames);
          });
        }
      }
    }
  }
  // workflows: every curl URL, $VAR in it a value
  for (const f of list('.github/workflows', /\.yml$/)) {
    const y = readSource(f);
    for (const m of y.matchAll(/\/rest\/v1\/([a-z_0-9/]+)(?:\?([^"'\s]*))?/g)) {
      site(`${f}:${line(y, m.index)}`, f, m[1], () => queryNames((m[2] || '').replace(/\$\{?[A-Z_]+\}?/g, HOLE)));
    }
  }
  out.push(...await backupSites());
  return out;
}

module.exports = { ALIASES, BACKUP, BRANCHES, FILTERS, HOLE, NAMES_NONE, NotEnumerable, array, assigned, backupSites, balanced, callsOf, chainCalls, chainNames, collected, column, enclosingBlock, enclosingFunction, entries, enumerate, enumerateNames, fnReturn, identifier, list, literal, logicTree, loopValues, named, plain, queryNames, resolve, resolveSite, returnTokens, selectList, shown, sites, splitTop, statementAt, strings, strip, template, templateEnd, ternary };

// SQL with its comments removed in ONE quote-aware pass (2026-11-11): a "--" or "/*" inside a string literal is part of
// the literal, not a comment. Removing comments with separate regexes cut a literal at its "--" (two migrations and a
// CORRECTION carry one) and shifted every quote after it. Used by tests/live-columns.test.js's migrations() and
// tests/enumerated-values.test.js's CHECK reader.
function stripSql(text) {
  return text.replace(/\r\n/g, '\n').replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, x => (x.startsWith("'") ? x : ''));
}
module.exports.stripSql = stripSql;
