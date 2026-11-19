// tests/boot-bounded.test.js -- 2026-11-19 (step 3 of the bounding order, the reviewer). Boot is the one place where
// the wait is the whole experience. The real runDataLoadAndInit (app.js): "Loading your data…" first; at 5 s with no
// answer, "Still loading — the database hasn't answered yet"; at the bound, "Couldn't load your data" with the reason
// and Retry; a load that answers in time clears the 5 s timer, so nothing is written into the app shell. And end to end:
// the real bounded loads (core/store.js) against a database that never answers reach the error screen, raced against a
// real timer. There is deliberately no fallback to a cached portfolio (app.js says why); nothing here adds one.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const store = readSource('core/store.js');
const fnOf = (src, name) => { const i = src.search(new RegExp(`^(async )?function ${name}\\(`, 'm')); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n}\n', i) + 3); };
const constOf = (src, name) => { const i = src.indexOf(`const ${name} =`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n', i) + 1); };

// A body that holds HTML as text, and finds the subtitle by id as the browser would.
function fakeDocument() {
  const document = {
    body: { innerHTML: '' },
    getElementById(id) {
      const re = new RegExp(`(<div[^>]*id="${id}"[^>]*>)([^<]*)(</div>)`);
      if (!re.test(document.body.innerHTML)) return null;
      return { set textContent(t) { document.body.innerHTML = document.body.innerHTML.replace(re, (_, a, __, c) => a + t + c); } };
    },
    addEventListener() {},
  };
  return document;
}
const subtitle = html => (html.match(/class="pin-subtitle"[^>]*>([^<]*)</) || [])[1];

// Virtual timers for the boot's own 5 s timer: nothing fires until advanced.
function virtualTimers() {
  let now = 0, id = 0; const pending = new Map(), cleared = [];
  return {
    setTimeout: (fn, ms) => { pending.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: i => { cleared.push(i); pending.delete(i); },
    advance(ms) { now += ms; for (const [i, t] of [...pending]) if (t.at <= now) { pending.delete(i); t.fn(); } },
    pending, cleared,
  };
}

const STUBS = ['clearLegacyPortfolioSettingsStorage', 'registerServiceWorker', 'startClock', 'startNotificationChecks', 'renderSignalsTab',
  'updateNavBadges', 'checkPositionsStillOpen', 'noteDataReadProblem', 'checkBuildStatus', 'refreshPortfolio', 'installLayoutCheck',
  'requestNotificationPermission', 'loadWarriorEngine', 'loadSoldFromSupabase', 'loadAnalysisPeriodsFromSupabase', 'showGlobalErrorToast'];
function boot(load, timers) {
  const document = fakeDocument();
  const stubs = STUBS.map(n => (/^load|^check/.test(n) ? async () => {} : () => {}));
  const src = constOf(app, 'BOOT_SLOW_MS') + constOf(app, 'BOOT_SLOW_TEXT') + fnOf(app, 'renderDataLoadingScreen') + fnOf(app, 'renderDataLoadErrorScreen')
    + fnOf(app, 'runDataLoadAndInit') + '\nreturn { runDataLoadAndInit, BOOT_SLOW_TEXT };';
  // eslint-disable-next-line no-new-func
  const m = new Function('document', 'setTimeout', 'clearTimeout', 'loadPortfolioAndSettingsFromSupabase', 'APP_SHELL_HTML', 'state', ...STUBS, src)(
    document, timers.setTimeout, timers.clearTimeout, load, '<main id="app-shell"></main>', { activeTab: 'signals' }, ...stubs);
  return { document, ...m };
}
const settle = () => new Promise(r => setImmediate(r));

run('boot with no answer: "Loading your data…", then the 5 s line, then the error screen with the reason and Retry', async () => {
  const timers = virtualTimers();
  let fail; const load = () => new Promise((_, rej) => { fail = rej; });
  const { document, runDataLoadAndInit, BOOT_SLOW_TEXT } = boot(load, timers);
  assert.strictEqual(BOOT_SLOW_TEXT, 'Still loading — the database hasn\'t answered yet');
  const done = runDataLoadAndInit();
  assert.strictEqual(subtitle(document.body.innerHTML), 'Loading your data…');
  timers.advance(4999);
  assert.strictEqual(subtitle(document.body.innerHTML), 'Loading your data…', 'not before 5 s');
  timers.advance(1);
  assert.strictEqual(subtitle(document.body.innerHTML), BOOT_SLOW_TEXT, 'at 5 s');
  fail(new Error('the settings read: no answer within 15 s'));
  await done;
  const html = document.body.innerHTML;
  assert.strictEqual(subtitle(html), 'Couldn\'t load your data');
  assert.ok(html.includes('the settings read: no answer within 15 s'), 'the reason is shown');
  assert.ok(/<button[^>]*onclick="retryDataLoad\(\)"[^>]*>Retry<\/button>/.test(html), 'Retry is offered');
  assert.ok(!html.includes('app-shell'), 'no app, no fallback');
});

run('a load that answers before 5 s clears the timer: nothing is written into the app shell', async () => {
  const timers = virtualTimers();
  const { document, runDataLoadAndInit } = boot(async () => {}, timers);
  await runDataLoadAndInit();
  assert.strictEqual(document.body.innerHTML, '<main id="app-shell"></main>');
  assert.strictEqual(timers.pending.size, 0, 'the 5 s timer was cleared');
  assert.strictEqual(timers.cleared.length, 1);
  timers.advance(60000);
  assert.strictEqual(document.body.innerHTML, '<main id="app-shell"></main>');
});

run('a load that fails before 5 s clears the timer too: the error screen is not overwritten', async () => {
  const timers = virtualTimers();
  const { document, runDataLoadAndInit } = boot(async () => { throw new Error('the portfolio read: denied'); }, timers);
  await runDataLoadAndInit();
  assert.strictEqual(timers.pending.size, 0);
  timers.advance(60000);
  assert.strictEqual(subtitle(document.body.innerHTML), 'Couldn\'t load your data');
});

// End to end: the real loads, bounded, against a database where ONE read never answers and the other does. One at a time,
// because Promise.all fails at the FIRST rejection: with both hung, the bounded portfolio read reached the error screen
// on its own and hid an unbounded settings read (found 2026-11-19 by the harness: that mutant survived). With only
// settings hung, an unbounded settings read holds "Loading your data…" for good. The store's bound fires at once (its
// setTimeout is immediate), the boot's 5 s timer is virtual, and each case is raced against a real 3 s timer.
function bootWith(hungTable) {
  const hang = sig => new Promise(res => sig.addEventListener('abort', () => res({ data: null, error: { message: 'AbortError: The operation was aborted.', code: '' } })));
  const answers = { portfolio: { data: [{ position_id: 'a' }], error: null, count: 1 }, settings: { data: { id: 3, budget: 1500 }, error: null } };
  const builder = table => {
    // awaited without a signal (an unbounded request), a hung read never answers either: the race below is what fails
    const q = { order: () => q, limit: () => q, maybeSingle: () => q, select: () => q,
      abortSignal: sig => (table === hungTable ? hang(sig) : Promise.resolve(answers[table])),
      then: table === hungTable ? () => {} : (res, rej) => Promise.resolve(answers[table]).then(res, rej) };
    return q;
  };
  const client = { from: builder };
  // eslint-disable-next-line no-new-func
  const loads = new Function('supabaseClient', 'mapSupabasePortfolioRowToPosition', 'setTimeout', 'settingsRowId',
    fnOf(store, 'boundedRequest') + constOf(store, 'LOAD_READ_TIMEOUT_MS')
    // SETTINGS_COLUMNS, BOOLEAN_SETTINGS and SETTINGS_ROW_MISSING, as they stand in the store, one after another
    + store.slice(store.indexOf('const SETTINGS_COLUMNS ='), store.indexOf('// Returns ONLY the settings Supabase holds'))
    + fnOf(store, 'loadPortfolioFromSupabase') + fnOf(store, 'loadSettingsFromSupabase')
    + '\nreturn { loadPortfolioFromSupabase, loadSettingsFromSupabase };')(client, r => r, fn => { setImmediate(fn); return 0; }, null);
  const state = { settings: {}, settingsSource: {} };
  // eslint-disable-next-line no-new-func
  const loadBoth = new Function('loadPortfolioFromSupabase', 'loadSettingsFromSupabase', 'state', fnOf(app, 'loadPortfolioAndSettingsFromSupabase') + '\nreturn loadPortfolioAndSettingsFromSupabase;')(
    loads.loadPortfolioFromSupabase, loads.loadSettingsFromSupabase, state);
  return boot(loadBoth, virtualTimers());
}
for (const [hung, what] of [['settings', 'the settings read'], ['portfolio', 'the portfolio read']]) {
  run(`only the ${hung} read never answers (the other does): the real bounded load reaches the error screen naming it, never hangs`, async () => {
    const { document, runDataLoadAndInit } = bootWith(hung);
    let t;
    try {
      await Promise.race([runDataLoadAndInit(), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('boot hung: no outcome within 3 s')), 3000); })]);
    } finally { clearTimeout(t); }
    await settle();
    const html = document.body.innerHTML;
    assert.strictEqual(subtitle(html), 'Couldn\'t load your data');
    assert.ok(html.includes(`>${what}: no answer within 15 s</div>`), html);
    assert.ok(/>Retry<\/button>/.test(html));
  });
}
