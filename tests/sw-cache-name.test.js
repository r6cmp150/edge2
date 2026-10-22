// tests/sw-cache-name.test.js — sw.js's CACHE_NAME must carry index.html's
// app.js?v= stamp (2026-10-22). A hand-maintained cache name went stale at
// v2.16.0, so sw.js never changed, no new worker was ever installed, the
// update banner never fired, and every deploy's files piled up in one cache.
// There's no build step to inject the stamp, so this test refuses the
// divergence instead: impossible to forget rather than easier to remember.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

run('sw.js CACHE_NAME is edge2-<index.html app.js stamp>', () => {
  const stamp = readSource('index.html').match(/<script src="app\.js\?v=([^"&]+)"/);
  assert.ok(stamp, 'index.html has an app.js?v= tag');
  const name = readSource('sw.js').match(/^const CACHE_NAME = '([^']+)';/m);
  assert.ok(name, 'sw.js declares CACHE_NAME');
  assert.strictEqual(name[1], `edge2-${stamp[1]}`,
    `sw.js CACHE_NAME must be 'edge2-${stamp[1]}' (it is '${name[1]}'): set it to the app.js stamp, or the deploy installs no new worker and the update banner never fires`);
});

run('sw.js lists no versioned file by hand: it precaches what index.html loads', () => {
  const sw = readSource('sw.js');
  assert.ok(!/\?v=\d/.test(sw.replace(/^\s*\/\/.*$/gm, '')), 'no ?v= literals in sw.js code');
  assert.ok(/fetch\('\.\/index\.html', \{ cache: 'no-store' \}\)/.test(sw), 'install reads index.html for its file list');
  assert.ok(!/cache\.addAll\(/.test(sw), 'install adds files one at a time (addAll is all-or-nothing and would block updates)');
});
