// tests/production-writes.test.js -- 2026-11-12. NO CODE IN THIS REPO WRITES TO PRODUCTION BY DEFAULT (the reviewer's
// rule; scripts/lib/production-write.mjs says why). What this holds, and which question each part answers:
//   1. the library: only EDGE2_PRODUCTION_WRITE equal to the writer's own name permits; every refusal exits 3 and says
//      what would have been written.
//   2. every script the walker finds a write site in calls it with its own name, BEFORE its first write, with a plan
//      whose tables and columns are the walker's (so the printed plan cannot drift from the code).
//   3. every script the walker never sees (scripts/test-*, scripts/probe-*, *.cjs, *.js) that carries a write marker
//      calls it too; its plan's tables must be tables the file names. Its columns are declared by hand, NOT checked.
//   4. workflows: every step that runs a writer declares that writer's name in its own env; every curl write declares
//      workflow_runs and refuses without it (exit 3) before the curl; nothing is set at job or workflow level; no
//      workflow runs a test-* script; run_grant_checks is gone.
//   5. prevent-and-observe: each writer RUN without the variable, the network blocked, exits 3 before any request; and
//      the control: with the variable set, the same run gets past the refusal (so a refusal that always fires, or a
//      check that cannot fail, shows here).
// backup-tables.mjs writes to git, not the production database: out of scope by decision (CC-refusal-boundary). Its
// workflow's own workflow_runs steps are in scope like every other workflow's.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { readSource, run, REPO_ROOT } = require('./_lib');
const W = require('./_write-walker');

const VAR = 'EDGE2_PRODUCTION_WRITE';
const CALL = 'requireProductionWrite(';
const nameOf = f => path.basename(f).replace(/\.(mjs|cjs|js)$/, '');

