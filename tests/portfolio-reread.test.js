// tests/portfolio-reread.test.js -- 2026-11-18. A session's portfolio list was the database read once at app start plus
// its own changes, so another device's adds and sales stayed invisible for as long as the app stayed open (hours, on
// 11-17). Approved: re-read it when the Portfolio tab opens and when the app regains focus on that tab. The reviewer's
// condition (a): "a failed refresh never blanks the list" is the FIRST test written, before the feature works -- the
// empty-read ambiguity for the third time in a fortnight.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const app = readSource('app.js');
const grab = n => { const i = app.search(new RegExp(`^(async )?function ${n}\\(`, 'm')); assert.ok(i >= 0, `${n} exists`); return app.slice(i, app.indexOf('\n}\n', i) + 3); };

function load({ reread, session }) {
  const renders = [];
  global.state = { portfolio: session.map(p => ({ ...p })), saleInFlight: {}, deletedPositionIds: new Set(), peakRsiSaved: {}, activeTab: 'portfolio', portfolioLoad: { at: Date.parse('2026-11-18T15:00:00Z'), rows: session.length } };
  global.loadPortfolioFromSupabase = reread;
  global.renderPortfolioTab = () => renders.push(global.state.portfolio.map(p => p.id).join(','));
  global.updateNavBadges = () => {};
  global.isModalOpen = () => false;
  // eslint-disable-next-line no-eval
  eval(grab('mergePortfolio') + grab('refreshPortfolio') + '\nglobal.__refresh = refreshPortfolio; global.__merge = mergePortfolio;');
  return { renders };
}
const A = { id: 'a', ticker: 'AAA', peakRsi: 60 }, B = { id: 'b', ticker: 'BBB', peakRsi: null };

// (a), FIRST: every way a refresh can fail leaves the list exactly as it was, and says so.
run('a failed refresh never blanks or shrinks the list: it is left as it was, and the state says why', async () => {
  for (const [label, reread] of [
    ['the guarded load throws (denied, cut short, no count, no answer)', async () => { throw new Error('the portfolio read back empty and so did trades_v2'); }],
    ['the load resolves with nothing usable', async () => undefined],
    ['the load resolves with a non-list', async () => ({ data: [] })],
  ]) {
    const h = load({ reread, session: [A, B] });
    await global.__refresh('tab');
    assert.deepStrictEqual(global.state.portfolio.map(p => p.id), ['a', 'b'], `${label}: the list is untouched`);
    assert.strictEqual(global.state.portfolioRefresh.state, 'NOT_REFRESHED', label);
    assert.ok(global.state.portfolioRefresh.reason, `${label}: a reason`);
    assert.deepStrictEqual(h.renders, ['a,b'], `${label}: re-rendered once, with the same list, to show the "could not refresh" line`);
  }
});

run('refreshed: the other device\'s adds appear and its sales disappear; the database\'s order and values win', async () => {
  const C = { id: 'c', ticker: 'CCC', peakRsi: null };
  load({ reread: async () => [{ ...A, peakRsi: 58 }, C], session: [A, B] });
  await global.__refresh('tab');
  assert.deepStrictEqual(global.state.portfolio.map(p => p.id), ['a', 'c'], 'C (added elsewhere) appears; B (sold elsewhere) goes');
  assert.strictEqual(global.state.portfolioRefresh.state, 'REFRESHED');
  assert.strictEqual(global.state.portfolioRefresh.rows, 2);
});

run('kept across the merge: a sale in flight here, a delete in flight here, and a peak RSI sampled here above the database\'s', async () => {
  const h = load({ reread: async () => [{ id: 'a', ticker: 'AAA', peakRsi: 55, peakRsiSampledFrom: 't0' }, { id: 'd', ticker: 'DDD', peakRsi: 80 }], session: [A, B] });
  global.state.saleInFlight = { b: 'QUEUED' };        // B is being sold here; the other device already removed its row
  global.state.deletedPositionIds = new Set(['d']);   // D's delete is in flight here
  global.state.peakRsiSaved = { a: 50 };
  await global.__refresh('resume');
  assert.deepStrictEqual(global.state.portfolio.map(p => p.id), ['a', 'b'], 'B kept until its write returns; D not brought back');
  const a = global.state.portfolio.find(p => p.id === 'a');
  assert.strictEqual(a.peakRsi, 60, 'the higher local sample is not lowered by the database\'s 55');
  assert.strictEqual(a.peakRsiSampledFrom, 't0', 'when sampling began is the database\'s');
  assert.strictEqual(global.state.peakRsiSaved.a, 55, 'confirmed up to what the database holds, so the 60 is still re-sent');
  assert.strictEqual(h.renders.length, 1);
  load({ reread: async () => [{ id: 'a', ticker: 'AAA', peakRsi: 72 }], session: [A] });
  await global.__refresh('tab');
  assert.strictEqual(global.state.portfolio[0].peakRsi, 72, 'a higher database peak (the other device sampled it) wins');
});

