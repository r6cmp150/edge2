// tests/tables-without-create.test.js — 2026-11-04. Some tables were created
// outside the numbered migrations, so what constraints they have is inferred from
// behaviour, never read. db/038 had to abort on a CHECK it couldn't rule out. This
// keeps the list true both ways: a table the code uses with no CREATE in db/ has to
// be listed here and in the spec, and an entry that gains a CREATE has to come off.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { readSource, run, REPO_ROOT } = require('./_lib');

const NO_CREATE = ['db_meta', 'portfolio', 'rating_snapshots', 'settings', 'trades'];

const sqlFiles = () => fs.readdirSync(path.join(REPO_ROOT, 'db')).filter(f => f.endsWith('.sql')).map(f => readSource(`db/${f}`).replace(/--.*$/gm, ''));
const hasCreate = t => sqlFiles().some(s => new RegExp(`create\\s+table\\s+(if\\s+not\\s+exists\\s+)?(public\\.)?"?${t}"?\\b`, 'i').test(s));

function tablesInUse() {
  const walk = d => fs.readdirSync(path.join(REPO_ROOT, d), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  const files = ['app.js', ...['core', 'shell', 'engines', 'scripts', '.github/workflows'].flatMap(walk)].filter(f => /\.(js|mjs|cjs|yml)$/.test(f));
  const out = new Set();
  for (const f of files) {
    const src = readSource(f);
    for (const m of src.matchAll(/\.from\('([a-z_0-9]+)'\)/g)) out.add(m[1]);
    for (const m of src.matchAll(/\/rest\/v1\/([a-z_0-9]+)/g)) out.add(m[1]);
  }
  return out;
}

run('the enumeration sees tables both with and without a CREATE', () => {
  const used = tablesInUse();
  for (const t of ['portfolio', 'rating_snapshots', 'signal_log', 'trades_v2']) assert.ok(used.has(t), `did not find ${t}`);
  assert.ok(hasCreate('signal_log'), 'the CREATE match is not blind');
  assert.ok(!hasCreate('rating_snapshots'), 'and not everything matches');
});

run('every table in use or in the backup has a CREATE in db/, or is listed as not having one', async () => {
  const { TABLE_RULES } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/backup-rules.mjs')).href);
  const tables = new Set([...tablesInUse(), ...Object.keys(TABLE_RULES), 'db_meta']);
  const missing = [...tables].filter(t => !hasCreate(t) && !NO_CREATE.includes(t));
  assert.deepStrictEqual(missing, [], 'a new table with no CREATE in db/: add a migration, or list it and say so in the spec');
  const stale = NO_CREATE.filter(t => hasCreate(t));
  assert.deepStrictEqual(stale, [], 'these now have a CREATE: take them off the list');
});

run('reading the schema is a prerequisite of auth step 4 in the plan, before step 4', () => {
  const plan = readSource('claude/db-exposure-and-auth-plan.md');
  const pre = plan.indexOf('PREREQUISITE OF STEP 4'), step4 = plan.indexOf('4. **Migration A, additive');
  assert.ok(pre > 0 && pre < step4, 'stated, ahead of the step');
  assert.ok(plan.includes('db/inspect-public-schema-read-only.sql'), 'names the query');
  assert.ok(plan.includes("**Step 4 doesn't start until that is done.**"), 'as a gate, not a note');
  for (const t of NO_CREATE) assert.ok(plan.slice(pre, step4).includes(`\`${t}\``), `names ${t}`);
});

run('the spec names every one, and the read-only inspection for them exists and writes nothing', () => {
  const spec = readSource('docs/phase-10-entry-gate-spec.md');
  const section = spec.slice(spec.indexOf('### TABLES WITH NO CREATE IN db/'));
  assert.ok(section.length > 100, 'section found');
  for (const t of NO_CREATE) assert.ok(section.includes(`\`${t}\``), `the spec's list is missing ${t}`);
  const sql = readSource('db/inspect-public-schema-read-only.sql').replace(/--.*$/gm, '');
  assert.ok(/^\s*with t as \(/.test(sql), 'one statement');
  assert.ok(!/\b(insert|update|delete|alter|drop|create|grant|revoke|truncate)\b/i.test(sql), 'read-only');
});
