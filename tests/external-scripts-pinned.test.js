// tests/external-scripts-pinned.test.js -- 2026-11-19 (the reviewer). "An unpinned dependency is an unmeasured input":
// supabase-js was loaded as "@2" and moved from 2.119.1 to 2.119.2 overnight while pinning was being argued. Held here:
//   - every external <script> in index.html names an EXACT version (x.y.z), so the next one cannot arrive unpinned;
//   - no external script is reached another way (an import() of a URL, a <script> built in code);
//   - the supabase-js pin carries its record, and the record's PROBED line names the pinned version: a bump without
//     re-running scripts/probe-supabase-abort.mjs fails here ("a pin freezes a version, not a property").
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const html = readSource('index.html');

function externalScripts(src) {
  return [...src.matchAll(/<script\b[^>]*\bsrc="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
}
function unpinned(urls) {
  // an exact version is @x.y.z, followed by the end of the URL or a path
  return urls.filter(u => !/@\d+\.\d+\.\d+(\/|$)/.test(u));
}

run('every external <script> in index.html names an exact version', () => {
  const urls = externalScripts(html);
  assert.deepStrictEqual(urls.sort(), [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  ].sort(), 'the external scripts, by name (a new one is added here, pinned)');
  assert.deepStrictEqual(unpinned(urls), []);
});

run('the check refuses each way to be unpinned (both directions)', () => {
  const bad = ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js', 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js',
    'https://cdn.jsdelivr.net/npm/chart.js@latest/dist/chart.umd.min.js', 'https://unpkg.com/x@^1.2.3'];
  assert.deepStrictEqual(unpinned(bad), bad);
  assert.deepStrictEqual(unpinned(['https://cdn.jsdelivr.net/npm/a@1.2.3', 'https://cdn.jsdelivr.net/npm/b@10.0.12/dist/b.js']), []);
  assert.deepStrictEqual(externalScripts('<script src="https://x/y@1.2.3"></script><script defer src="http://z/w@1"></script>'), ['https://x/y@1.2.3', 'http://z/w@1']);
});

run('no external script is loaded another way (every app source file read)', () => {
  const fs = require('fs'), path = require('path'), { REPO_ROOT } = require('./_lib');
  const files = ['app.js', 'sw.js'];
  const walk = d => { for (const e of fs.readdirSync(path.join(REPO_ROOT, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.(m|c)?js$/.test(e.name)) files.push(p); } };
  for (const d of ['core', 'shell', 'engines']) walk(d);
  assert.ok(files.length > 10, `read ${files.length} files (a blind scan passes everything)`);
  const ways = [[/import\(\s*['"`]https?:/, 'an import() of a URL'], [/import\s[^;]*from\s*['"`]https?:/, 'a static import of a URL'],
    [/createElement\(\s*['"]script['"]\s*\)/, 'a <script> element built in code'], [/importScripts\(/, 'importScripts in a worker']];
  for (const f of files) { const s = readSource(f); for (const [re, what] of ways) assert.ok(!re.test(s), `${f}: ${what}`); }
  // and the patterns catch what they name
  for (const [re] of ways) assert.ok([`import('https://x/y.js')`, `import a from 'https://x/y.js';`, `document.createElement('script')`, `importScripts('x')`].some(x => re.test(x)));
});

run('the supabase-js pin carries its record, and the record was probed at the pinned version', () => {
  const pinned = html.match(/supabase-js@(\d+\.\d+\.\d+)"/)[1];
  const i = html.indexOf('<!-- Supabase. PINNED');
  assert.ok(i >= 0, 'the record beside the pin');
  const record = html.slice(i, html.indexOf('-->', i));
  assert.ok(html.indexOf(`supabase-js@${pinned}"`) > i, 'the record is beside (above) the pin');
  const probed = record.match(/PROBED: supabase-js (\d+\.\d+\.\d+), (\d+) shapes, (\S+Z)/);
  assert.ok(probed, 'the record quotes the probe\'s PROBED line');
  assert.strictEqual(probed[1], pinned, `the record was probed at ${probed[1]} but the pin is ${pinned}: run node scripts/probe-supabase-abort.mjs and quote its last line`);
  assert.ok(/node scripts\/probe-supabase-abort\.mjs/.test(record), 'the record names the probe');
  // the probe's shapes are the record's "six": the line it prints counts them, so a changed set changes the line
  assert.strictEqual(Number(probed[2]), (readSource('scripts/probe-supabase-abort.mjs').match(/^ {2}\['.+', '(read|write)', /gm) || []).length);
});
