// tests/three-state-guards.test.js — 2026-11-05. PL/pgSQL treats a NULL IF condition as false, so a guard written
// `if <cond> then raise` proceeds when its condition can't be evaluated: the CHECK constraint's NULL hole, in the code
// meant to stop a bad run. In every migration not yet applied, a guard (an IF whose body raises, or records into
// `wrong`) is `if (<cond>) is not false then`: true and NULL abort, only a definite false proceeds.
// Applied, and so history: everything up to db/035, and db/040. Everything else is held to it, db/036 included.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { run, readSource, REPO_ROOT } = require('./_lib');

const APPLIED = n => n <= 35 || n === 40; // db/035 run 1 and db/040 have run; db/036 has not (it follows (b)'s deploy)

// Statement-level IFs (each starts its own line), with their condition and what follows THEN.
function guards(text) {
  const out = [];
  const re = /^[ \t]*if\s/gim;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    let j = start, depth = 0, inStr = false;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) { if (ch === "'") { if (text[j + 1] === "'") j++; else inStr = false; } continue; }
      if (ch === "'") { inStr = true; continue; }
      if (ch === '(') depth++; else if (ch === ')') depth--;
      else if (depth === 0 && /^\sthen\b/i.test(text.slice(j, j + 6))) break;
    }
    const cond = text.slice(start, j).trim();
    const body = text.slice(j + 5).trimStart();
    if (/^(raise\s+exception|wrong\s*:=)/i.test(body)) out.push(cond);
  }
  return out;
}
const threeState = cond => /^\(([\s\S]*)\)\s+is\s+not\s+false$/i.test(cond);

(async () => {
await run('the detector: a bare guard is caught, the three-state form and non-guards pass', () => {
  assert.deepStrictEqual(guards(`  if n > 0 then raise exception 'x';\n  end if;`).map(threeState), [false]);
  assert.deepStrictEqual(guards(`  if (n > 0) is not false then raise exception 'x';\n  end if;`).map(threeState), [true]);
  assert.deepStrictEqual(guards(`  if (a\n     or b) is not false then\n    raise exception 'x';`).map(threeState), [true], 'multi-line');
  assert.deepStrictEqual(guards(`  if x then wrong := wrong || ' [x]'; end if;`).map(threeState), [false], 'a guard that records');
  assert.strictEqual(guards(`  if to_regclass('t') is not null then v := 1; end if;`).length, 0, 'an assignment branch is not a guard');
  assert.strictEqual(guards(`drop policy if exists "p" on t;\ncomment on t is 'if then raise exception';`).length, 0, 'DDL and string text are not guards');
});

await run('every guard in a migration not yet applied is three-state', () => {
  const dir = path.join(REPO_ROOT, 'db');
  const bare = [];
  let held = 0;
  for (const f of fs.readdirSync(dir).filter(f => /^\d{3}[-_].*\.sql$/.test(f))) {
    if (APPLIED(Number(f.slice(0, 3)))) continue;
    held++;
    for (const c of guards(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n'))) if (!threeState(c)) bare.push(`${f}: if ${c.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  assert.ok(held >= 2, `held ${held} files: db/041 at least`);
  assert.deepStrictEqual(bare, []);
});

await run('the rule is in §7.7', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md').replace(/\s+/g, ' ');
  assert.ok(spec.includes('A MIGRATION GUARD IS THREE-STATE: IT PROCEEDS ONLY ON A DEFINITE FALSE.'));
});
})();
