#!/usr/bin/env node
// scripts/replay-scan.mjs — Playwright harness for the Warrior replay panel
// (docs/warrior-engine-spec-v2.md Phase 4/5's Developer Tools panel).
//
// Infrastructure, not a Phase 5 fix: drives the REAL app, in a REAL browser,
// against a REAL local server serving the working tree — the same DOM a
// human clicks through — instead of importing engines/warrior/setups.js
// directly and calling scanDateRangeForSetups() from Node. That distinction
// is the entire point: a Node-side call to that function would never have
// caught _renderReplaySymbolResult throwing on the bySetup shape change,
// because it never touches the render layer at all. This harness only
// proves what a human clicking through the real panel would actually see —
// and does it on every run, not just the one where someone happens to look.
//
// Usage:
//   npm run replay-scan -- --start 2026-08-21 --end 2026-08-25 --symbols HVII,AMIX --setups all
//
// --setups accepts a single real id (gap-and-go | hod-momentum | abcd |
// vwap-momentum | red-to-green) or "all" (the panel's own "All setups"
// option, ALL_SETUPS_ID). The panel's <select> is single-choice — there is
// no UI path to request an arbitrary subset of setups in one run, so this
// harness doesn't invent one either; running several single-setup subsets
// means running the command several times.
//
// Reads Alpaca credentials from .env.local (gitignored, never created by
// this script — see readEnvLocal() below for the exact required format).
// The key is never logged, echoed, or written into any artifact.

import { chromium } from 'playwright';
import http from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REAL_SETUP_IDS = ['gap-and-go', 'hod-momentum', 'abcd', 'vwap-momentum', 'red-to-green'];

// ── CLI args ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const hasVal = i + 1 < argv.length && !argv[i + 1].startsWith('--');
      out[key] = hasVal ? argv[++i] : true;
    }
  }
  return out;
}

function validateArgs(args) {
  const errs = [];
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!args.start || !dateRe.test(args.start)) errs.push('--start YYYY-MM-DD is required');
  if (!args.end || !dateRe.test(args.end)) errs.push('--end YYYY-MM-DD is required');
  if (args.start && args.end && args.end < args.start) errs.push('--end must not be before --start');
  const symbols = (args.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) errs.push('--symbols SYM1,SYM2 is required');
  const setupsArg = args.setups;
  if (!setupsArg) errs.push('--setups is required (a real setup id, or "all")');
  else if (setupsArg !== 'all' && !REAL_SETUP_IDS.includes(setupsArg)) {
    errs.push(`--setups must be "all" or one of: ${REAL_SETUP_IDS.join(', ')} (got "${setupsArg}")`);
  }
  if (errs.length) {
    console.error('Invalid arguments:\n' + errs.map(e => `  - ${e}`).join('\n'));
    console.error('\nExample:\n  npm run replay-scan -- --start 2026-08-21 --end 2026-08-25 --symbols HVII,AMIX --setups all');
    process.exit(1);
  }
  return { start: args.start, end: args.end, symbols, classifierId: setupsArg === 'all' ? 'all-setups' : setupsArg };
}

