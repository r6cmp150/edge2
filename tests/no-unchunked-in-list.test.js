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
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (PATTERNS.some(p => p.test(line))) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
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
