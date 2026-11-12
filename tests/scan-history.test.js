// tests/scan-history.test.js — 2026-11-12. Roman's scan price history (core/scan-history.js, app.js's session reads).
// Facts only: prices, ages, changes as text; every state says something; the card compares with the scans BEFORE
// the one on screen; read once per set of tickers, never persisted, re-read when a scan's rows land.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

// eslint-disable-next-line no-eval
eval(readSource('core/scan-history.js') + '\nObject.assign(global, { scanPointsByTicker, scanPtDate, scanAgeLabel, scanCardPoints, scanCardLine, scanChangeText, scanModalRows, scanCardLabels, scanShortTime, SCAN_HISTORY_SHOWN });');
const app = readSource('app.js');
const fn = name => { const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(app); assert.ok(m, name); return app.slice(m.index, app.indexOf('\n}\n', m.index) + 2); };
const T = iso => Date.parse(iso);
// Mon 2026-11-16 10:00 PT = 18:00Z (PST from 11-01)
const NOW = T('2026-11-16T18:00:00Z');
const pts = (...isoPrice) => isoPrice.map(([iso, price]) => ({ at: T(iso), price }));

(async () => {
await run('a scan is a distinct captured_at per ticker: de-duplicated, newest first, a row with no price skipped', () => {
  const m = scanPointsByTicker([
    { ticker: 'A', captured_at: '2026-11-13T17:00:00Z', price: 4 }, { ticker: 'A', captured_at: '2026-11-16T17:00:00Z', price: 5 },
    { ticker: 'A', captured_at: '2026-11-16T17:00:00Z', price: 5 }, { ticker: 'A', captured_at: '2026-11-15T17:00:00Z', price: null },
    { ticker: 'B', captured_at: '2026-11-16T16:00:00Z', price: '2.5' },
  ]);
  assert.deepStrictEqual(m.get('A').map(p => p.price), [5, 4]);
  assert.deepStrictEqual(m.get('B'), [{ at: T('2026-11-16T16:00:00Z'), price: 2.5 }]);
});

await run('ages: minutes and hours the same PT day; a weekday across a weekend, never "yesterday"; a date past six days', () => {
  assert.strictEqual(scanAgeLabel(NOW - 41 * 60000, NOW, 'card'), '41m');
  assert.strictEqual(scanAgeLabel(NOW - 30000, NOW, 'card'), '<1m');
  assert.strictEqual(scanAgeLabel(NOW - 3 * 3600000, NOW, 'card'), '3h');
  assert.strictEqual(scanAgeLabel(NOW - 3 * 3600000, NOW, 'modal'), '3 h ago');
  const fri = T('2026-11-13T21:00:00Z'); // Fri 13:00 PT, seen on Monday
  assert.strictEqual(scanAgeLabel(fri, NOW, 'card'), 'Fri');
  assert.strictEqual(scanAgeLabel(fri, NOW, 'modal'), '3 days ago', 'the modal names the day in its timestamp: never "Sun ... Sun"');
  assert.strictEqual(scanAgeLabel(T('2026-11-15T23:00:00Z'), NOW, 'modal'), '1 day ago');
  // 06:00 PT Monday vs 23:30 PT Sunday: a different PT day, though under 7 hours apart and the same UTC day
  assert.strictEqual(scanAgeLabel(T('2026-11-16T07:30:00Z'), T('2026-11-16T14:00:00Z'), 'card'), 'Sun');
  assert.strictEqual(scanAgeLabel(T('2026-10-27T18:00:00Z'), NOW, 'card'), 'Oct 27');
  assert.strictEqual(scanAgeLabel(T('2026-10-27T18:00:00Z'), NOW, 'modal'), '20 days ago');
});

await run('the card: every state says something; Signals compares with the scans BEFORE the one on screen', () => {
  const p = pts(['2026-11-16T17:59:30Z', 5.2], ['2026-11-16T17:19:00Z', 5.1], ['2026-11-16T15:00:00Z', 5.0], ['2026-11-13T21:00:00Z', 4.8], ['2026-11-12T21:00:00Z', 4.7]);
  const onScreen = T('2026-11-16T17:59:00Z'); // the scan finished; its own row (17:59:30) came after
  assert.strictEqual(scanCardLine('loading', [], onScreen, NOW).full, 'Scan history loading…');
  assert.strictEqual(scanCardLine('failed', [], onScreen, NOW).full, 'Scan history unavailable');
  assert.strictEqual(scanCardLine('ready', [], onScreen, NOW).full, 'No earlier scans recorded');
  assert.strictEqual(scanCardLine('ready', [], null, NOW).full, 'No scans recorded');
  assert.strictEqual(scanCardLine('ready', p.slice(0, 1), onScreen, NOW).full, 'No earlier scans recorded', 'only the scan on screen: nothing earlier');
  const three = scanCardLine('ready', p, onScreen, NOW);
  assert.strictEqual(three.full, 'Earlier scans  $5.10 41m · $5.00 3h · $4.80 Fri', 'the on-screen scan ($5.20) is not one of the three');
  assert.strictEqual(three.agesOnly, 'Earlier scans  41m · 3h · Fri', 'if it does not fit, the ages stay');
  assert.strictEqual(scanCardLine('ready', p.slice(0, 3), onScreen, NOW).full, 'Only 2 earlier scans  $5.10 41m · $5.00 3h', 'never padded');
  assert.strictEqual(scanCardLine('ready', p.slice(3, 4), null, NOW).full, 'Only 1 scan  $4.80 Fri');
  assert.strictEqual(scanCardLine('ready', p, null, NOW).full, 'Last scans  $5.20 <1m · $5.10 41m · $5.00 3h', 'Portfolio: no scan on screen, the latest three');
});

await run('a burst of scans on one earlier day: every point carries its time, the day once, newest first (the p1 defect)', () => {
  // Mon 2026-11-02, PST: 20:55Z = 12:55p, 17:40Z = 9:40a, 17:14Z = 9:14a; viewed 14 days later
  const burst = pts(['2026-11-02T20:55:00Z', 5.96], ['2026-11-02T17:40:00Z', 5.95], ['2026-11-02T17:14:00Z', 6.21]);
  const line = scanCardLine('ready', burst, null, NOW);
  assert.strictEqual(line.full, 'Last scans  $5.96 Nov 2 12:55p · $5.95 9:40a · $6.21 9:14a');
  assert.strictEqual(line.agesOnly, 'Last scans  Nov 2 12:55p · 9:40a · 9:14a');
  const labels = scanCardLabels(burst, NOW);
  assert.strictEqual(new Set(labels).size, labels.length, 'no two points on one earlier day share a label');
  // two on one earlier day, one on another: only the shared day carries times
  const mixed = pts(['2026-11-13T21:00:00Z', 4.8], ['2026-11-13T17:30:00Z', 4.7], ['2026-11-12T21:00:00Z', 4.6]);
  assert.deepStrictEqual(scanCardLabels(mixed, NOW), ['Fri 1:00p', '9:30a', 'Thu']);
  // today's points keep minutes/hours; a single point on an earlier day keeps its bare day
  assert.deepStrictEqual(scanCardLabels(pts(['2026-11-16T17:19:00Z', 5.1], ['2026-11-16T15:00:00Z', 5.0], ['2026-11-13T21:00:00Z', 4.8]), NOW), ['41m', '3h', 'Fri']);
  assert.strictEqual(scanShortTime(T('2026-11-02T20:55:00Z')), '12:55p');
});

await run('the modal: the scan on screen marked (the oldest row at or after it finished, not a later one), then three before, with changes as text', () => {
  const p = pts(['2026-11-16T17:59:50Z', 5.3], ['2026-11-16T17:59:30Z', 5.2], ['2026-11-16T17:19:00Z', 5.1], ['2026-11-16T15:00:00Z', 5.0], ['2026-11-13T21:00:00Z', 4.8], ['2026-11-12T21:00:00Z', 4.7]);
  const r = scanModalRows(p, T('2026-11-16T17:59:00Z'));
  assert.deepStrictEqual(r.rows.map(x => [x.price, !!x.current]), [[5.2, true], [5.1, false], [5.0, false], [4.8, false]]);
  assert.deepStrictEqual(r.rows.map(x => x.change), ['+$0.10 (+2.0%)', '+$0.10 (+2.0%)', '+$0.20 (+4.2%)', null], 'the oldest shown has no change: the one before it is not shown');
  assert.strictEqual(r.total, 6); assert.strictEqual(r.first, T('2026-11-12T21:00:00Z'));
  assert.strictEqual(scanChangeText(4.9, 5.0), '−$0.10 (−2.0%)');
  assert.strictEqual(scanChangeText(5.001, 5.0), 'no change');
  const held = scanModalRows(p.slice(2), null);
  assert.ok(held.rows.every(x => !x.current) && held.rows.length === 3, 'not in the scan on screen: nothing marked current');
});

await run('facts only: no arrow, no colour by direction, no trend or momentum word, anywhere in the feature', () => {
  const core = readSource('core/scan-history.js').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const appFns = ['scanHistoryCardHtml', 'scanHistoryCardText', 'refreshScanHistoryDom', 'scanHistoryModalHtml', 'scanHistoryModalSection'].map(fn).join('\n')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  for (const [where, src] of [['core/scan-history.js', core], ['app.js scan history', appFns]]) {
    assert.ok(!/[▲▼↑↓⬆⬇📈📉]/.test(src), `${where}: an arrow`);
    assert.ok(!/\b(trend|trending|momentum|rising|falling|bullish|bearish)\b/i.test(src), `${where}: a trend word`);
    assert.ok(!/var\(--green\)|class="[^"]*\b(pos|neg)\b/.test(src), `${where}: colour by direction`);
  }
  assert.ok(!/var\(--red\)/.test(fn('scanHistoryCardHtml')), 'the card line is one muted colour');
  assert.ok(/a quote at that moment, not a traded price/.test(fn('scanHistoryModalHtml')), 'the modal says what the number is');
});

// The session reads, run for real with a fake loader.
function loadSessionReads() {
  const i = app.indexOf('const _sessionReads = new Map();');
  // eslint-disable-next-line no-eval
  eval(app.slice(i, app.indexOf('\n}\n', app.indexOf('function invalidateSessionRead(')) + 2) + '\nglobal.__sr = { sessionRead, invalidateSessionRead, _sessionReads };');
  return global.__sr;
}
const flush = () => new Promise(r => setTimeout(r, 0));

await run('read once per set of tickers: a subset or the same set reads nothing; a new ticker reads the union once; invalidate reads again', async () => {
  const S = loadSessionReads(); const loads = []; const settled = [];
  const load = async keys => { loads.push(keys.slice().sort()); return keys.length; };
  S.sessionRead('h', new Set(['A', 'B']), load, e => settled.push(e.status)); await flush();
  S.sessionRead('h', new Set(['B', 'A']), load); S.sessionRead('h', new Set(['A']), load); await flush();
  assert.deepStrictEqual(loads, [['A', 'B']], 'sorting, a tab switch, the banner tick: the same tickers, no read');
  const e = S.sessionRead('h', new Set(['C']), load); await flush();
  assert.deepStrictEqual(loads[1], ['A', 'B', 'C'], 'a new ticker (a modal) widens the read');
  assert.strictEqual(e.status, 'ready'); assert.deepStrictEqual(settled, ['ready']);
  S.invalidateSessionRead('h'); S.sessionRead('h', new Set(['A']), load); await flush();
  assert.deepStrictEqual(loads[2], ['A'], 'after invalidation: read again, for what is asked');
  let tries = 0;
  const f = S.sessionRead('x', new Set(['A']), async () => { tries++; throw new Error('denied'); }); await flush();
  assert.strictEqual(f.status, 'failed'); assert.strictEqual(f.error, 'denied');
  S.sessionRead('x', new Set(['A']), async () => { tries++; return 1; }); await flush();
  assert.strictEqual(tries, 2, 'a failed read is asked again, never held as the answer');
});

await run('never persisted: the cache lives outside state, and nothing persists it', () => {
  assert.ok(/^const _sessionReads = new Map\(\);/m.test(app), 'a module-level Map, not a state field');
  assert.ok(!/state\.(scanHistory|sessionReads|_sessionReads)/.test(app), 'not on state');
  assert.ok(!/persist\(['"](scanHistory|sessionReads)/.test(app), 'never persisted');
  assert.ok(!/localStorage[^\n]*(scanHistory|sessionRead)/.test(app + readSource('core/store.js')));
});

await run('when it reads: on render (cached), for a modal\'s new ticker, and again only when a scan\'s rows land', () => {
  assert.ok(/  container\.innerHTML = html;\n  ensureScanHistory\(\);\n  refreshScanHistoryDom\(\);\n\}/.test(fn('renderSignalsTab')));
  assert.ok(fn('renderPortfolioTab').trim().endsWith("if (sumEl)  sumEl.innerHTML  = sumHtml;\n  ensureScanHistory();\n  refreshScanHistoryDom();\n}"), 'Portfolio: after its cards are on the page');
  assert.ok(fn('openStockModal').includes('ensureScanHistory([ticker]);'));
  assert.ok(!/ensureScanHistory|sessionRead/.test(fn('refreshScanHistoryDom')), 'redrawing never reads');
  const w = fn('writeRatingSnapshots'), r = fn('retryRatingWrites');
  assert.ok(w.indexOf('scanHistoryChanged();') > w.indexOf("noteRatingFailure(rows, error); return; }"), 'only after the write landed');
  assert.ok(r.indexOf('scanHistoryChanged();') > r.indexOf('if (error) throw error;'), 'and after a retry landed');
  assert.ok(/invalidateSessionRead\('scanHistory'\)/.test(fn('scanHistoryChanged')));
});

await run('a line wraps to two lines; past two it drops the prices and keeps the ages (measured, not assumed)', () => {
  // a fake that wraps: 7px a character, 15px a line
  const els = [{ attrs: { 'data-scan-hist': 'A', 'data-scan-scope': 'portfolio' }, textContent: '', clientWidth: 100, get scrollHeight() { return Math.ceil(this.textContent.length * 7 / this.clientWidth) * 15; } }];
  els[0].getAttribute = k => els[0].attrs[k];
  global.document = { querySelectorAll: () => els, getElementById: () => null };
  global.state = { signals: [], lastScanTime: null };
  global._sessionReads = new Map([['scanHistory', { status: 'ready', value: new Map([['A', [{ at: Date.now() - 41 * 60000, price: 1234.56 }, { at: Date.now() - 3 * 3600000, price: 1200.01 }, { at: Date.now() - 4 * 86400000, price: 1100.5 }] /* relative to now: this code reads the real clock */]]) }]]);
  // eslint-disable-next-line no-eval
  eval([app.match(/^const SCAN_HISTORY_MAX_HEIGHT = .*$/m)[0], fn('scanHistoryCardText'), fn('refreshScanHistoryDom')].join('\n') + '\nglobal.__refresh = refreshScanHistoryDom;');
  global.__refresh();
  assert.ok(/^Last scans  [^$]*$/.test(els[0].textContent) && !els[0].textContent.includes('$'), `ages only: ${els[0].textContent}`);
  els[0].clientWidth = 200; global.__refresh();
  assert.ok(els[0].textContent.includes('$1234.56'), 'two lines are room enough: the prices stay');
});

await run('the not_known count uses the same mechanism: read once per session, again after a trade is recorded', () => {
  assert.ok(fn('loadNotKnownCount').includes("sessionRead('notKnown', ['all'], readNotKnownCount, renderNotKnownCount)"));
  assert.ok(fn('finalizeAddPortfolio').includes("invalidateSessionRead('notKnown');"), 'a buy recorded');
  const w = fn('writeTradeToSupabase');
  assert.ok(w.indexOf("invalidateSessionRead('notKnown');") >= 0 && w.indexOf("invalidateSessionRead('notKnown');") < w.indexOf("return noteSaleWrite(pos, 'WRITTEN'"), 'a sale recorded');
});

await run('the read: one chunked helper for every ticker on screen, price and time only (no score: no row records its scoring version)', () => {
  const e = fn('ensureScanHistory');
  assert.ok(e.includes('selectRatingSnapshotsByTickers(tickers)') && e.includes('scanPointsByTicker(data)'));
  const store = readSource('core/store.js');
  assert.ok(store.includes(".select('id, ticker, captured_at, price', { count: 'exact' })"), 'no score column read');
  assert.ok(/NO SCORE: rating_snapshots\.scoring_version \/ scoring_hash are NULL/.test(readSource('core/scan-history.js')));
});
})();
