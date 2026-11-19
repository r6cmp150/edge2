// scripts/diagnose-news-source.mjs -- is the macro ask's headline source alive, and what is it returning? (2026-11-19.)
// The method behind the finding declared in STATUS on 2026-11-19 ("the labeller changed on 11-17"): Alpaca's news
// stopped carrying SPY/QQQ tags, retroactively, while the feed stayed live. Committed so the claim about a third party
// has a method behind it, and so the next time a symbol's news goes empty this is re-run rather than rebuilt (the
// reviewer). READ ONLY: GETs to Alpaca's news endpoint and to macro_observations (anon key); nothing written anywhere.
// The Alpaca key is read from an env file given on the command line, sent only in request headers, and never printed
// (every printed line is scrubbed of it).
//   node scripts/diagnose-news-source.mjs --env <path to .env.local with APCA_API_KEY_ID, APCA_API_SECRET_KEY> [--full]
// Sections: 1. the production request (SPY,QQQ, 72 h, limit 50, newest first; core/news.js), printed in full;
//   2. controls, same window: other symbols, no symbol filter, and the production request repeated;
//   3. SPY,QQQ over 14 days (when did tagged items stop?); 4. the headlines the stored asks actually sent.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAllRows } from './lib/read-all.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const envPath = args[args.indexOf('--env') + 1];
const full = args.includes('--full');
if (!args.includes('--env') || !envPath) { console.log('usage: node scripts/diagnose-news-source.mjs --env <path to .env.local> [--full]'); process.exit(2); }
const env = Object.fromEntries(readFileSync(envPath, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const id = env.APCA_API_KEY_ID, secret = env.APCA_API_SECRET_KEY;
if (!id || !secret) { console.log('no Alpaca key in the file (names checked: APCA_API_KEY_ID, APCA_API_SECRET_KEY)'); process.exit(2); }
const scrub = s => String(s).split(id).join('<key id>').split(secret).join('<secret>');
const say = s => console.log(scrub(s));
const NEWS = 'https://data.alpaca.markets/v1beta1/news'; // core/news.js ALPACA_NEWS_BASE + /news
const news = async params => {
  const url = `${NEWS}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': secret } });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (_) { /* reported below */ }
  return { url, res, text, j, items: j && Array.isArray(j.news) ? j.news : null };
};
const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString();
say(`read at ${new Date().toISOString()}`);

say('\n1. THE PRODUCTION REQUEST: SPY,QQQ, 72 h, limit 50, newest first (printed in full)');
const p = await news({ symbols: 'SPY,QQQ', start: hoursAgo(72), limit: '50', sort: 'desc' });
say(`GET ${p.url}\nstatus: ${p.res.status} ${p.res.statusText}`);
for (const [k, v] of p.res.headers) say(`  ${k}: ${v}`);
say(`body (${p.text.length} chars):\n${p.text}`);
say(p.items ? `'news' is an array of ${p.items.length}; next_page_token ${p.j.next_page_token ? 'present' : 'none'}` : `'news' is NOT an array: the response shape is not the one core/news.js reads`);

say('\n2. CONTROLS, same 72 h window: is the source alive, and is the empty answer specific to SPY,QQQ?');
for (const [label, params] of [['AAPL,NVDA,TSLA', { symbols: 'AAPL,NVDA,TSLA' }], ['no symbol filter', {}], ['SPY,QQQ again', { symbols: 'SPY,QQQ' }]]) {
  const r = await news({ ...params, start: hoursAgo(72), limit: '50', sort: 'desc' });
  say(`${label}: ${r.res.status}, ${r.text.length} chars, ${r.items ? `${r.items.length} item(s), more pages: ${r.j.next_page_token ? 'yes' : 'no'}` : 'news NOT an array'}`);
  if (r.items && r.items.length) {
    const ts = r.items.map(n => n.created_at).sort();
    say(`  created_at ${ts[0]} .. ${ts[ts.length - 1]}; tagged SPY or QQQ: ${r.items.filter(n => (n.symbols || []).some(s => s === 'SPY' || s === 'QQQ')).length}`);
    say(`  first: ${r.items[0].headline} [${(r.items[0].symbols || []).join(',')}]`);
  }
  if (full) say(`  body in full:\n${r.text}`);
}

say('\n3. SPY,QQQ OVER 14 DAYS: the newest items still tagged');
const w = await news({ symbols: 'SPY,QQQ', start: hoursAgo(14 * 24), limit: '50', sort: 'desc' });
say(`${w.res.status}: ${w.items ? `${w.items.length} item(s) on this page, more pages: ${w.j.next_page_token ? 'yes' : 'no'}` : 'news NOT an array'}`);
for (const n of (w.items || []).slice(0, 10)) say(`  ${n.created_at} [${(n.symbols || []).join(',')}] ${n.headline}`);

say('\n4. WHAT THE STORED ASKS SENT: each ask\'s recorded news request and its headlines (macro_observations, read only)');
async function readStoredAsks() {
  const store = readFileSync(path.join(ROOT, 'core/store.js'), 'utf8');
  const U = store.match(/const SUPABASE_URL = '([^']+)'/)[1], K = store.match(/const SUPABASE_ANON_KEY = '([^']+)'/)[1];
  return fetchAllRows(`${U}/rest/v1/macro_observations?select=id,fetched_at,groq_request,groq_headlines&groq_asked=eq.true&order=fetched_at.asc,id.asc`, { apikey: K, Authorization: `Bearer ${K}` }, 'macro_observations (the stored asks)');
}
const asks = await readStoredAsks();
for (const r of asks) {
  const q = r.groq_request || {};
  say(`  ${r.fetched_at}: returned ${q.returned ?? '?'}, news_unavailable ${q.news_unavailable ?? '?'}, start ${q.start ?? '?'}, ${(r.groq_headlines || []).length} sent`);
  if (full) for (const h of r.groq_headlines || []) say(`    ${h.created_at} id ${h.id} [${h.source}] ${h.headline}`);
}
