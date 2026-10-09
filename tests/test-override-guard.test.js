// tests/test-override-guard.test.js — scripts/lib/test-override-guard.mjs:
// with --write, any non-allowlisted argument or non-empty TEST_* env refuses.
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT } = require('./_lib');

run('test override guard: allowlist args, TEST_* env, only with --write', async () => {
  const { refuseTestOverridesWithWrite: g } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/test-override-guard.mjs')).href);
  const ok = (argv, env = {}, o = {}) => assert.doesNotThrow(() => g('t', { argv, env, ...o }));
  const no = (argv, env = {}, re) => assert.throws(() => g('t', { argv, env }), re);
  ok(['--write']);                                   // the scheduled path
  ok(['--session=OPEN']);                            // dry run: overrides allowed
  ok([], { TEST_FORCE_TRIGGER_SYMBOL: 'GPRO' });     // dry run
  ok(['--write'], { TEST_FORCE_TRIGGER_SYMBOL: '' }); // empty = unset
  ok(['--write', '--scheduled'], {}, { allowedArgs: ['--write', '--scheduled'] });
  no(['--write', '--session=OPEN'], {}, /argument --session=OPEN/);
  no(['--session=OPEN', '--write'], {}, /refusing --write/);                  // order-independent
  no(['--write'], { TEST_FORCE_TRIGGER_SYMBOL: 'GPRO' }, /env TEST_FORCE_TRIGGER_SYMBOL/);
  no(['--write', '--some-future-flag'], {}, /--some-future-flag/);            // unknown flags refused by default
});