// ── .env.local — Alpaca credentials, never created by this script ──────────
function readEnvLocal() {
  const envPath = path.join(REPO_ROOT, '.env.local');
  const helpText = [
    `Create ${envPath} by hand (it's gitignored — never commit real credentials).`,
    'It must contain exactly these two lines (no quotes, real values):',
    '',
    '  APCA_API_KEY_ID=<your alpaca key id>',
    '  APCA_API_SECRET_KEY=<your alpaca secret key>',
    '',
    'This file is only ever read by this local script, straight into the',
    "browser's localStorage before the app boots — it is never sent",
    'anywhere else and never logged.',
  ].join('\n');

  if (!existsSync(envPath)) {
    console.error(`Missing .env.local.\n\n${helpText}`);
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  if (!env.APCA_API_KEY_ID || !env.APCA_API_SECRET_KEY) {
    console.error(`.env.local exists but is missing a required key.\n\n${helpText}`);
    process.exit(1);
  }
  return { alpacaKey: env.APCA_API_KEY_ID, alpacaSecret: env.APCA_API_SECRET_KEY };
}

// ── git identity — this is what half the past confusion was about ─────────
function gitInfo() {
  const run = (cmd) => execFileSync('git', cmd, { cwd: REPO_ROOT }).toString().trim();
  const sha = run(['rev-parse', '--short', 'HEAD']);
  const branch = run(['branch', '--show-current']);
  const dirty = run(['status', '--porcelain']).length > 0;
  return { sha, branch, dirty };
}

// ── Minimal static file server for the working tree, no build step ────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const safePath = path.normalize(urlPath).replace(/^([.][.][/\\])+/, '');
      const filePath = path.join(REPO_ROOT, safePath);
      if (!filePath.startsWith(REPO_ROOT) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
        res.writeHead(404); res.end('Not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ── Matrix / trigger flattening — turns the app's own result object into
//    the {date, symbol, setup, naive, reArmed, state, reason} shape asked
//    for, plus a separate flat list of every trigger's full detail row.
//    'missing' is not a state the app is supposed to produce — if it shows
//    up, that itself IS the finding (see the mechanical invariants below).
function flattenRangeScan(rangeScanResult) {
  const { setupIds, symbols, tradingDays, resultsByDate } = rangeScanResult;
  const cells = [];
  const triggers = [];
  for (const symbol of symbols) {
    for (const date of tradingDays) {
      const dayResult = resultsByDate[date]?.[symbol];
      if (!dayResult) {
        for (const setup of setupIds) cells.push({ date, symbol, setup, naive: null, reArmed: null, state: 'missing', reason: 'no result recorded for this symbol/day' });
        continue;
      }
      if (dayResult.notEvaluated) {
        for (const setup of setupIds) cells.push({ date, symbol, setup, naive: null, reArmed: null, state: 'not-evaluated', reason: dayResult.reason });
        continue;
      }
      for (const setup of setupIds) {
        const r = dayResult.bySetup?.[setup];
        if (!r) { cells.push({ date, symbol, setup, naive: null, reArmed: null, state: 'missing', reason: 'setup absent from bySetup for an evaluated day' }); continue; }
        cells.push({ date, symbol, setup, naive: r.naiveTriggers.length, reArmed: r.rearmedTriggers.length, state: r.rearmedTriggers.length > 0 ? 'fired' : 'zero', reason: null });
        for (const t of r.rearmedTriggers) triggers.push({ date, symbol, setup, ...t });
      }
    }
  }
  return { cells, triggers };
}

function flattenSingleDay(replayResult) {
  const cells = [];
  const triggers = [];
  const { dateStr, classifierId } = replayResult;
  for (const [symbol, r] of Object.entries(replayResult.resultsBySymbol)) {
    if (!r.bySetup) continue; // 'example' placeholder shape — not a real setup, nothing to flatten into this shape
    for (const [setup, sr] of Object.entries(r.bySetup)) {
      cells.push({ date: dateStr, symbol, setup, naive: sr.naiveTriggers.length, reArmed: sr.rearmedTriggers.length, state: sr.rearmedTriggers.length > 0 ? 'fired' : 'zero', reason: null });
      for (const t of sr.rearmedTriggers) triggers.push({ date: dateStr, symbol, setup, ...t });
    }
  }
  return { cells, triggers, classifierId };
}

// ── Mechanical invariants only — never a claim about whether a setup
//    SHOULD have fired. That line is deliberate: an assertion encoding
//    "ABCD should trigger on HVII on 2026-08-24" would carry the same
//    assumption a wrong classifier already carries, and would pass right
//    alongside it. These check only that the harness ran cleanly.
function checkInvariants({ pageErrors, consoleErrors, cells, tradingDaysCount, setupsCount, symbols }) {
  const failures = [];
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page exception(s)`);
  if (consoleErrors.length) failures.push(`${consoleErrors.length} console.error message(s)`);
  const badState = cells.filter(c => !['fired', 'zero', 'not-evaluated'].includes(c.state));
  if (badState.length) failures.push(`${badState.length} cell(s) in an unrecognized state: ${[...new Set(badState.map(c => c.state))].join(', ')}`);
  for (const symbol of symbols) {
    const count = cells.filter(c => c.symbol === symbol).length;
    const expected = tradingDaysCount * setupsCount;
    if (count !== expected) failures.push(`${symbol}: ${count} cell(s), expected ${tradingDaysCount} trading day(s) × ${setupsCount} setup(s) = ${expected}`);
  }
  return failures;
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const { start, end, symbols, classifierId } = validateArgs(parseArgs(process.argv.slice(2)));
  const { alpacaKey, alpacaSecret } = readEnvLocal();
  const git = gitInfo();

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${git.sha}${git.dirty ? '-dirty' : ''}`;
  const artifactDir = path.join(REPO_ROOT, 'artifacts', runId);
  mkdirSync(artifactDir, { recursive: true });
  const tag = git.sha + (git.dirty ? '-dirty' : '');
  const outPath = (name) => path.join(artifactDir, `${name}_${tag}.json`);

  console.log(`[replay-scan] branch=${git.branch} sha=${git.sha}${git.dirty ? ' (DIRTY working tree)' : ''}`);
  console.log(`[replay-scan] range ${start} -> ${end}, symbols ${symbols.join(',')}, setups ${classifierId}`);

  const server = await startStaticServer();
  const port = server.address().port;
  console.log(`[replay-scan] serving working tree at http://127.0.0.1:${port}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();

  const consoleLogs = [];
  const pageErrors = [];
  const failedRequests = [];
  const alpacaRequests = [];
  page.on('console', (msg) => consoleLogs.push({ type: msg.type(), text: msg.text(), t: Date.now() }));
  page.on('pageerror', (err) => pageErrors.push({ message: err.message, stack: err.stack, t: Date.now() }));
  page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), failure: req.failure()?.errorText, t: Date.now() }));
  page.on('request', (req) => {
    if (req.url().includes('data.alpaca.markets')) alpacaRequests.push({ url: req.url(), method: req.method(), t: Date.now() });
  });

  await page.addInitScript(({ alpacaKey, alpacaSecret }) => {
    try {
      sessionStorage.setItem('edge2_pin_verified', 'true');
      localStorage.setItem('edge_apiKeys', JSON.stringify({ alpacaKey, alpacaSecret, groqKey: '' }));
      localStorage.setItem('edge_localOnlySettings', JSON.stringify({ developerTools: true, riskPerTradePct: 2 }));
    } catch (e) { /* localStorage unavailable — app's own boot will surface this */ }
  }, { alpacaKey, alpacaSecret });

  let appVersion = null;
  let exitCode = 0;
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 30000 });
    appVersion = await page.evaluate(() => (typeof VERSION !== 'undefined' ? VERSION : null));

    await page.waitForSelector('[data-tab="warrior"]', { timeout: 20000 });
    // Engine loads via dynamic import() — wait for register() to have run
    // (window.warriorStopScanInterval only exists after it has) before
    // touching anything Warrior-specific.
    await page.waitForFunction(() => typeof window.warriorStopScanInterval === 'function', { timeout: 20000 });
    await page.evaluate(() => window.warriorStopScanInterval());

    await page.click('[data-tab="warrior"]');
    await page.waitForSelector('#warrior-replay-classifier', { timeout: 20000 });

    await page.selectOption('#warrior-replay-classifier', classifierId);
    await page.fill('#warrior-replay-date', start);
    await page.fill('#warrior-replay-end-date', end);
    await page.fill('#warrior-replay-symbols', symbols.join(', '));
    await page.evaluate(() => window.warriorUpdateReplayEstimate());

    const beforeSnapshot = await page.evaluate(() => JSON.stringify(window.__warriorReplayDebug || null));

    const runButton = page.locator('#warrior-replay-panel button.btn-primary');
    await runButton.click();
    // Two-click confirm flow for ranges/counts over the panel's own soft
    // thresholds — only fires for a big enough range; harmless no-op check
    // for a small one.
    await page.waitForTimeout(250);
    const label = await runButton.innerText().catch(() => '');
    if (/Confirm/i.test(label)) await runButton.click();

    console.log('[replay-scan] scan running…');
    await page.waitForFunction((before) => {
      const d = window.__warriorReplayDebug;
      if (!d || d.rangeScanInFlight || d.replayInFlight) return false;
      const after = JSON.stringify(d.lastRangeScanResult || d.lastReplayResult || null);
      return after !== before;
    }, beforeSnapshot, { timeout: 180000 });

    const debugData = await page.evaluate(() => window.__warriorReplayDebug);
    await page.locator('#warrior-replay-panel').screenshot({ path: path.join(artifactDir, `panel_${tag}.png`) });
    console.log(`[replay-scan] screenshot: ${path.join(artifactDir, `panel_${tag}.png`)}`);

    const isRange = !!debugData.lastRangeScanResult;
    const flattened = isRange ? flattenRangeScan(debugData.lastRangeScanResult) : flattenSingleDay(debugData.lastReplayResult);
    const appReportedRequests = isRange ? debugData.lastRangeScanResult.requests : debugData.lastReplayResult.requests;
    const setupsCount = isRange ? debugData.lastRangeScanResult.setupIds.length : Object.keys(Object.values(debugData.lastReplayResult.resultsBySymbol)[0]?.bySetup || {}).length;
    const tradingDaysCount = isRange ? debugData.lastRangeScanResult.tradingDays.length : 1;

    const consoleErrors = consoleLogs.filter(c => c.type === 'error');
    const failures = checkInvariants({ pageErrors, consoleErrors, cells: flattened.cells, tradingDaysCount, setupsCount, symbols });

    const meta = {
      git, appVersion, port,
      args: { start, end, symbols, setups: classifierId },
      isRange, cancelled: isRange ? !!debugData.lastRangeScanResult.cancelled : false,
      tradingDays: isRange ? debugData.lastRangeScanResult.tradingDays : [start],
      setupIds: isRange ? debugData.lastRangeScanResult.setupIds : Object.keys(Object.values(debugData.lastReplayResult.resultsBySymbol)[0]?.bySetup || {}),
      requests: { appReported: appReportedRequests, observedOnWire_wholeSession: alpacaRequests.length },
      cellCount: flattened.cells.length,
      triggerCount: flattened.triggers.length,
      invariantFailures: failures,
    };

    writeFileSync(outPath('meta'), JSON.stringify(meta, null, 2));
    writeFileSync(outPath('matrix'), JSON.stringify(flattened.cells, null, 2));
    writeFileSync(outPath('triggers'), JSON.stringify(flattened.triggers, null, 2));
    writeFileSync(outPath('console'), JSON.stringify(consoleLogs, null, 2));
    writeFileSync(outPath('errors'), JSON.stringify({ pageErrors, failedRequests }, null, 2));
    writeFileSync(outPath('requests'), JSON.stringify(alpacaRequests, null, 2));

    console.log(`[replay-scan] artifacts written to ${artifactDir}`);
    console.log(`[replay-scan] cells=${meta.cellCount} triggers=${meta.triggerCount} requests(app-reported)=${appReportedRequests} requests(observed on wire, whole session)=${alpacaRequests.length}`);

    if (failures.length) {
      console.error(`[replay-scan] MECHANICAL INVARIANT FAILURE(S):\n${failures.map(f => `  - ${f}`).join('\n')}`);
      exitCode = 1;
    } else {
      console.log('[replay-scan] all mechanical invariants held (page loaded, zero uncaught exceptions, zero console errors, cell count matches, no unrecognized cell state).');
    }
  } catch (err) {
    console.error(`[replay-scan] harness failed: ${err.message}`);
    try {
      writeFileSync(outPath('console'), JSON.stringify(consoleLogs, null, 2));
      writeFileSync(outPath('errors'), JSON.stringify({ pageErrors, failedRequests, harnessError: err.message }, null, 2));
      await page.screenshot({ path: path.join(artifactDir, `failure_${tag}.png`), fullPage: true }).catch(() => {});
    } catch (e) { /* best-effort — the harness's own crash already has priority */ }
    exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(exitCode);
}

main();
