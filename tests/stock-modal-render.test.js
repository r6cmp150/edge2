// tests/stock-modal-render.test.js — 2026-11-12. The standing render test owed since 4e71a4a (STATUS, "Owed, with a
// condition that enforces itself"; tests/stock-modal-edit-guard.test.js pinned openStockModal until it existed).
//
// openStockModal writes the Add button and, just before it, captures what the screen showed
// (state.appShowedOnScreen, read by the buy as appShowedAtBuy). It reads several of the function's own variables; one
// out of scope would throw, the catch would show "Failed to load data" INSTEAD of the Add button, and Roman could not
// buy. So this runs the REAL app (core/*.js, shell/registry.js, app.js, in index.html's order) in a Node VM with a
// fake DOM, replaces only the network (bars, Alpaca, Supabase) and the chart library, and renders the modal for the
// three footers: not held (+ Add to Portfolio), held (+ Record another buy), a pending order (+ Record another
// order). The app's own functions stay real, so a scope error in them still throws here.
// Node built-ins only (CI has no browser and no npm install).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { run, REPO_ROOT } = require('./_lib');

// CHANGED 2026-11-12, declared: the loader moved verbatim to tests/_app-vm.js (shared with the macro scan test).
const { loadApp, bars } = require('./_app-vm');

// CHANGED 2026-11-14, declared: two optional overrides (noSignal: no Signals-tab entry for the ticker; daily: the daily
// bars), for the short-history case. Existing cases pass neither.
async function renderModal({ ownedPosition = null, pending = null, noSignal = false, daily = null } = {}) {
  const { ctx, byId } = loadApp();
  vm.runInContext(`
    fetchSingleBars = async () => __bars.daily;
    fetchMinuteBars = async () => __bars.minute;
    fetchHourlyBars = async () => __bars.hourly;
    state.settings.alpacaKey = 'k'; state.settings.alpacaSecret = 's';
    state.signals = __noSignal ? [] : [__signal];
    state.portfolio = __portfolio;
  `, Object.assign(ctx, {
    __noSignal: noSignal,
    __bars: { daily: daily || bars(260, 86400000), minute: bars(390, 60000, Date.parse('2026-11-11T14:30:00Z')), hourly: bars(70, 3600000, Date.parse('2026-11-01T14:30:00Z')) },
    __signal: { ticker: 'XYZ', company: 'Xyz Corp', price: 5.12, todayChange: 2.1, score: 74, signal: 'BUY', rsi: 55, volRatio: 1.6, ma20: 4.9,
      target: 5.6, stop: 4.7, entry: 5.12, duration: '3-DAY', risk: 5, signalsFired: [], atr: 0.2, maPct: 4.5, priceRange: 0.4,
      volTrend: 'rising', meanReversion: null, scoringVersion: 2, scannedAt: Date.now() },
    __portfolio: [ownedPosition, pending].filter(Boolean),
  }));
  const errors = [];
  ctx.console.error = (...a) => errors.push(a.join(' '));
  await vm.runInContext(`openStockModal('XYZ')`, ctx);
  // state is a top-level const of the app's scripts, not a property of the context: read it inside
  const shown = vm.runInContext('state.appShowedOnScreen', ctx);
  return { ctx, shown, body: byId.get('stock-modal-body')?.innerHTML || '', footer: byId.get('stock-modal-footer')?.innerHTML || '', errors };
}

const held = { id: '1762900000000', ticker: 'XYZ', company: 'Xyz Corp', shares: 10, buyPrice: 4.9, buyDate: '2026-11-10', target: 5.6, stop: 4.6,
  duration: '3-DAY', scoreAtBuy: 70, orderType: 'market', filledAt: '2026-11-10T15:00:00Z', engineSource: 'EDGE', codeVersion: { app: '20261112002000', scoring: 2 } };
const pendingOrder = { ...held, id: '1762900000001', orderType: 'limit', filledAt: null };