// The plan a file passes: the array literal after requireProductionWrite('<name>', -- plain literals only.
function declared(file) {
  const s = W.strip(readSource(file));
  const calls = [...s.matchAll(/requireProductionWrite\('([^']+)',\s*\[/g)];
  return calls.map(m => {
    const open = m.index + m[0].length - 1;
    const text = W.balanced(s, open);
    // eslint-disable-next-line no-new-func
    return { name: m[1], at: m.index, plan: new Function(`return (${text});`)() };
  });
}

// A write marker, for files the walker does not scan: a write verb toward the database, or a call into the app's own
// write functions.
const WRITE_MARKER = /method:\s*'(POST|PATCH|PUT|DELETE)'|\.from\('[a-z_0-9]+'\)\s*\.(insert|update|upsert|delete)\(|(insertPositionToSupabase|savePositionToSupabase|deletePositionFromSupabase)\(|curl\s[^\n]*-X\s*(POST|PATCH|PUT|DELETE)/;

const scriptFiles = () => {
  const out = [];
  for (const dir of ['scripts', 'scripts/lib']) {
    for (const f of fs.readdirSync(path.join(REPO_ROOT, dir))) if (/\.(mjs|cjs|js)$/.test(f)) out.push(`${dir}/${f}`);
  }
  return out;
};
const walkerScans = f => /\.mjs$/.test(f) && !/scripts\/(test-|probe-)/.test(f); // tests/_write-walker.js sites()

// Workflow steps, by indentation: "      - " opens a step under jobs.<id>.steps.
function steps(file) {
  const lines = readSource(file).split('\n');
  const out = [];
  let cur = null;
  lines.forEach((l, i) => {
    if (/^ {6}- /.test(l)) { cur = { file, line: i + 1, text: l + '\n' }; out.push(cur); return; }
    if (cur && (/^ {0,5}\S/.test(l))) { cur = null; return; }
    if (cur) cur.text += l + '\n';
  });
  return out;
}
const workflows = () => fs.readdirSync(path.join(REPO_ROOT, '.github/workflows')).filter(f => /\.ya?ml$/.test(f)).map(f => `.github/workflows/${f}`);

(async () => {
const lib = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/production-write.mjs')).href);
const PLAN = [{ table: 'signal_log', verb: 'insert', columns: ['symbol', 'tier'], rows: 'one per signal' }];

await run('only the variable set to the writer\'s own name permits; anything else refuses, says what it would write, and exits 3', () => {
  const ok = lib.productionWriteVerdict('log-signals-edge', PLAN, { [VAR]: 'log-signals-edge' });
  assert.strictEqual(ok.permitted, true);
  assert.ok(ok.lines[0].startsWith('PRODUCTION WRITE PERMITTED: log-signals-edge'), ok.lines[0]);
  for (const value of [undefined, '', '1', 'true', 'log-signals-warrior', 'LOG-SIGNALS-EDGE', ' log-signals-edge', 'log-signals-edge.mjs', 'scripts/log-signals-edge.mjs']) {
    const v = lib.productionWriteVerdict('log-signals-edge', PLAN, value === undefined ? {} : { [VAR]: value });
    assert.strictEqual(v.permitted, false, JSON.stringify(value));
    assert.ok(v.lines[0].startsWith('PRODUCTION WRITE REFUSED: log-signals-edge: '), v.lines[0]);
    assert.ok(v.lines.some(l => l.includes('insert signal_log (symbol, tier): one per signal')), 'says what it would have written');
  }
  const logged = []; const exits = [];
  const r = lib.requireProductionWrite('log-signals-edge', PLAN, { env: {}, log: l => logged.push(l), exit: c => exits.push(c) });
  assert.deepStrictEqual(exits, [3], 'a refusal always exits non-zero: a scheduled job that lost its variable goes red');
  assert.strictEqual(r, false);
  assert.ok(logged.length >= 3);
  const exits2 = [];
  assert.strictEqual(lib.requireProductionWrite('log-signals-edge', PLAN, { env: { [VAR]: 'log-signals-edge' }, log: () => {}, exit: c => exits2.push(c) }), true);
  assert.deepStrictEqual(exits2, []);
});

await run('a writer that cannot say what it writes is refused like a missing variable', () => {
  const env = { [VAR]: 'x' };
  for (const [name, plan] of [['', PLAN], ['X Y', PLAN], ['x', []], ['x', null], ['x', [{ table: '', verb: 'insert', columns: ['a'], rows: 'r' }]],
    ['x', [{ table: 't', verb: 'upsert', columns: ['a'], rows: 'r' }]], ['x', [{ table: 't', verb: 'insert', columns: [], rows: 'r' }]], ['x', [{ table: 't', verb: 'update', columns: ['a'], rows: '' }]]]) {
    const v = lib.productionWriteVerdict(name, plan, { ...env, [VAR]: name });
    assert.strictEqual(v.permitted, false, `${JSON.stringify(name)} ${JSON.stringify(plan)}`);
    assert.ok(/^PRODUCTION WRITE REFUSED: .*; nothing was written\.$/.test(v.lines[0]), v.lines[0]);
  }
  assert.strictEqual(lib.productionWriteVerdict('x', [{ table: 't', verb: 'delete', columns: [], rows: 'that row' }], env).permitted, true, 'a delete names rows, not columns');
});

// The writers the walker finds, from its write sites (never from a list kept by hand).
const sites = W.enumerate().filter(s => s.file.startsWith('scripts/'));
const walkerWriters = [...new Set(sites.map(s => s.file))].sort();

await run('every script the walker finds a write in refuses first, by its own name, and declares exactly the walker\'s tables and columns', () => {
  assert.ok(walkerWriters.length >= 4, `the walker found ${walkerWriters.length} writing scripts`);
  for (const file of walkerWriters) {
    const calls = declared(file);
    assert.strictEqual(calls.length, 1, `${file}: one requireProductionWrite call`);
    const [{ name, at, plan }] = calls;
    assert.strictEqual(name, nameOf(file), `${file}: the variable must name this script`);
    const mine = sites.filter(s => s.file === file);
    for (const s of mine) {
      assert.strictEqual(s.state, 'ENUMERATED', `${s.where}: the walker could not read this write`);
      assert.ok(at < s.at, `${file}: the refusal must come before the write at ${s.where}`);
    }
    const key = (t, v) => `${t} ${v}`;
    const want = new Map();
    for (const s of mine) { const k = key(s.table, s.verb); want.set(k, new Set([...(want.get(k) || []), ...s.cols])); }
    const got = new Map();
    for (const p of plan) { const k = key(p.table, p.verb); got.set(k, new Set([...(got.get(k) || []), ...p.columns])); }
    assert.deepStrictEqual([...got.keys()].sort(), [...want.keys()].sort(), `${file}: the tables and verbs it declares`);
    for (const [k, cols] of want) assert.deepStrictEqual([...got.get(k)].sort(), [...cols].sort(), `${file}: ${k}: the columns it declares`);
  }
});

await run('every script the walker never sees that carries a write marker refuses first too (columns declared by hand, not checked)', () => {
  const unseen = scriptFiles().filter(f => !walkerScans(f) && f !== 'scripts/lib/production-write.mjs');
  const writers = unseen.filter(f => WRITE_MARKER.test(W.strip(readSource(f))));
  assert.ok(writers.length >= 4, `found ${writers.length}: ${writers.join(', ')}`);
  for (const file of writers) {
    const s = W.strip(readSource(file));
    const calls = declared(file);
    assert.strictEqual(calls.length, 1, `${file} can write to production and has no refusal`);
    assert.strictEqual(calls[0].name, nameOf(file), `${file}: the variable must name this script`);
    const first = s.search(WRITE_MARKER);
    assert.ok(calls[0].at < first, `${file}: the refusal must come before its first write marker`);
    const named = new Set([...s.matchAll(/rest\/v1\/([a-z_0-9]+)/g), ...s.matchAll(/\.from\('([a-z_0-9]+)'\)/g)].map(m => m[1]));
    if (/(insert|save|delete)PositionToSupabase|PositionFromSupabase/.test(s)) named.add('portfolio');
    for (const p of calls[0].plan) assert.ok(named.has(p.table), `${file}: declares ${p.table}, which the file never names`);
  }
  assert.deepStrictEqual(writers.filter(f => /probe-/.test(f)), [], 'a probe that writes is not kept (CC-probe-and-bundle-ruling)');
});

await run('workflows: every writing step declares its writer in its own env, refuses without it, and nothing is set globally', () => {
  const writerNames = new Set([...walkerWriters, ...scriptFiles().filter(f => declared(f).length)].map(nameOf));
  let curlSteps = 0, scriptSteps = 0;
  for (const wf of workflows()) {
    const src = readSource(wf);
    for (const l of src.split('\n')) {
      if (l.includes(`${VAR}:`)) assert.ok(/^ {10}EDGE2_PRODUCTION_WRITE: [a-z0-9_-]+( #.*)?$/.test(l), `${wf}: ${VAR} set outside a step's env: "${l.trim()}"`);
    }
    assert.ok(!/node scripts\/test-/.test(src), `${wf}: a workflow runs a test-* script`);
    assert.ok(!/run_grant_checks\s*:|inputs\.run_grant_checks/.test(src), `${wf}: run_grant_checks is retired`);
    for (const st of steps(wf)) {
      const decl = (st.text.match(/^ {10}EDGE2_PRODUCTION_WRITE: ([a-z0-9_-]+)/m) || [])[1];
      const curl = [...st.text.matchAll(/curl\s[^\n]*-X\s*(POST|PATCH|PUT|DELETE)\s+"[^"]*rest\/v1\/([a-z_0-9]+)/g)];
      // unique: a step echoes "Running: node scripts/x.mjs $ARGS" before running it
      const runs = [...new Set([...st.text.matchAll(/node scripts\/([a-z0-9_-]+)\.mjs/g)].map(m => m[1]).filter(n => writerNames.has(n)))];
      assert.ok(!(curl.length && runs.length), `${wf}:${st.line}: one step, one writer`);
      if (curl.length) {
        curlSteps++;
        for (const c of curl) assert.strictEqual(c[2], 'workflow_runs', `${wf}:${st.line}: a curl write to ${c[2]} is not declared anywhere`);
        assert.strictEqual(decl, 'workflow_runs', `${wf}:${st.line}: a curl write without ${VAR}: workflow_runs`);
        const g = st.text.indexOf('[ "$EDGE2_PRODUCTION_WRITE" = "workflow_runs" ] || {');
        assert.ok(g >= 0 && g < curl[0].index, `${wf}:${st.line}: the step must refuse before its curl`);
        assert.ok(/\|\| \{ echo "PRODUCTION WRITE REFUSED: [^"]+ would have written: [^"]+"; exit 3; \}/.test(st.text.slice(g)), `${wf}:${st.line}: the refusal says what and exits 3`);
      } else if (runs.length) {
        scriptSteps++;
        assert.strictEqual(runs.length, 1, `${wf}:${st.line}: one step, one writer`);
        assert.strictEqual(decl, runs[0], `${wf}:${st.line}: runs ${runs[0]} without ${VAR}: ${runs[0]}`);
      } else {
        assert.strictEqual(decl, undefined, `${wf}:${st.line}: declares ${decl} but runs no writer`);
      }
    }
  }
  assert.strictEqual(curlSteps, 12, 'six workflows, a firing and an outcome step each');
  assert.strictEqual(scriptSteps, 3, 'log-signals-edge, log-signals-warrior, fill-outcomes');
});

// 5. Prevent and observe: run each writer with the network blocked. A preload replaces fetch with one that throws, so
// a request that escapes the refusal fails loudly here instead of reaching production.
const BLOCK = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch = () => { throw new Error('NETWORK BLOCKED'); };");
const cleanEnv = extra => {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k === VAR || /^(OUTCOME_FILLER|ALPACA|SUPABASE)/.test(k) || k.startsWith('TEST_')) delete env[k];
  return { ...env, ...extra };
};
const runWriter = (file, extra) => spawnSync(process.execPath, ['--import', BLOCK, path.join(REPO_ROOT, file), ...(/test-/.test(file) ? [] : ['--write'])],
  { encoding: 'utf8', cwd: REPO_ROOT, env: cleanEnv(extra), timeout: 60000 });

await run('the network block itself works (shown before anything relies on it)', () => {
  const r = spawnSync(process.execPath, ['--import', BLOCK, '--input-type=module', '-e', "try { await fetch('https://example.invalid/'); console.log('FETCH RAN'); } catch (e) { console.log(e.message); }"],
    { encoding: 'utf8', cwd: REPO_ROOT, env: cleanEnv({}), timeout: 30000 });
  assert.strictEqual(r.stdout.trim(), 'NETWORK BLOCKED', r.stdout + r.stderr);
});

await run('each writer, run without the variable, exits 3 before any request and prints what it would have written', () => {
  const all = [...new Set([...walkerWriters, ...scriptFiles().filter(f => declared(f).length && f !== 'scripts/lib/production-write.mjs')])].sort();
  assert.strictEqual(all.length, 8, all.join(', '));
  for (const file of all) {
    for (const extra of [{}, { [VAR]: 'some-other-script' }]) {
      const r = runWriter(file, extra);
      assert.strictEqual(r.status, 3, `${file} ${JSON.stringify(extra)}: exit ${r.status}\n${r.stderr}`);
      assert.ok(r.stderr.startsWith(`PRODUCTION WRITE REFUSED: ${nameOf(file)}: `), r.stderr);
      assert.ok(!/NETWORK BLOCKED/.test(r.stderr + r.stdout), `${file}: a request was attempted before the refusal`);
      for (const p of declared(file)[0].plan) assert.ok(r.stderr.includes(`${p.verb} ${p.table}`), `${file}: the refusal names ${p.verb} ${p.table}`);
    }
  }
});

await run('control: with the variable set to its own name, the same run gets past the refusal (and the blocked network stops it)', () => {
  // Only the three scripts whose next step is their own credential check, which fails here (cleanEnv drops every
  // OUTCOME_FILLER* variable) and exits 1 before any request. Not test-db028-roundtrip: past its refusal it loads
  // supabase-js and inserts, so only the network block would stand between this test and production. Not the --write
  // loggers: they would go on to read and write files. The library tests above cover the permitted branch for those.
  for (const file of ['scripts/test-db019-db021-grants.mjs', 'scripts/test-outcome-filler-role.mjs', 'scripts/test-outcome-filler-role-production.mjs']) {
    const r = runWriter(file, { [VAR]: nameOf(file) });
    assert.strictEqual(r.status, 1, `${file}: expected its credential check to stop it\n${r.stderr}`);
    assert.ok(r.stderr.includes(`PRODUCTION WRITE PERMITTED: ${nameOf(file)}`), r.stderr);
    assert.ok(/Set OUTCOME_FILLER(_TEST)?_JWT first/.test(r.stderr), `${file}: stopped by its credential check\n${r.stderr}`);
    assert.ok(!/NETWORK BLOCKED/.test(r.stderr + r.stdout), `${file}: a request was attempted`);
  }
});
})();
