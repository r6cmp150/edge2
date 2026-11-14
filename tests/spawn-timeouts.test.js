// tests/spawn-timeouts.test.js -- 2026-11-14. A test process (tests/stock-modal-render.test.js, PID 9472) ran from
// 2026-11-11 20:55 local until it was stopped on 2026-11-14 (55,625 CPU seconds), contending with every run since,
// mutant runs included, and nothing noticed. The runner was not the gap: it kills a file at its time limit and fails it
// as TIMEOUT (tests/run-tests-checker.test.js). The gap is that a kill reaches only the process it is aimed at.
// Measured on Windows the same day: a timed-out execSync('node x') leaves `node x` running (the shell is killed, not
// node), and a timed-out spawnSync(process.execPath, [x]) leaves nothing. So a test that spawns node with no timeout
// of its own leaves a grandchild that outlives the runner's kill. "A hang is a failure, not a wait" (2026-11-12), now
// for every spawn. The rule: every node spawn in tests/ and scripts/ is spawnSync(process.execPath, ...) with a
// timeout, or an async spawn named below with the timer that kills it. Never through a shell.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { run, REPO_ROOT } = require('./_lib');

// Async spawns, each with the kill timer it sets beside the call (read, not assumed).
const KILLED_BY_OWN_TIMER = {
  'scripts/lib/mutants.cjs': "setTimeout(() => { timedOutNow = true; child.kill('SIGKILL'); }, timeoutMs);",
  'tests/mutants-harness.test.js': 'child.kill(', // its cases kill the harness process themselves; that is what they test
};

function nodeSpawns(root = REPO_ROOT) {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(c|m)?js$/.test(e.name)) files.push(p); } };
  walk(path.join(root, 'tests')); walk(path.join(root, 'scripts'));
  const out = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(root, f).replace(/\\/g, '/');
    if (rel === 'tests/spawn-timeouts.test.js') continue; // this file quotes the patterns and holds a deliberate bad fixture
    for (const m of src.matchAll(/\b(spawnSync|execSync|execFileSync|spawn|execFile|exec)\(/g)) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(\/\/|\*)/.test(src.slice(lineStart, m.index))) continue; // a comment that names a call is not a call
      let d = 0, j = src.indexOf('(', m.index);
      for (; j < src.length; j++) { if (src[j] === '(') d++; else if (src[j] === ')') { d--; if (!d) break; } }
      const call = src.slice(m.index, j + 1);
      if (!/process\.execPath|['"`]node[ '"`]/.test(call)) continue;
      out.push({ file: rel, line: src.slice(0, m.index).split('\n').length, kind: m[1], call, src });
    }
  }
  return out;
}

run('every node spawn has a timeout, or a kill timer named here; none goes through a shell', () => {
  const spawns = nodeSpawns();
  assert.ok(spawns.length >= 15, `found ${spawns.length} node spawns (a blind scan would pass everything)`);
  const bad = [];
  for (const s of spawns) {
    const at = `${s.file}:${s.line}`;
    if (/^exec(Sync)?$/.test(s.kind)) { bad.push(`${at}: ${s.kind} runs node through a shell, whose kill leaves node running`); continue; }
    if (/\btimeout\s*:/.test(s.call)) continue;
    const timer = KILLED_BY_OWN_TIMER[s.file];
    if (s.kind === 'spawn' && timer && s.src.includes(timer)) continue;
    bad.push(`${at}: ${s.call.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  assert.deepStrictEqual(bad, [], 'a node spawn that can outlive its parent');
});

run('the scan catches each way to get it wrong', () => {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'edge2-spawns-'));
  fs.mkdirSync(path.join(tmp, 'tests')); fs.mkdirSync(path.join(tmp, 'scripts'));
  const write = (rel, body) => fs.writeFileSync(path.join(tmp, rel), body);
  write('tests/untimed.test.js', "spawnSync(process.execPath, ['x.js'], { encoding: 'utf8' });\n");
  write('tests/shell.test.js', "execSync('node x.js', { timeout: 1000 });\n");
  write('scripts/timed.mjs', "spawnSync(process.execPath, ['x.js'], {\n  encoding: 'utf8',\n  timeout: 5000,\n});\n");
  const found = nodeSpawns(tmp).map(s => `${s.file}|${s.kind}|${/\btimeout\s*:/.test(s.call)}`).sort();
  assert.deepStrictEqual(found, ['scripts/timed.mjs|spawnSync|true', 'tests/shell.test.js|execSync|true', 'tests/untimed.test.js|spawnSync|false']);
});