run('a dialog open: NOT_ATTEMPTED and nothing touched; a dialog opened during the read: nothing moved under it', async () => {
  let h = load({ reread: async () => { throw new Error('must not be read'); }, session: [A, B] });
  global.isModalOpen = () => true;
  await global.__refresh('resume');
  assert.deepStrictEqual([global.state.portfolioRefresh.state, global.state.portfolioRefresh.reason], ['NOT_ATTEMPTED', 'a dialog was open']);
  assert.deepStrictEqual(h.renders, [], 'no render under the dialog');
  let open = false;
  h = load({ reread: async () => { open = true; return [A]; }, session: [A, B] });
  global.isModalOpen = () => open;
  await global.__refresh('tab');
  assert.deepStrictEqual(global.state.portfolio.map(p => p.id), ['a', 'b'], 'the Sell form\'s card is not removed under it');
  assert.strictEqual(global.state.portfolioRefresh.state, 'NOT_ATTEMPTED');
  assert.deepStrictEqual(h.renders, []);
});

run('one refresh at a time: a second trigger while one is out reads nothing', async () => {
  let reads = 0, release;
  load({ reread: () => { reads++; return new Promise(r => { release = () => r([A]); }); }, session: [A, B] });
  const first = global.__refresh('tab');
  await global.__refresh('resume');
  assert.strictEqual(reads, 1);
  release(); await first;
  assert.strictEqual(global.state.portfolioRefreshInFlight, false, 'and the flag is released');
});

run('the tab says so when it could not refresh (reason, and since when), and says nothing otherwise; wired to tab, resume and ↻', () => {
  const ctx = { state: { portfolioRefresh: { state: 'NOT_REFRESHED', reason: 'the portfolio read 3 of 4 rows: not complete', shownSince: Date.parse('2026-11-18T16:05:00Z') } } };
  // eslint-disable-next-line no-new-func
  const line = new Function('state', grab('portfolioRefreshLine') + '\nreturn portfolioRefreshLine();');
  const s = line(ctx.state);
  assert.ok(s.includes('⚠ Could not refresh from the database (the portfolio read 3 of 4 rows: not complete). Showing what this device last read, at 8:05 AM PT; positions added or sold on another device since then are not shown. Tap ↻ to try again.'), s);
  assert.strictEqual(line({ portfolioRefresh: { state: 'REFRESHED' } }), '');
  assert.strictEqual(line({ portfolioRefresh: { state: 'NOT_ATTEMPTED' } }), '');
  assert.strictEqual(line({ portfolioRefresh: null }), '');
  assert.ok(app.includes("    case 'portfolio': renderPortfolioTab(); refreshPortfolio('tab'); break;"), 'on opening the tab');
  assert.ok(app.includes("if (document.visibilityState === 'visible' && state.activeTab === 'portfolio') refreshPortfolio('resume');"), 'on resume, on that tab');
  assert.ok(app.includes(`onclick="refreshPortfolio('button')">↻</button>`), 'the ↻ re-reads');
  assert.ok(app.includes('  ${portfolioRefreshLine()}\n'), 'the line is in the tab');
});

// 2026-11-18 (the reviewer): a hung re-read held portfolioRefreshInFlight set, so every later refresh that session was
// skipped with nothing shown. The real load (core/store.js, bounded) against a database that never answers: at the
// bound the refresh is NOT_REFRESHED, its line is shown, AND the flag is released, so the next refresh runs. Never one
// without the other. Raced against a real timer.
run('a re-read with no answer: the line is shown AND the flag released, and the next refresh runs', async () => {
  const store = readSource('core/store.js');
  const piece = (start, end = '\n}\n') => { const i = store.indexOf(start); assert.ok(i >= 0, start); return store.slice(i, store.indexOf(end, i) + end.length); };
  let answering = false;
  const answer = (v, sig) => answering ? Promise.resolve(v)
    : new Promise(res => sig.addEventListener('abort', () => res({ data: null, error: { message: 'AbortError: The operation was aborted.', code: '' } })));
  const client = { from: () => ({ select: () => ({ order: () => ({ abortSignal: sig => answer({ data: [{ position_id: 'a' }], error: null, count: 1 }, sig) }) }) }) };
  // eslint-disable-next-line no-new-func
  const realLoad = new Function('supabaseClient', 'mapSupabasePortfolioRowToPosition', 'setTimeout',
    piece('async function boundedRequest(') + piece('const LOAD_READ_TIMEOUT_MS', '\n') + piece('async function loadPortfolioFromSupabase(') + '\nreturn loadPortfolioFromSupabase;')(
    client, r => ({ id: r.position_id, ticker: 'AAA' }), fn => { setImmediate(fn); return 0; });
  const { renders } = load({ reread: realLoad, session: [A] });
  eval(grab('portfolioRefreshLine') + '\nglobal.__line = portfolioRefreshLine;');
  const REAL = global.setTimeout; let t;
  try {
    await Promise.race([global.__refresh('button'), new Promise((_, rej) => { t = REAL(() => rej(new Error('the refresh hung: no outcome within 3 s')), 3000); })]);
  } finally { clearTimeout(t); }
  assert.strictEqual(global.state.portfolioRefresh.state, 'NOT_REFRESHED');
  assert.ok(/the portfolio read: no answer within 15 s/.test(global.state.portfolioRefresh.reason), global.state.portfolioRefresh.reason);
  assert.strictEqual(global.state.portfolioRefreshInFlight, false, 'the flag is released');
  assert.ok(renders.length >= 1 && /Could not refresh from the database \(the portfolio read: no answer within 15 s\)/.test(global.__line()), 'the line is shown');
  answering = true;
  await global.__refresh('button');
  assert.strictEqual(global.state.portfolioRefresh.state, 'REFRESHED', 'the next refresh ran');
});
