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

// §7.7: a gate on ADVICE is never a gate on the ACTION (corrected
// 2026-10-27). Inside a gate window the card strip and the modal banner are
// the advice. The footer is the ordinary Add, with no relabel and no confirm.
// From 10-21 to 10-27 the footer read "+ Record a trade already placed"
// behind a browser confirm, which removed the ordinary add and made a
// suggestion the heaviest interruption on the page.
run('entry gate: the footer is the ordinary Add inside a gate window; the banner is the advice', () => {
  const src = readSource('app.js');
  const footer = src.match(/getElementById\('stock-modal-footer'\)\.innerHTML = [\s\S]*?`;\n/)[0];
  assert.ok(!/\bdisabled\b/.test(footer), 'no disabled button anywhere in the stock modal footer');
  assert.ok(!/addBlockReason|Record a trade already placed|addPortfolioDespiteAdvice/.test(src), 'the gated relabel and its confirm are gone');
  assert.ok(footer.includes(`<button class="btn btn-success" style="flex:1" onclick="openAddPortfolioModal('\${ticker}')">+ Add to Portfolio</button>`), 'normal styling, normal behaviour');
  // The footer offers exactly three branches: held, pending, and the ordinary Add.
  assert.strictEqual((footer.match(/\? `/g) || []).length, 2, 'held ? ... : pending ? ... : ordinary Add');
  // The advice itself is untouched.
  assert.ok(src.includes('⛔ Entry gate: ${modalGate.label}') && src.includes('⚠ DAY trade — entry window has closed for today'), 'the modal banners stay');
});