(async () => {
// 2026-11-14: calcRSI returns null below 15 closes (it said 50). The modal's own fallback (no Signals-tab entry) is the
// one path where that null meets the core helpers. Handed null, classifyDuration reads null < 50 as true (WEEK, and
// so the hold window, target and stop) and calcRiskScore reads null < 30 as true (+2 risk). The modal hands them NaN,
// the scorer's "no RSI". Rendered for real: the RSI is said to be unmeasured, with the reason, and nothing else moves.
await run('no signal and 5 daily bars: the RSI is "not measured" with its reason, and no null reaches the duration or risk', async () => {
  const r = await renderModal({ noSignal: true, daily: bars(5, 86400000) });
  assert.ok(!/Failed to load data/.test(r.body) && r.errors.length === 0, `the modal failed: ${r.errors[0] || r.body.slice(0, 200)}`);
  const txt = r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(txt.includes('RSI (14-day) not measured — 5 daily closes came back, 15 needed'), txt.slice(txt.indexOf('Signal Breakdown'), txt.indexOf('Signal Breakdown') + 120));
  assert.ok(txt.includes('2–3 MKT DAYS') && !txt.includes('4–5 MKT DAYS'), 'a WEEK window from a null RSI: ' + txt.slice(txt.indexOf('WATCH'), txt.indexOf('WATCH') + 40));
  assert.ok(txt.includes('Risk 4/10'), 'two risk points from a null RSI: ' + txt.slice(txt.indexOf('Risk'), txt.indexOf('Risk') + 12));
  // positive control: with history, the RSI is measured and shown as a number
  const full = (await renderModal({ noSignal: true })).body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(/RSI \(14-day\) \d+\.\d — /.test(full) && !full.includes('not measured'), 'measured with 260 bars');
});

await run('not held: the modal renders with the Add button, and the capture of what it showed runs', async () => {
  const r = await renderModal();
  assert.ok(!/Failed to load data/.test(r.body), `the modal failed: ${r.body.slice(0, 300)}`);
  assert.ok(r.footer.includes(`onclick="openAddPortfolioModal('XYZ')">+ Add to Portfolio</button>`), 'the Add button');
  const a = r.shown;
  assert.ok(a && a.ticker === 'XYZ' && a.held === false && typeof a.renderedAt === 'string', 'the capture ran');
  assert.ok('gate' in a && 'daySuppressed' in a && 'score' in a && 'label' in a && a.scoreSource === 'scan', JSON.stringify(a));
  // 2026-11-12 (the scan price history): the modal carries its section, and the Add button is still there with it
  assert.ok(r.body.includes('Your recent scans of XYZ') && r.body.includes('id="scan-hist-modal"'), 'the scan history section');
});

await run('held: "Record another buy", and the capture says held', async () => {
  const r = await renderModal({ ownedPosition: held });
  assert.ok(!/Failed to load data/.test(r.body), r.body.slice(0, 300));
  assert.ok(r.footer.includes('✓ In Portfolio · + Record another buy'));
  assert.strictEqual(r.shown.held, true);
});

await run('a pending order: "Record another order", and the capture runs', async () => {
  const r = await renderModal({ pending: pendingOrder });
  assert.ok(!/Failed to load data/.test(r.body), r.body.slice(0, 300));
  assert.ok(r.footer.includes('⏳ Order pending · + Record another order'));
  assert.strictEqual(r.shown.ticker, 'XYZ');
});

await run('the harness can fail: a variable out of scope in the capture shows "Failed to load data" and no Add button', async () => {
  // the control: the same render with the capture made to read a name that does not exist (the defect this test is
  // for), applied to the real source in memory. If this passed, the three renders above would prove nothing.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'app.js'), 'utf8');
  const broken = src.replace('daySuppressed: !!daySuppressed,', 'daySuppressed: !!notInScopeAnywhere,');
  assert.notStrictEqual(broken, src, 'the capture line to break');
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...a) => (String(p).endsWith(`${path.sep}app.js`) ? broken : real(p, ...a));
  try {
    const r = await renderModal();
    assert.ok(/Failed to load data/.test(r.body), 'the scope error reached the catch');
    assert.ok(!r.footer.includes('+ Add to Portfolio'), 'and there is no Add button');
  } finally { fs.readFileSync = real; }
});
})();
