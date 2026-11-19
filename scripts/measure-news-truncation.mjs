// scripts/measure-news-truncation.mjs -- how often does the news fetch leave a symbol INCOMPLETE (its 10-symbol batch hit
// the 3-page cap before the window ran out), and does it matter for risk? (2026-11-19, the reviewer: the symbols pushed
// past the cap are the ones beside loud ones, so the +2 risk for a recent negative headline may drop out exactly when
// there is the most news. Measure it before it goes on a list.) READ ONLY: GETs to Alpaca's news endpoint; nothing is
// written anywhere. The key comes from an env file on the command line and is never printed (every line is scrubbed).
// PRODUCTION'S OWN CODE, loaded the way scripts/log-signals-edge.mjs loads it (eval with real globals):
// core/clock.js, core/api-client.js, core/news.js (fetchNewsForTickers: the batching, the page cap, the incomplete and
// failed lists), core/edge-scoring.js's NEG_KEYWORDS, and app.js's STOCK_UNIVERSES.OTHER (the logger's universe).
// Two batchings, both reported: the full OTHER universe (the most batches) and a candidate-sized set (the symbols EDGE
// showed on a given day, from the committed signal_log backup): production fetches news for the candidates that pass
// the pre-filter, which is not stored. Then THE IMPACT: each INCOMPLETE symbol fetched ALONE (same window); risk uses a
// symbol's NEWEST item (log-signals-edge.mjs newsMap; app.js the same), so the question is whether that item is a
// negative headline under 24 h old, i.e. whether the +2 would actually have been dropped.
//   node scripts/measure-news-truncation.mjs --env <path to .env.local> [--day 2026-11-18]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const envPath = opt('--env'), day = opt('--day') || '2026-11-18';
if (!envPath) { console.log('usage: node scripts/measure-news-truncation.mjs --env <path to .env.local> [--day YYYY-MM-DD]'); process.exit(2); }
const env = Object.fromEntries(readFileSync(envPath, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const id = env.APCA_API_KEY_ID, secret = env.APCA_API_SECRET_KEY;
if (!id || !secret) { console.log('no Alpaca key in the file'); process.exit(2); }
const scrub = s => String(s).split(id).join('<key id>').split(secret).join('<secret>');
const say = s => console.log(scrub(s));
console.warn = s => say(`  [warn] ${s}`); console.error = s => say(`  [error] ${s}`);

global.state = { settings: { alpacaKey: id, alpacaSecret: secret } };
global.persist = () => {};
const load = (rel, names) => { // eslint-disable-next-line no-eval
  (0, eval)(readFileSync(path.join(ROOT, rel), 'utf8').replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '') + '\n' + names.map(n => `globalThis.${n} = ${n};`).join(' '));
};
load('core/clock.js', ['getPT', 'ptDateStr', 'hoursSincePreviousClose', 'classifySession', 'ptDateTimeOf']);
load('core/api-client.js', ['chunk', 'sanitizeTickerBatch', 'alpacaGet']);
// --control: the instrument's positive control (a measurement that reports zero must be able to report non-zero).
// Production's core/news.js with ONE change, its page cap lowered from 3 pages to 1 (50 items), run on ten heavily
// covered names: if they carry more than 50 items in the window, symbols must come back INCOMPLETE and be checked.
const control = args.includes('--control');
const newsSrc = readFileSync(path.join(ROOT, 'core/news.js'), 'utf8');
const capLine = 'const NEWS_MAX_PAGES_PER_CHUNK = 3;';
if (control && newsSrc.split(capLine).length !== 2) { say('control: the page-cap line was not found once in core/news.js'); process.exit(2); }
(0, eval)((control ? newsSrc.replace(capLine, 'const NEWS_MAX_PAGES_PER_CHUNK = 1;') : newsSrc) + '\nglobalThis.fetchNewsForTickers = fetchNewsForTickers; globalThis.ALPACA_NEWS_BASE = ALPACA_NEWS_BASE;');
const edge = readFileSync(path.join(ROOT, 'core/edge-scoring.js'), 'utf8');
const NEG = (0, eval)(`(${edge.match(/^const NEG_KEYWORDS = (\[[\s\S]*?\]);/m)[1]})`);
const app = readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const L = app.split('\n'), s0 = L.indexOf('const STOCK_UNIVERSES = {'), s1 = L.findIndex((l, i) => i > s0 && l === '};');
const UNIVERSES = (0, eval)(`(() => { ${L.slice(s0, s1 + 1).join('\n')}; return STOCK_UNIVERSES; })()`);
const backup = JSON.parse(readFileSync(path.join(ROOT, 'data/backups/signal_log', `${day.slice(0, 7)}.json`), 'utf8'));
const rows = Array.isArray(backup) ? backup : (backup.rows || Object.values(backup).find(Array.isArray));
const shown = [...new Set(rows.filter(r => r.signal_date === day && r.engine_source === 'EDGE' && r.tier === 'SHOWN').map(r => r.symbol))];

const isNegRecent = n => n && NEG.some(k => (n.headline || '').toLowerCase().includes(k)) && (Date.now() - Date.parse(n.created_at)) / 3600e3 <= 24;
async function measure(label, tickers) {
  const items = await fetchNewsForTickers(tickers);
  const failed = new Set(state.newsFailedSymbols || []), trunc = new Set(state.newsTruncatedSymbols || []);
  const seen = new Set(); for (const n of items) for (const sym of n.symbols || []) seen.add(sym);
  const retrieved = tickers.filter(t => seen.has(t)), none = tickers.filter(t => !seen.has(t) && !failed.has(t) && !trunc.has(t));
  say(`\n${label}: ${tickers.length} symbol(s) in ${Math.ceil(tickers.length / 10)} batch(es); lookback ${state.newsLookbackHours} h; ${items.length} item(s) returned`);
  say(`  retrieved ${retrieved.length} | INCOMPLETE ${trunc.size} | NOT RETRIEVED ${failed.size} | genuinely none ${none.length}${state.newsUnavailable ? ' | every batch failed' : ''}`);
  if (trunc.size) say(`  incomplete: ${[...trunc].join(', ')}`);
  if (failed.size) say(`  not retrieved: ${[...failed].join(', ')}`);
  // the impact: each incomplete symbol alone, its newest item
  let dropped = 0;
  for (const t of trunc) {
    await new Promise(r => setTimeout(r, 400));
    const one = await alpacaGet('/news', { symbols: t, start: state.newsLastRequest.start, limit: 1, sort: 'desc' }, ALPACA_NEWS_BASE);
    const n = Array.isArray(one && one.news) ? one.news[0] : null;
    const bite = isNegRecent(n);
    if (bite) dropped++;
    say(`    ${t}: newest ${n ? `${n.created_at} "${n.headline}"` : 'none in the window'}${bite ? '  <- NEGATIVE, under 24 h: the +2 was dropped' : ''}`);
  }
  say(`  impact: ${trunc.size ? `${dropped} of ${trunc.size} incomplete symbol(s) had a negative headline under 24 h as their newest item (risk understated by the +2, before the cap)` : 'no incomplete symbols'}`);
}
say(`read at ${new Date().toISOString()} (PT ${ptDateTimeOf(Date.now()).date} ${ptDateTimeOf(Date.now()).hhmm}); NEG_KEYWORDS ${NEG.length}`);
if (control) {
  await measure('CONTROL (page cap lowered to 1 page = 50 items; ten heavily covered names)', ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD', 'NFLX', 'INTC']);
} else {
  await measure('THE FULL OTHER UNIVERSE (app.js STOCK_UNIVERSES.OTHER, the logger\'s)', UNIVERSES.OTHER);
  await measure(`A CANDIDATE-SIZED SET: the ${shown.length} symbols EDGE showed on ${day} (signal_log backup)`, shown);
}
