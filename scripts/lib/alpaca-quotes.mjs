// scripts/lib/alpaca-quotes.mjs -- historical NBBO quotes for one symbol over a short window, every page
// (CLAUDE.md: every list call follows next_page_token to exhaustion). Read-only. (2026-11-11)
//   quotes: [{ t, bp, bs, ap, as, ... }] in time order
export async function fetchQuotes(headers, symbol, { start, end, feed = 'sip' }) {
  const out = [];
  let token = null;
  do {
    const url = `https://data.alpaca.markets/v2/stocks/quotes?symbols=${encodeURIComponent(symbol)}&start=${start}&end=${end}&feed=${feed}&limit=10000&sort=asc` + (token ? `&page_token=${token}` : '');
    const res = await fetch(url, { headers });
    const body = await res.json();
    if (!res.ok) throw new Error(`quotes ${feed} ${symbol}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    out.push(...((body.quotes || {})[symbol] || []));
    token = body.next_page_token;
  } while (token);
  return out;
}
