// tests/script-dependencies.test.js — every name a cron script loads out of a
// core/engine file must exist there (2026-10-22, completing the §7.7 logger
// sweep). loadReal(file, [names]) evals the file and exposes each name; a
// renamed or deleted function only fails when the script runs, and cron
// delivers a few times a day, so it would break silently for hours. This
// turns that run-time dependency into a test-time one, for every call,
// including ones added later.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSource, run, REPO_ROOT } = require('./_lib');

const SCRIPTS = fs.readdirSync(path.join(REPO_ROOT, 'scripts')).filter(f => f.endsWith('.mjs')).map(f => `scripts/${f}`);
const declared = (src, name) => new RegExp(String.raw`^(?:export\s+)?(?:(?:async\s+)?function\s*\*?\s*|(?:const|let|var|class)\s+)${name}\b`, 'm').test(src);

run('every loadReal name exists as a top-level declaration in its target file', () => {
  let checked = 0;
  const missing = [];
  for (const script of SCRIPTS) {
    const src = readSource(script);
    for (const m of src.matchAll(/loadReal\(\s*'([^']+)'\s*,\s*\[([\s\S]*?)\]\s*\)/g)) {
      const target = m[1];
      const names = [...m[2].matchAll(/'([A-Za-z_$][\w$]*)'/g)].map(x => x[1]);
      assert.ok(names.length, `${script}: loadReal('${target}') with no names`);
      assert.ok(fs.existsSync(path.join(REPO_ROOT, target)), `${script}: loadReal target ${target} does not exist`);
      const targetSrc = readSource(target);
      for (const n of names) { checked++; if (!declared(targetSrc, n)) missing.push(`${script} expects ${n} in ${target}`); }
    }
  }
  assert.ok(checked >= 40, `parsed ${checked} names; the parser may have stopped matching`);
  assert.deepStrictEqual(missing, [], 'names a cron script loads but its target no longer declares');
  console.log(`  ${checked} names across ${SCRIPTS.length} scripts`);
});
