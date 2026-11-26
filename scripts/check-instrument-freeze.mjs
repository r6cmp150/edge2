#!/usr/bin/env node
// scripts/check-instrument-freeze.mjs -- THE FROZEN INSTRUMENT'S DETECTOR (STATUS, "THE INSTRUMENT IS FROZEN", declared
// 2026-11-25). Read only. Compares every frozen file, every frozen app.js declaration and every frozen setting with the
// manifest's baseline, and reports any file on the scan path or declaration in app.js that is classified nowhere. An
// undeclared change announces itself here rather than waiting to be noticed (the reviewer, after the macro labeller
// changed under the sign test on 11-17).
//   node scripts/check-instrument-freeze.mjs                 the working tree (the daily line, after the backup)
//   node scripts/check-instrument-freeze.mjs --rev <commit>  a commit, read with git show
//   node scripts/check-instrument-freeze.mjs --write-manifest   ONCE, at the declaration; again only at a declared restart
// Exit: 0 INTACT; 1 CHANGED or UNCLASSIFIED (red, named); 2 could not read.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildManifest, checkFreeze, SCANNED_DIRS } from './lib/instrument-freeze.mjs';
import { floatDiff, interventions, rebuildLine } from './lib/float-rebuilds.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SPEC = 'data/forward-test/instrument-freeze-spec.json', MANIFEST = 'data/forward-test/instrument-freeze.json', SETTINGS = 'data/backups/settings.json';
export const TOP = ['app.js', 'index.html', 'sw.js'];
export const FLOAT_TABLE = 'data/float-table.json';

export function treeReader(root = ROOT) {
  const read = p => (existsSync(path.join(root, p)) ? readFileSync(path.join(root, p), 'utf8') : null);
  const walk = d => (existsSync(path.join(root, d)) ? readdirSync(path.join(root, d)).flatMap(f => { const p = `${d}/${f}`; return statSync(path.join(root, p)).isDirectory() ? walk(p) : [p]; }) : []);
  return { read, list: () => [...TOP.filter(p => read(p) != null), ...SCANNED_DIRS.flatMap(walk)] };
}
export function revReader(rev, root = ROOT) {
  const read = p => { try { return execFileSync('git', ['show', `${rev}:${p}`], { cwd: root, maxBuffer: 1e9 }).toString(); } catch { return null; } };
  const list = () => execFileSync('git', ['ls-tree', '-r', '--name-only', rev, '--', ...TOP, ...SCANNED_DIRS], { cwd: root }).toString().trim().split('\n').filter(Boolean);
  return { read, list };
}
export const settingsRow = text => (j => (Array.isArray(j) ? j : j.rows)[0])(JSON.parse(text));

export function report(r, manifest) {
  const n = `${Object.keys(manifest.files).length} files, ${Object.keys(manifest.app_js).length} app.js declarations, ${Object.keys(manifest.settings).length} settings`;
  if (r.intact) return [`FROZEN INSTRUMENT INTACT: ${n}, unchanged since the baseline ${manifest.baseline_commit} (start line ${manifest.start_line}); every file on the scan path and every app.js declaration classified.`];
  return [
    ...r.changed.map(c => `::error::FROZEN INSTRUMENT CHANGED: ${c}`),
    ...r.unclassified.map(u => `::error::UNCLASSIFIED ON THE SCAN PATH: ${u} -- frozen, or out with a reason, in ${SPEC}`),
    r.changed.length ? 'A CHANGE TO THE FROZEN INSTRUMENT ENDS THE FORWARD TEST if it stands: it restarts from a new start line, no splicing. Take it to the reviewer; do not fix it on the spot.' : 'An unclassified item may or may not reach a measured quantity: classify it before anything else.',
  ];
}

function main() {
  const arg = k => (i => (i < 0 ? null : process.argv[i + 1]))(process.argv.indexOf(k));
  const rev = arg('--rev'), r = rev ? revReader(rev) : treeReader();
  const spec = JSON.parse(readFileSync(path.join(ROOT, SPEC), 'utf8'));
  const setText = r.read(SETTINGS);
  if (!setText || r.read('app.js') == null) { console.log(`::error::FROZEN INSTRUMENT NOT CHECKED: could not read ${setText ? 'app.js' : SETTINGS}${rev ? ` at ${rev}` : ''}.`); process.exit(2); }
  if (process.argv.includes('--write-manifest')) {
    const head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT }).toString().trim();
    writeFileSync(path.join(ROOT, MANIFEST), JSON.stringify(buildManifest(r.read, spec, settingsRow(setText), head), null, 1) + '\n');
    console.log(`WROTE ${MANIFEST} at baseline ${head}.`); return;
  }
  const manifest = JSON.parse(readFileSync(path.join(ROOT, MANIFEST), 'utf8'));
  const res = checkFreeze({ read: r.read, list: r.list, manifest, spec, settingsRow: settingsRow(setText) });
  for (const l of report(res, manifest)) console.log(l);
  const fl = rev ? { code: 0 } : floatRecord(manifest.start_line, Number(manifest.settings.float_threshold_shares));
  process.exit(!res.intact || fl.code === 1 ? 1 : fl.code);
}

// THE FLOAT TABLE (the reviewer, 2026-11-26): data, not instrument. Each rebuild since the start line on its own line;
// any rebuild that was not the scheduled builder's is an INTERVENTION, treated as a frozen-path change. Returns
// { code }: 0 recorded, 1 an intervention (red, named), 2 the builder's runs could not be read.
export function floatRecord(startLine, threshold, git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 1e9 }).toString(), gh = (...a) => execFileSync('gh', a, { cwd: ROOT }).toString()) {
  const commits = git('log', `--since=${startLine}`, '--format=%H|%an|%cI|%s', '--', FLOAT_TABLE).trim().split('\n').filter(Boolean)
    .map(l => { const [sha, author, date, ...s] = l.split('|'); return { sha, author, date, subject: s.join('|') }; }).reverse();
  let runs, runsError = null;
  try { runs = JSON.parse(gh('run', 'list', '--workflow', 'build-float-table.yml', '--limit', '100', '--json', 'databaseId,event,createdAt')); } catch (e) { runsError = String(e.message).split('\n')[0].slice(0, 160); runs = []; }
  console.log(commits.length ? `FLOAT TABLE REBUILDS since the start line: ${commits.length} (the table is data; its builder is frozen):` : `FLOAT TABLE: no rebuild since the start line ${startLine}.`);
  for (const c of commits) {
    const show = ref => { try { return JSON.parse(git('show', `${ref}:${FLOAT_TABLE}`)); } catch { return null; } };
    console.log(rebuildLine(c, floatDiff(show(`${c.sha}^`), show(c.sha), threshold), threshold));
  }
  const bad = interventions({ commits, runs, startLine });
  for (const b of bad) console.log(`::error::FLOAT TABLE INTERVENTION: ${b}. A rebuild that is not the scheduled one is a frozen-path change: take it to the reviewer.`);
  if (runsError) console.log(`::error::FLOAT TABLE TRIGGERS NOT CHECKED: the builder's runs could not be read (${runsError}).`);
  return { code: bad.length ? 1 : runsError ? 2 : 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
