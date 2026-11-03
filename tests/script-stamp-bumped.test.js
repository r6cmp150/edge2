// tests/script-stamp-bumped.test.js — 2026-11-02. index.html says "Bump a
// file's ?v= whenever that file changes", and nothing checked it. b2eb9d8
// changed core/clock.js and core/entry-gate.js and bumped only app.js, so a
// browser holding the old clock.js could run the new app.js against a
// clock.js with no scanFreshness. 09f281c (2026-09-15) did the same to
// core/market-data.js. A guard that refuses it, not a reminder.
//
// For every local <script src="X?v=…"> in index.html:
//   - X changed in the working tree: its stamp must differ from HEAD's;
//   - otherwise: the last commit that changed X must be the commit that
//     last changed X's stamp, or an ancestor of it.
'use strict';
const assert = require('assert');
const { execSync } = require('child_process');
const { readSource, run, REPO_ROOT } = require('./_lib');

const git = (args, opts = {}) => execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
const ok = args => { try { git(args); return true; } catch (_) { return false; } };
const stamps = html => Object.fromEntries([...html.matchAll(/<script src="([^":?]+)\?v=(\d+)"/g)].map(m => [m[1], m[2]]));

run('every local script whose file changed has a new ?v= stamp', () => {
  let shallow;
  try { shallow = git('rev-parse --is-shallow-repository') === 'true'; } catch (_) { console.log('  (not a git checkout; skipped)'); return; }
  if (shallow) { console.log('  (shallow clone: history unavailable; skipped)'); return; }
  const now = stamps(readSource('index.html'));
  const head = stamps(git('show HEAD:index.html'));
  assert.ok(Object.keys(now).length >= 10, 'index.html scripts found');
  const bad = [];
  for (const [file, stamp] of Object.entries(now)) {
    if (stamp !== head[file]) continue; // bumped in the working tree
    if (!ok(`diff --quiet HEAD -- ${file}`)) { bad.push(`${file}: changed in the working tree, stamp still ${stamp}`); continue; }
    const changed = git(`log -1 --format=%H -- ${file}`);
    const bumped = git(`log -1 --format=%H -G"${file.replace(/\./g, '\\.')}\\?v=" -- index.html`);
    if (!changed) continue;
    if (!bumped || !ok(`merge-base --is-ancestor ${changed} ${bumped}`)) bad.push(`${file}: changed in ${changed.slice(0, 7)} after its stamp last changed (${(bumped || 'never').slice(0, 7)})`);
  }
  assert.deepStrictEqual(bad, []);
});

// 2026-11-02: a new ?v= alone doesn't deliver a file. An open app keeps the
// old code until a new service worker installs, and that happens only when
// sw.js changes: CACHE_NAME (= 'edge2-<app.js stamp>', tests/sw-cache-name
// .test.js). A core/-only change that bumped just its own ?v= would leave an
// open app on the old code with no update banner (found costing the
// settings-save carve-out; the b2eb9d8 miss in a new place). So any changed
// local script also requires a new CACHE_NAME.
const cacheName = sw => (sw.match(/const CACHE_NAME = '([^']+)'/) || [])[1];
run('every changed local script also changes sw.js CACHE_NAME (that is what installs it)', () => {
  let shallow;
  try { shallow = git('rev-parse --is-shallow-repository') === 'true'; } catch (_) { console.log('  (not a git checkout; skipped)'); return; }
  if (shallow) { console.log('  (shallow clone: history unavailable; skipped)'); return; }
  const now = stamps(readSource('index.html'));
  const head = stamps(git('show HEAD:index.html'));
  const nameNow = cacheName(readSource('sw.js')), nameHead = cacheName(git('show HEAD:sw.js'));
  assert.ok(nameNow && nameHead, 'sw.js declares CACHE_NAME');
  const bad = [];
  const changedHere = Object.keys(now).filter(f => now[f] !== head[f] || !ok(`diff --quiet HEAD -- ${f}`));
  if (changedHere.length && nameNow === nameHead) bad.push(`working tree changes ${changedHere.join(', ')} but CACHE_NAME is still ${nameNow}`);
  const cacheBumped = git(`log -1 --format=%H -G"const CACHE_NAME = " -- sw.js`);
  for (const file of Object.keys(now)) {
    if (changedHere.includes(file)) continue;
    const changed = git(`log -1 --format=%H -- ${file}`);
    if (!changed) continue;
    if (!cacheBumped || !ok(`merge-base --is-ancestor ${changed} ${cacheBumped}`)) bad.push(`${file}: changed in ${changed.slice(0, 7)} after CACHE_NAME last changed (${(cacheBumped || 'never').slice(0, 7)})`);
  }
  assert.deepStrictEqual(bad, []);
});