// A held ticker or a pending order: a second lot opens the add form
// directly, with the reason shown IN the form. Holding a position is a fact,
// but it doesn't contradict buying more, so it isn't asked.
run('recording: "In Portfolio" and "Order pending" open the add form directly, with the reason as a note', () => {
  const src = readSource('app.js');
  const footer = src.match(/getElementById\('stock-modal-footer'\)\.innerHTML = [\s\S]*?`;\n/)[0];
  assert.strictEqual((footer.match(/onclick="openAddPortfolioModal\('\$\{ticker\}', \$\{JSON\.stringify\(lotReason\)/g) || []).length, 2, 'held and pending pass their reason to the form');
  assert.ok(!/recordAnotherLot/.test(src));
  assert.ok(src.includes('function openAddPortfolioModal(ticker, note = null) {'));
  assert.ok(src.includes('${note ? `<div class="add-form-note">${note}</div>` : \'\'}'), 'the reason is shown in the form');
  // The add form never pre-fills a price nobody observed.
  assert.ok(/price != null \? price\.toFixed\(2\) : ''/.test(src), 'add form price is empty, not 0.00, when there is no signal price');
});

// Confirm when the app knows a FACT that contradicts the action; never when
// it merely ADVISES against it (spec §7.7). The only confirm on the add path
// is the listing fact, and it's the app's own in-page overlay.
run('confirms: only the not-listed / not-tradable fact, in-page; after-hours advice is a note in the form', () => {
  const src = readSource('app.js');
  const i = src.indexOf('async function confirmAddPortfolio('); const confirmFn = src.slice(i, src.indexOf('\n}\n', i));
  assert.strictEqual((confirmFn.match(/showConfirm\(/g) || []).length, 1, 'one confirm on the add path');
  assert.ok(confirmFn.includes("showConfirm(listingWarningText(ticker, listing[ticker]), () => finalizeAddPortfolio(ticker, shares, price, date, btn, order), 'Add anyway');"), 'it is the listing fact, and Add anyway proceeds');
  assert.ok(!/buildAfterHoursWarningText|classifySession/.test(confirmFn), 'after-hours advice is not a confirm');
  assert.ok(src.includes('${addFormSessionAdviceHtml(today)}'), 'after-hours advice is shown in the add form');
  const j = src.indexOf('function addFormSessionAdviceHtml('); const adv = src.slice(j, src.indexOf('\n}\n', j));
  assert.ok(adv.includes('buildAfterHoursWarningText()') && /AFTER_HOURS.*PRE_MARKET/.test(adv));
});

// No browser dialog anywhere: confirm() or alert() blocks the page, renders
// as "<host> says", and on a phone is indistinguishable from a scam prompt.
// Asking uses showConfirm and telling uses showAlert, both in-page.
run('no browser confirm() or alert() anywhere in the app', () => {
  const fs = require('fs'); const path = require('path');
  const files = ['app.js', ...['core', 'shell', 'engines/warrior'].flatMap(d => fs.readdirSync(path.join(__dirname, '..', d)).filter(f => f.endsWith('.js')).map(f => `${d}/${f}`))];
  for (const f of files) {
    const code = readSource(f).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert.ok(!/(^|[^\w.])(window\.)?confirm\s*\(/.test(code), `${f} calls the browser confirm()`);
    assert.ok(!/(^|[^\w.])(window\.)?alert\s*\(/.test(code), `${f} calls the browser alert(): use showAlert`);
  }
});

// In-page dialogs QUEUE, never replace (2026-10-27). alert() serialised
// its messages, so call sites were written against "every message is seen".
// A notice that overwrote the previous one would drop the earlier message
// unread, and one landing on an open confirm would drop its action.
function loadDialogs() {
  const src = readSource('app.js');
  const block = src.slice(src.indexOf('const _dialogQueue = [];'), src.indexOf('function confirmAction() {'));
  const caI = src.indexOf('function confirmAction() {');
  const el = (cls = '') => { const c = new Set(cls.split(' ').filter(Boolean)); return { textContent: '', className: cls, classList: { add: x => c.add(x), remove: x => c.delete(x), has: x => c.has(x) } }; };
  const ui = { overlay: el('modal-overlay hidden'), msg: el(), btn: el('btn-danger'), cancel: el('btn-ghost') };
  ui.overlay.querySelector = () => ui.cancel;
  global.document = { getElementById: id => ({ 'confirm-overlay': ui.overlay, 'confirm-msg': ui.msg, 'confirm-btn': ui.btn }[id] || null) };
  global.state = {};
  ui.toasts = []; global.showGlobalErrorToast = m => ui.toasts.push(m);
  // eslint-disable-next-line no-eval
  eval(block + src.slice(caI, src.indexOf('\n}\n', caI) + 2) +
    '\nglobal.__alert = showAlert; global.__confirm = showConfirm; global.__ok = confirmAction; global.__cancel = closeConfirm;');
  ui.shown = () => (ui.overlay.classList.has('hidden') ? null : ui.msg.textContent);
  return ui;
}

run('dialogs: a notice is in-page, one OK button; a confirm has its Cancel', () => {
  const ui = loadDialogs();
  global.__alert('Enter sale price.');
  assert.strictEqual(ui.shown(), 'Enter sale price.');
  assert.ok(ui.btn.textContent === 'OK' && ui.cancel.classList.has('hidden') && global.state._confirmCb === null);
  global.__ok();
  assert.strictEqual(ui.shown(), null, 'OK closes it');
  global.__confirm('Not tradable.', () => {}, 'Add anyway');
  assert.ok(ui.shown() === 'Not tradable.' && !ui.cancel.classList.has('hidden') && ui.btn.textContent === 'Add anyway' && ui.btn.className === 'btn-danger');
});

run('dialogs: two notices in quick succession are both seen, in order', () => {
  const ui = loadDialogs();
  global.__alert('first'); global.__alert('second');
  assert.strictEqual(ui.shown(), 'first', 'the second does not replace the first');
  global.__ok();
  assert.strictEqual(ui.shown(), 'second');
  global.__ok();
  assert.strictEqual(ui.shown(), null);
});

run('dialogs: a notice landing on an open confirm waits; the confirm keeps its action', () => {
  const ui = loadDialogs();
  let added = 0;
  global.__confirm('Not tradable.', () => { added++; }, 'Add anyway');
  global.__alert('Could not save setting.');
  assert.strictEqual(ui.shown(), 'Not tradable.', 'the confirm stays up');
  assert.strictEqual(ui.btn.textContent, 'Add anyway');
  global.__ok();
  assert.strictEqual(added, 1, '"Add anyway" still runs: the late notice did not drop it');
  assert.strictEqual(ui.shown(), 'Could not save setting.', 'then the notice');
});

run("dialogs: a notice raised by a confirm's own action shows next; Cancel runs nothing and moves on", () => {
  const ui = loadDialogs();
  global.__confirm('Delete?', () => global.__alert('Done.'), 'Delete');
  global.__alert('queued behind');
  global.__ok();
  assert.strictEqual(ui.shown(), 'queued behind', 'FIFO: the earlier queued notice first');
  global.__ok();
  assert.strictEqual(ui.shown(), 'Done.', 'then the one the action raised');
  global.__ok();
  let ran = false;
  global.__confirm('Really?', () => { ran = true; });
  global.__alert('after cancel');
  global.__cancel();
  assert.strictEqual(ran, false);
  assert.strictEqual(ui.shown(), 'after cancel');
});

run('dialogs: before the app shell exists, every message is a toast (none dropped, no browser dialog)', () => {
  const ui = loadDialogs();
  global.document = { getElementById: () => null };
  global.__alert('early one'); global.__alert('early two');
  assert.deepStrictEqual(ui.toasts, ['early one', 'early two']);
  // Several queued behind a showing dialog, then the shell goes (boot swaps
  // document.body): every queued one still reaches a toast.
  const ui2 = loadDialogs();
  global.__alert('a'); global.__alert('b'); global.__alert('c');
  global.document = { getElementById: () => null };
  global.__ok();
  assert.deepStrictEqual(ui2.toasts, ['b', 'c'], 'the whole queue drains, not just the next one');
});

run('dialogs: an action that throws still closes its dialog and moves the queue on', () => {
  const ui = loadDialogs();
  global.__confirm('Add?', () => { throw new Error('save failed'); }, 'Add anyway');
  global.__alert('next');
  assert.throws(() => global.__ok(), /save failed/);
  assert.strictEqual(ui.shown(), 'next', 'never stuck on a dead dialog');
});
