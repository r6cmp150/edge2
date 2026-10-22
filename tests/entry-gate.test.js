// tests/entry-gate.test.js — core/entry-gate.js (phase-10 spec §7.4/§7.6
// step 1/§7.7). Pins the window boundaries, the early-close day, the
// weekend/holiday/overnight CLOSED cases, the open-and-logged windows
// (PRE_MARKET, 6:30-7:00), view-time evaluation, and the rule that a gate on
// advice is never a gate on recording.
'use strict';
const assert = require('assert');
const { readSource, evalModule, run } = require('./_lib');

const RealDate = Date;
function at(iso, fn) { // freeze "now" for getPT()/new Date()
  const t = new RealDate(iso).getTime();
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [t])); } static now() { return t; } };
  try { return fn(); } finally { global.Date = RealDate; }
}

global.state = { settings: {} };
evalModule(readSource('core/clock.js'), { expose: ['getPT', 'ptDateStr', 'classifySession', 'ptWallClockToInstant'] });
evalModule(readSource('core/entry-gate.js'), { expose: ['entryGateAt', 'entryGateNow'] });
const G = (d, t) => global.entryGateAt(d, t);
const pick = g => `${g.gated}/${g.rule}/${g.logged}`;

run('entry gate: boundaries on an ordinary weekday (Wed 2026-10-21)', () => {
  const d = '2026-10-21';
  const cases = {
    '00:30': 'true/CLOSED/null',          // overnight (5pm-1am PT is CLOSED)
    '01:00': 'false/null/PRE_MARKET',     // open and logged
    '06:29': 'false/null/PRE_MARKET',
    '06:30': 'false/null/OPEN_6_30_7_00', // open and logged: unjudgeable, not good
    '06:59': 'false/null/OPEN_6_30_7_00',
    '07:00': 'true/FIRST_HOUR/null',
    '07:29': 'true/FIRST_HOUR/null',
    '07:30': 'false/null/null',
    '12:59': 'false/null/null',
    '13:00': 'true/AFTER_HOURS/null',
    '16:59': 'true/AFTER_HOURS/null',
    '17:00': 'true/CLOSED/null',
    '23:59': 'true/CLOSED/null',
  };
  for (const [t, want] of Object.entries(cases)) assert.strictEqual(pick(G(d, t)), want, `${d} ${t}`);
});

run('entry gate: Saturday, holiday and the early-close day', () => {
  assert.strictEqual(pick(G('2026-10-24', '10:00')), 'true/CLOSED/null', 'Saturday mid-morning is CLOSED');
  assert.strictEqual(pick(G('2026-10-25', '16:16')), 'true/CLOSED/null', 'Sunday evening (the 2026-09-27 shape)');
  assert.strictEqual(pick(G('2026-11-26', '09:00')), 'true/CLOSED/null', 'Thanksgiving is CLOSED');
  // 2026-11-27 closes at 10:00 PT: the first-hour rule still applies inside
  // REGULAR, and after-hours starts at the early close, not 13:00.
  assert.strictEqual(pick(G('2026-11-27', '07:10')), 'true/FIRST_HOUR/null');
  assert.strictEqual(pick(G('2026-11-27', '09:59')), 'false/null/null');
  assert.strictEqual(pick(G('2026-11-27', '10:00')), 'true/AFTER_HOURS/null', 'early close: AH from 10:00');
  assert.strictEqual(pick(G('2026-11-27', '12:00')), 'true/AFTER_HOURS/null');
});

run('entry gate: gated exactly when AH, CLOSED, or REGULAR 7:00-7:30 -- every minute, several day types', () => {
  for (const d of ['2026-10-21', '2026-10-24', '2026-11-26', '2026-11-27', '2026-12-24']) {
    for (let m = 0; m < 1440; m++) {
      const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const s = global.classifySession(d, t);
      const expect = s === 'AFTER_HOURS' || s === 'CLOSED' || (s === 'REGULAR' && m >= 420 && m < 450);
      const g = G(d, t);
      assert.strictEqual(g.gated, expect, `${d} ${t} (${s})`);
      assert.ok(!(g.gated && g.logged), `${d} ${t}: never both gated and logged`);
      assert.strictEqual(g.gated, g.label != null, `${d} ${t}: a gated result always carries its label`);
    }
  }
});

run('entry gate: entryGateNow evaluates the PT wall clock at view time', () => {
  const d = '2026-10-21';
  for (const [hh, mm, rule] of [[7, 5, 'FIRST_HOUR'], [7, 45, null], [13, 30, 'AFTER_HOURS'], [21, 0, 'CLOSED']]) {
    const instant = global.ptWallClockToInstant(d, hh, mm).toISOString();
    at(instant, () => assert.strictEqual(global.entryGateNow().rule, rule, `${d} ${hh}:${mm}`));
  }
});

// §7.7: a gate on advice must never be a gate on recording.
run('entry gate: recording is never disabled -- the Add button only ever confirms', () => {
  const src = readSource('app.js');
  assert.ok(!/disabled[^>]*>\s*\+ Add to Portfolio/.test(src), 'no disabled "+ Add to Portfolio" button anywhere in app.js');
  assert.ok(/addBlockReason \? `[\s\S]*?onclick="addPortfolioDespiteAdvice\(/.test(src), 'gated/DAY-suppressed footer routes through the confirm');
  const fn = src.match(/function addPortfolioDespiteAdvice\([^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'addPortfolioDespiteAdvice present');
  let opened = null;
  global.openAddPortfolioModal = t => { opened = t; };
  global.window = global.window || {};
  // eslint-disable-next-line no-eval
  eval(fn[0] + '\nglobal.__add = addPortfolioDespiteAdvice;');
  global.window.confirm = () => false;
  global.__add('SNAP', 'Entry gate: 7:00–7:30 PT — not a buy window.');
  assert.strictEqual(opened, null, 'declining the confirm opens nothing');
  global.window.confirm = () => true;
  global.__add('SNAP', 'Entry gate: 7:00–7:30 PT — not a buy window.');
  assert.strictEqual(opened, 'SNAP', 'confirming opens the normal add form');
});

// Same rule for a held ticker or a pending order: a second lot is
// recordable behind a confirm, never a disabled button.
run('recording: "In Portfolio" and "Order pending" record another lot behind a confirm', () => {
  const src = readSource('app.js');
  const footer = src.match(/getElementById\('stock-modal-footer'\)\.innerHTML = [\s\S]*?`;\n/);
  assert.ok(footer, 'stock modal footer found');
  assert.ok(!/\bdisabled\b/.test(footer[0]), 'no disabled button anywhere in the stock modal footer');
  assert.strictEqual((footer[0].match(/recordAnotherLot\(/g) || []).length, 2, 'both held and pending route through recordAnotherLot');
  const fn = src.match(/function recordAnotherLot\([^)]*\) \{[\s\S]*?\n\}/);
  let opened = null;
  global.openAddPortfolioModal = t => { opened = t; };
  // eslint-disable-next-line no-eval
  eval(fn[0] + '\nglobal.__lot = recordAnotherLot;');
  global.window.confirm = () => false; global.__lot('GO', 'You already hold 75 shares of GO.');
  assert.strictEqual(opened, null);
  global.window.confirm = () => true; global.__lot('GO', 'You already hold 75 shares of GO.');
  assert.strictEqual(opened, 'GO');
  // The add form never pre-fills a price nobody observed.
  assert.ok(/price != null \? price\.toFixed\(2\) : ''/.test(src), 'add form price is empty, not 0.00, when there is no signal price');
});
