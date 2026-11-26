// tests/instrument-freeze.test.js -- 2026-11-25. THE INSTRUMENT IS FROZEN for the forward test (STATUS). The declaration's
// list (data/forward-test/instrument-freeze-spec.json) and the detector's manifest cannot drift apart; nothing on the
// scan path is classified nowhere; the frozen instrument is intact in this tree (a frozen change turns CI red too); and
// the one difference since the start line is the audited, recorded-and-unused line.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { run, REPO_ROOT, readSource } = require('./_lib');

(async () => {
const L = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/instrument-freeze.mjs')).href);
const D = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/check-instrument-freeze.mjs')).href);
const spec = JSON.parse(readSource(D.SPEC)), manifest = JSON.parse(readSource(D.MANIFEST));
const app = readSource('app.js');
const outNames = Object.values(spec.app_js.out).flatMap(g => g.names);

await run('every app.js declaration is classified exactly once: frozen, or out with its group reason', () => {
  assert.deepStrictEqual(L.duplicates(app), [], 'a duplicated top-level name would make a by-name hash ambiguous');
  assert.strictEqual(new Set(outNames).size, outNames.length, 'a name in two out groups');
  for (const g of Object.values(spec.app_js.out)) assert.ok(g.reason && g.reason.length > 30, 'every out group carries its reason');
  assert.deepStrictEqual(spec.app_js.roots.filter(r => outNames.includes(r)), [], 'a root cannot be declared out');
  const frozen = new Set(Object.keys(manifest.app_js));
  const none = L.chunks(app).map(c => c.name).filter(n => !frozen.has(n) && !outNames.includes(n));
  assert.deepStrictEqual(none, [], 'unclassified declarations');
  assert.deepStrictEqual([...frozen].filter(n => outNames.includes(n)), [], 'frozen and out at once');
});

await run('the manifest IS the declaration: its frozen list equals what the spec derives, so they cannot drift', () => {
  assert.deepStrictEqual(Object.keys(manifest.app_js), L.frozenDeclarations(app, spec));
  assert.deepStrictEqual(Object.keys(manifest.files), Object.keys(spec.files.frozen).sort());
  assert.deepStrictEqual(Object.keys(manifest.settings), spec.settings.frozen);
  assert.ok(Object.keys(manifest.app_js).length > 100, 'the scan, buy, sale and exit-advice paths');
  for (const n of ['runScreener', 'writeRatingSnapshots', 'getDisplayThreshold', 'getFilteredSignals', 'finalizeAddPortfolio', 'confirmMarkSold', 'writeTradeToSupabase', 'calcUnifiedRecommendation', 'RATING_SNAPSHOT_MIN_SCORE', 'TICKERS'])
    assert.ok(n in manifest.app_js, `${n} is frozen`);
});

await run('every file on the scan path is classified, and every script index.html loads is on the list', () => {
  const { list } = D.treeReader(REPO_ROOT);
  for (const p of ['core/edge-scoring.js', 'core/edgar.js', 'engines/warrior/gate.js', 'shell/registry.js', 'app.js', 'index.html', 'sw.js']) assert.ok(list().includes(p), `${p} is on the listed scan path`);
  const known = new Set([...Object.keys(spec.files.frozen), ...Object.keys(spec.files.partial), ...Object.keys(spec.files.out)]);
  assert.deepStrictEqual(list().filter(p => !known.has(p)), []);
  const scripts = [...readSource('index.html').matchAll(/<script src="([^"?]+)/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
  assert.ok(scripts.length >= 15);
  for (const s of scripts) assert.ok(known.has(s), `${s} is loaded by the app but classified nowhere`);
  assert.deepStrictEqual(scripts.filter(s => s in spec.files.out).sort(), ['core/execution-mode-count.js', 'core/scan-history.js'], 'the loaded scripts declared out: the budget bar and the scan-history line, no others');
  for (const p of Object.keys(spec.files.frozen)) assert.ok(fs.existsSync(path.join(REPO_ROOT, p)), `${p} exists`);
  for (const [p, why] of Object.entries(spec.files.out)) assert.ok(why.length > 20, `${p} carries its reason`);
});

await run('THE TRIPWIRE: the frozen instrument is intact in this tree (a frozen change, an unclassified item or a changed setting fails here)', () => {
  const t = D.treeReader(REPO_ROOT);
  const r = L.checkFreeze({ read: t.read, list: t.list, manifest, spec, settingsRow: D.settingsRow(readSource(D.SETTINGS)) });
  assert.ok(r.intact, D.report(r, manifest).join('\n'));
});

await run('since the start line, the only frozen difference is the audited recorded-and-unused line (3d462e5)', () => {
  const r = D.revReader(spec.start_line_commit, REPO_ROOT);
  const res = L.checkFreeze({ read: r.read, list: r.list, manifest, spec, settingsRow: D.settingsRow(r.read(D.SETTINGS)) });
  assert.deepStrictEqual(res.changed, ['app.js finalizeAddPortfolio']);
  const before = L.chunks(r.read('app.js')).find(c => c.name === 'finalizeAddPortfolio').text.split('\n');
  const now = L.chunks(app).find(c => c.name === 'finalizeAddPortfolio').text.split('\n');
  assert.deepStrictEqual(before.filter(l => !now.includes(l)), [], 'nothing removed');
  assert.deepStrictEqual(now.filter(l => !before.includes(l)), ['  if (signalSnapshotAtBuy) signalSnapshotAtBuy.appListAtBuy = appListAtBuy(); // recorded and unused (capture-not-consume)']);
});

await run('the detector: a frozen change, a new declaration, a new file and a setting are each named; display, comments and stamps are not', () => {
  const t = D.treeReader(REPO_ROOT), row = D.settingsRow(readSource(D.SETTINGS));
  const withApp = (src, extra = []) => ({ read: p => (p === 'app.js' ? src : t.read(p)), list: () => [...t.list(), ...extra] });
  const chk = (rd, s = row) => L.checkFreeze({ ...rd, manifest, spec, settingsRow: s });
  const frozenChanged = app.replace('const minP2 = state.settings.includeUnder2 ? 0 : 2;', 'const minP2 = state.settings.includeUnder2 ? 0 : 1;');
  assert.notStrictEqual(frozenChanged, app);
  assert.deepStrictEqual(chk(withApp(frozenChanged)).changed, ['app.js runScreener']);
  const newDecl = chk(withApp(app + '\nfunction brandNew() { return 1; }\n'));
  assert.deepStrictEqual(newDecl.unclassified, ['app.js brandNew']); assert.strictEqual(newDecl.intact, false, 'unclassified is not intact');
  const newFile = chk(withApp(app, ['core/new-thing.js']));
  assert.deepStrictEqual(newFile.unclassified, ['core/new-thing.js']); assert.strictEqual(newFile.intact, false);
  assert.deepStrictEqual(chk(withApp(app), { ...row, min_volume: 50000 }).changed, ['setting min_volume: 100000 -> 50000']);
  // execution_mode, frozen 2026-11-26: a switch to live ends the test; a switch and a switch back moves its timestamp
  assert.strictEqual(manifest.settings.execution_mode, 'paper');
  assert.deepStrictEqual(chk(withApp(app), { ...row, execution_mode: 'live' }).changed, ['setting execution_mode: "paper" -> "live"']);
  assert.deepStrictEqual(chk(withApp(app), { ...row, execution_mode_set_at: '2026-12-01T15:00:00Z' }).changed, ['setting execution_mode_set_at: "2026-11-12T15:24:10.854+00:00" -> "2026-12-01T15:00:00Z"']);
  assert.ok(!('execution_mode' in spec.settings.out) && /recording IS the trade/.test(spec.settings.why_execution_mode));
  const displayOnly = app.replace("<p>Tap Refresh to run your first scan.</p>", "<p>Tap Refresh to scan.</p>");
  assert.notStrictEqual(displayOnly, app); assert.ok(chk(withApp(displayOnly)).intact, 'renderSignalsTab is display');
  const commentOnly = app.replace('async function runScreener() {', 'async function runScreener() { // a comment');
  assert.notStrictEqual(commentOnly, app); assert.ok(chk(withApp(commentOnly)).intact, 'a comment is not a change of instrument');
  const stamp = { read: p => (p === 'index.html' ? t.read(p).replace(/\?v=\d+/g, '?v=29991231000000') : t.read(p)), list: t.list };
  assert.ok(chk(stamp).intact, 'a ?v= stamp is not a change of code');
  const html = { read: p => (p === 'index.html' ? t.read(p).replace('<script src="core/universe.js', '<script src="core/universe2.js') : t.read(p)), list: t.list };
  assert.deepStrictEqual(chk(html).changed, ['index.html'], 'which scripts load IS frozen');
});

await run('the comment stripper never removes code: no "//" after code inside a string, on any frozen file', () => {
  const files = ['app.js', ...Object.keys(spec.files.frozen).filter(p => p.endsWith('.js'))];
  const bad = [];
  for (const f of files) readSource(f).split('\n').forEach((l, i) => {
    const m = l.match(/(^|[^:\\'"`])\/\/.*$/); if (!m) return;
    const before = l.slice(0, m.index + m[1].length).replace(/\\./g, '');
    const odd = q => (before.split(q).length - 1) % 2 === 1;
    if (odd("'") || odd('"') || odd('`')) bad.push(`${f}:${i + 1}`);
  });
  assert.deepStrictEqual(bad, []);
});

await run('the closure follows a call written after an apostrophe in a template literal (the string-stripping defect)', () => {
  const src = "function root() {\n  const t = `Roman's pick`; callee();\n}\nfunction callee() {\n  return 1;\n}\n";
  assert.deepStrictEqual(L.closure(src, ['root']).sort(), ['callee', 'root']);
});

await run('the closure stops at an OUT declaration: what only display code calls is not pulled in through it', () => {
  const src = 'function root() {\n  view();\n}\nfunction view() {\n  helper();\n}\nfunction helper() {\n  return 1;\n}\n';
  assert.deepStrictEqual(L.closure(src, ['root'], ['view']).sort(), ['root', 'view']);
  assert.deepStrictEqual(L.closure(src, ['root']).sort(), ['helper', 'root', 'view']);
});

await run('normalize: comments and whitespace are not code; a URL is', () => {
  assert.strictEqual(L.normalize('a = 1; // note\n  /* block */ b = 2;'), 'a = 1; b = 2;');
  assert.strictEqual(L.normalize("u = 'https://x.y';"), "u = 'https://x.y';");
  assert.strictEqual(L.stripStamps('<script src="a.js?v=123"></script>'), '<script src="a.js"></script>');
});

await run('the daily line runs it after the backup, read-only, and turns the run red when it fails', () => {
  const y = readSource('.github/workflows/backup-tables.yml');
  const step = y.indexOf('node scripts/check-instrument-freeze.mjs'), backup = y.indexOf('name: Backup tables');
  assert.ok(step > backup && backup > 0, 'after the backup step (so it reads the fresh settings)');
  assert.ok(y.includes("if: always() && steps.instrument_freeze.outputs.exit_code != '0'"), 'a failing check fails the run');
});
})();
