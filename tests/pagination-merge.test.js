// tests/pagination-merge.test.js — core/market-data.js's four bar fetchers
// (fetchMultiBars, fetchSingleBars, fetchMinuteBars, fetchHourlyBars).
//
// Each one used to (or, for fetchMultiBars, was fixed to) follow
// next_page_token to exhaustion rather than trusting a single page — the
// Bug 1 shape, found first in fetchMultiBars, then found unaudited in the
// other three two days later (fetchSingleBars/fetchMinuteBars/
// fetchHourlyBars). This test proves each one actually follows
// next_page_token and merges multi-page results, against a mocked
// alpacaGet returning a real 2-page response — not just that the code
// contains a do/while loop that looks right.
'use strict';
const assert = require('assert');
const { readSource, run } = require('./_lib');

const src = readSource('core/market-data.js');

// fetchMultiBars hits the multi-symbol endpoint, where data.bars is an
// OBJECT keyed by symbol. fetchSingleBars/fetchMinuteBars/fetchHourlyBars
// hit the single-symbol endpoint (/stocks/{ticker}/bars), where data.bars
// is a plain ARRAY — a real shape difference between the two endpoints,
// not a detail either mock can share. Two page each so a fetcher that
// stops after page 1 is distinguishable from one that correctly continues.
function makeTwoPageMockMultiSymbol(callLog) {
  return async (path, params) => {
    callLog.push({ path, params: { ...params } });
    if (!params.page_token) {
      return { bars: { TICK: [{ t: '2026-08-01T00:00:00Z', c: 1, h: 1.1, l: 0.9, v: 100 }] }, next_page_token: 'page2' };
    }
    return { bars: { TICK: [{ t: '2026-08-02T00:00:00Z', c: 2, h: 2.1, l: 1.9, v: 200 }] }, next_page_token: null };
  };
}

function makeTwoPageMockSingleSymbol(callLog) {
  return async (path, params) => {
    callLog.push({ path, params: { ...params } });
    if (!params.page_token) {
      return { bars: [{ t: '2026-08-01T00:00:00Z', c: 1, h: 1.1, l: 0.9, v: 100 }], next_page_token: 'page2' };
    }
    return { bars: [{ t: '2026-08-02T00:00:00Z', c: 2, h: 2.1, l: 1.9, v: 200 }], next_page_token: null };
  };
}

function extractFn(name) {
  const re = new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name} from core/market-data.js`);
  return m[0];
}

async function testFetchMultiBarsFollowsPagination() {
  const callLog = [];
  global.alpacaGet = makeTwoPageMockMultiSymbol(callLog);
  global.sanitizeTickerBatch = (t) => t;
  global.chunk = (arr, size) => { const out = []; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; };
  // eslint-disable-next-line no-eval
  eval(extractFn('fetchMultiBars') + '\nglobal.__fetchMultiBars = fetchMultiBars;');

  const { results, droppedSymbols } = await global.__fetchMultiBars(['TICK'], 10000);
  console.log('fetchMultiBars:', results.TICK.length, 'bars merged across', callLog.length, 'requests');
  assert.strictEqual(callLog.length, 2, 'expected 2 requests (page 1 + page 2)');
  assert.strictEqual(results.TICK.length, 2, 'expected both pages\' bars merged');
  assert.strictEqual(results.TICK[1].c, 2, 'expected page 2\'s bar present in the merged result');
  assert.strictEqual(droppedSymbols.length, 0);
  assert.strictEqual(callLog[0].params.limit, 10000, 'expected the raised (post-Bug-1) limit');
}

async function testFetchSingleBarsFollowsPagination() {
  const callLog = [];
  global.alpacaGet = makeTwoPageMockSingleSymbol(callLog);
  // eslint-disable-next-line no-eval
  eval(extractFn('fetchSingleBars') + '\nglobal.__fetchSingleBars = fetchSingleBars;');

  const bars = await global.__fetchSingleBars('TICK');
  console.log('fetchSingleBars:', bars.length, 'bars merged across', callLog.length, 'requests');
  assert.strictEqual(callLog.length, 2, 'expected 2 requests (page 1 + page 2)');
  assert.strictEqual(bars.length, 2, 'expected both pages\' bars merged');
  assert.strictEqual(bars[1].c, 2, 'expected page 2\'s bar present in the merged result');
  assert.strictEqual(callLog[0].params.limit, 10000, 'expected the raised (post-fix) default limit');
}

async function testFetchMinuteBarsFollowsPagination() {
  const callLog = [];
  global.alpacaGet = makeTwoPageMockSingleSymbol(callLog);
  // eslint-disable-next-line no-eval
  eval(extractFn('fetchMinuteBars') + '\nglobal.__fetchMinuteBars = fetchMinuteBars;');

  const bars = await global.__fetchMinuteBars('TICK');
  console.log('fetchMinuteBars:', bars.length, 'bars merged across', callLog.length, 'requests');
  assert.strictEqual(callLog.length, 2, 'expected 2 requests (page 1 + page 2)');
  assert.strictEqual(bars.length, 2, 'expected both pages\' bars merged');
  assert.strictEqual(callLog[0].params.limit, 10000, 'expected the raised (post-fix) limit');
}

async function testFetchHourlyBarsFollowsPagination() {
  const callLog = [];
  global.alpacaGet = makeTwoPageMockSingleSymbol(callLog);
  // eslint-disable-next-line no-eval
  eval(extractFn('fetchHourlyBars') + '\nglobal.__fetchHourlyBars = fetchHourlyBars;');

  const bars = await global.__fetchHourlyBars('TICK');
  console.log('fetchHourlyBars:', bars.length, 'bars merged across', callLog.length, 'requests');
  assert.strictEqual(callLog.length, 2, 'expected 2 requests (page 1 + page 2)');
  assert.strictEqual(bars.length, 2, 'expected both pages\' bars merged');
  assert.strictEqual(callLog[0].params.limit, 10000, 'expected the raised (post-fix) limit');
}

(async () => {
  await run('pagination-merge: fetchMultiBars follows next_page_token', testFetchMultiBarsFollowsPagination);
  await run('pagination-merge: fetchSingleBars follows next_page_token', testFetchSingleBarsFollowsPagination);
  await run('pagination-merge: fetchMinuteBars follows next_page_token', testFetchMinuteBarsFollowsPagination);
  await run('pagination-merge: fetchHourlyBars follows next_page_token', testFetchHourlyBarsFollowsPagination);
})();
