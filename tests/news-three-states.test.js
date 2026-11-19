// tests/news-three-states.test.js -- 2026-11-19 (the reviewer). Three things, each in both directions:
//   1. core/news.js: a response with no news ARRAY is NOT RETRIEVED (its symbols in newsFailedSymbols), never "no news";
//      an explicit empty array is still a real zero (the 11-17 SPY/QQQ answer was one).
//   2. core/macro.js macroNewsState: retrieved / zero_source_alive / not_retrieved, the control's own failure named as
//      not_retrieved ("whether the source is alive is not known"), never the nearest branch; and none of it reaches
//      the stored request or the prompt (the instrument changes once, as one declared revision).
//   3. app.js: a ticker whose news was not retrieved says so on the EDGE card, the modal and the pre-market row.
'use strict';
const assert = require('assert');
const vm = require('vm');
const { readSource, run } = require('./_lib');

function newsCtx(answer) {
  const c = { console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Object, Array, String, Number, Error, Set, Promise,
    state: {}, chunk: (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; },
    sanitizeTickerBatch: t => t, hoursSincePreviousClose: () => null, calls: [] };
  c.alpacaGet = async (p, params, base) => { c.calls.push(params); return answer(params); };
  vm.createContext(c);
  vm.runInContext(readSource('core/news.js'), c);
  const macro = readSource('core/macro.js');
  const grab = n => { const i = macro.search(new RegExp(`^(async )?function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return macro.slice(i, macro.indexOf('\n}\n', i) + 3); };
  const cst = n => macro.match(new RegExp(`^const ${n} = [^\\n]*`, 'm'))[0];
  vm.runInContext([cst('MACRO_HEADLINE_HOURS'), cst('MACRO_HEADLINE_LIMIT'), grab('fetchMacroHeadlines'), grab('macroNewsState')].join('\n'), c);
  return c;
}
const item = (h, sym = 'SPY') => ({ id: 1, created_at: new Date().toISOString(), source: 'benzinga', headline: h, symbols: [sym] });

(async () => {

await run('a response with no news array is NOT RETRIEVED; an explicit empty array is a real zero', async () => {
  const shapeless = newsCtx(() => ({ message: 'something else' }));
  const got = await shapeless.fetchNewsForTickers(['SPY', 'QQQ']);
  assert.deepStrictEqual(Array.from(got), []);
  assert.deepStrictEqual(Array.from(shapeless.state.newsFailedSymbols), ['SPY', 'QQQ'], 'not retrieved, by symbol');
  assert.strictEqual(shapeless.state.newsUnavailable, true, 'every batch failed');
  const empty = newsCtx(() => ({ news: [], next_page_token: null }));
  await empty.fetchNewsForTickers(['SPY', 'QQQ']);
  assert.deepStrictEqual(Array.from(empty.state.newsFailedSymbols), [], 'an explicit empty array is a real zero');
  assert.strictEqual(empty.state.newsUnavailable, false);
});

await run('macroNewsState: retrieved; zero with the source alive; and every way the control cannot say is not_retrieved', async () => {
  const st = async answer => { const c = newsCtx(answer); const r = await c.fetchMacroHeadlines(); return { r, c }; };
  // retrieved: the SPY/QQQ request returned items; no control is sent
  let { r, c } = await st(() => ({ news: [item('Fed holds')] }));
  assert.strictEqual(r.newsState.state, 'retrieved'); assert.strictEqual(c.calls.length, 1, 'no control on a non-zero answer');
  // zero, the unfiltered control returns an item: the source is alive
  ({ r, c } = await st(p => (p.symbols ? { news: [] } : { news: [item('Loblaw dividend', 'L')] })));
  assert.strictEqual(r.newsState.state, 'zero_source_alive');
  assert.strictEqual(c.calls.length, 2); assert.strictEqual(c.calls[1].symbols, undefined, 'the control is unfiltered'); assert.strictEqual(c.calls[1].limit, 1);
  assert.strictEqual(c.calls[1].start, c.calls[0].start, 'the same window');
  // zero, the control FAILS: not known, so not_retrieved (named), never zero_source_alive
  ({ r } = await st(p => { if (p.symbols) return { news: [] }; throw new Error('HTTP 503'); }));
  assert.strictEqual(r.newsState.state, 'not_retrieved'); assert.ok(/control request failed \(HTTP 503\): whether the source is alive is not known/.test(r.newsState.why), r.newsState.why);
  // zero, the control answers without a news array
  ({ r } = await st(p => (p.symbols ? { news: [] } : { error: 'x' })));
  assert.strictEqual(r.newsState.state, 'not_retrieved'); assert.ok(/without a news array/.test(r.newsState.why));
  // zero, and the unfiltered feed is empty too
  ({ r } = await st(() => ({ news: [] })));
  assert.strictEqual(r.newsState.state, 'not_retrieved'); assert.ok(/unfiltered feed returned nothing/.test(r.newsState.why));
  // the SPY/QQQ request itself failed
  ({ r } = await st(() => ({ nothing: true })));
  assert.strictEqual(r.newsState.state, 'not_retrieved'); assert.ok(/SPY\/QQQ news request failed/.test(r.newsState.why));
});

await run('none of it reaches the stored request or the prompt (no change of treatment)', async () => {
  const c = newsCtx(p => (p.symbols ? { news: [] } : { news: [item('x', 'L')] }));
  const r = await c.fetchMacroHeadlines();
  assert.ok(!('newsState' in r.request) && !JSON.stringify(r.request).includes('zero_source_alive'), 'the stored request record carries no state');
  assert.deepStrictEqual(Array.from(r.headlines), [], 'the headlines Groq is given are the SPY/QQQ ones, as before');
  const macro = readSource('core/macro.js');
  const ask = macro.slice(macro.indexOf('async function askMacroGroq('), macro.indexOf('\n}\n', macro.indexOf('async function askMacroGroq(')));
  assert.ok(!/newsState/.test(ask), 'askMacroGroq neither stores nor sends it');
  assert.ok(/\(no recent headlines available\)/.test(macro), 'the prompt\'s empty branch is unchanged');
});

await run('a ticker whose news was not retrieved says so on the EDGE card, the modal and the pre-market row', () => {
  const app = readSource('app.js');
  const grab = n => { const i = app.search(new RegExp(`^function ${n}\\(`, 'm')); assert.ok(i >= 0, n); return app.slice(i, app.indexOf('\n}\n', i) + 3); };
  const c = { state: { newsUnavailable: false, newsTruncatedSymbols: ['TRNC'], newsFailedSymbols: ['FAIL'], news: [] }, Date };
  vm.createContext(c);
  vm.runInContext(app.match(/^const NEWS_NOT_RETRIEVED_TEXT = [^\n]*/m)[0] + '\n' + app.match(/^const NEWS_INCOMPLETE_TEXT = [^\n]*/m)[0] + '\n'
    + grab('buildCardNewsSnippet') + grab('buildModalNewsSection') + ';globalThis.T = NEWS_NOT_RETRIEVED_TEXT; globalThis.I = NEWS_INCOMPLETE_TEXT;', c);
  // CHANGED 2026-11-19, declared: the first text said "scored without it", which was false (EDGE's score has no news
  // term; news feeds only risk, +2 for a recent negative headline, capped at 10). Both unfetched states now say the
  // direction of the error, the same for both, and neither may claim anything about the score.
  assert.strictEqual(c.T, 'News not retrieved (risk may be understated)');
  assert.strictEqual(c.I, 'News check incomplete (risk may be understated)');
  for (const t of [c.T, c.I]) assert.ok(/\(risk may be understated\)$/.test(t) && !/scor/i.test(t), t);
  assert.ok(c.buildCardNewsSnippet({ ticker: 'FAIL', news: null }).includes(c.T));
  assert.ok(c.buildModalNewsSection('FAIL').includes(c.T));
  assert.ok(c.buildCardNewsSnippet({ ticker: 'TRNC', news: null }).includes(c.I), 'incomplete states the same consequence');
  assert.ok(c.buildModalNewsSection('TRNC').includes(c.I));
  // genuinely none is unchanged
  assert.ok(c.buildCardNewsSnippet({ ticker: 'NONE', news: null }).includes('No recent news'));
  assert.ok(c.buildModalNewsSection('NONE').includes('No recent news'));
  assert.ok(/\(state\.newsFailedSymbols \|\| \[\]\)\.includes\(m\.ticker\) \? NEWS_NOT_RETRIEVED_TEXT : state\.newsTruncatedSymbols\.includes\(m\.ticker\) \? NEWS_INCOMPLETE_TEXT/.test(app), 'the pre-market row too');
  assert.ok(!/'News check incomplete'|>News check incomplete</.test(app), 'no literal copy of the incomplete text left behind');
});

})();
