// scripts/lib/alpaca-bars.mjs -- shared by the pre-filter measurement scripts
// (measure-prefilter-feed.mjs, measure-gate-buyable.mjs): the EDGE universe,
// read from app.js by the logger's own text anchor, and multi-symbol bar
// fetches paginated to exhaustion (CLAUDE.md: every list call follows
// next_page_token). Read-only.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function edgeUniverse(root) {
  const lines = readFileSync(path.join(root, 'app.js'), 'utf8').split('\n').map(l => l.replace(/\r$/, ''));
  const a = lines.indexOf('const STOCK_UNIVERSES = {');
  if (a < 0) throw new Error('app.js: no "const STOCK_UNIVERSES = {" line');
  return new Function(lines.slice(a, lines.indexOf('};', a) + 1).join('\n') + '\nreturn STOCK_UNIVERSES;')().OTHER;
}

export function alpacaHeaders(root) {
  const env = Object.fromEntries(readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
  return { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY };
}

// bars for many symbols: { SYM: [bar, ...] }, 100 symbols per request, every page.
export async function fetchBars(headers, symbols, { timeframe, start, end, feed, adjustment = 'raw' }) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 100) {
    const syms = symbols.slice(i, i + 100).join(',');
    let token = null;
    do {
      const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${syms}&timeframe=${timeframe}&start=${start}&end=${end}&feed=${feed}&adjustment=${adjustment}&limit=10000&sort=asc` + (token ? `&page_token=${token}` : '');
      const res = await fetch(url, { headers });
      const body = await res.json();
      if (!res.ok) throw new Error(`bars ${feed} ${timeframe}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
      for (const [s, bars] of Object.entries(body.bars || {})) (out[s] ||= []).push(...bars);
      token = body.next_page_token;
    } while (token);
  }
  return out;
}
