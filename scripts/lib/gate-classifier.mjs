// Shared retroactive 4-pillar gate classifier (daily-bar-only approximation
// of engines/warrior/gate.js), extracted so apply-gate-to-symbol-days.mjs,
// the topN probe, and the eventual widened-scan gate pass all use the exact
// same logic instead of a third hand-copied duplicate. See the header
// comment in apply-gate-to-symbol-days.mjs for the full rationale on why
// CHANGE and RVOL are named, generous approximations and float is
// not-checked.
export const PRICE_MIN = 1.00, PRICE_MAX = 20.00;
export const CHANGE_MIN_PCT = 10;
export const RVOL_MIN = 5.0;
export const NEWS_MAX_AGE_HOURS = 24;

// classifyGate, ported verbatim from engines/warrior/gate.js -- same
// two-stage logic (free pillars gate stage 2, never a plain fail-count),
// so "QUALIFIED" here means exactly what it means in the live app. No
// `fetch-failed` status exists in this approximation (it runs off
// already-fetched historical bars, so there's no live fetch to fail) --
// only 'BLOCKED' from the live vocabulary is inapplicable here.
//
// FIXED 2026-09-05 to match gate.js's own fix: this used to return bare
// `null` for both the free-pillar-fail case and the final fallthrough
// (which itself conflated "2+ substantive pillars genuinely failed" with
// "nothing substantive was even checkable"). Confirmed this DIDN'T
// corrupt the backtest's headline "410/6,255 QUALIFIED" figure --
// apply-gate-to-symbol-days.mjs gives null its own named `disqualified`
// bucket and computes the denominator from the full `results` array
// before any tier filtering, so nothing was silently dropped the way
// index.js's strict-equality UI buckets dropped it live. Fixed anyway,
// for the same reason as the live gate: within `disqualified`, "really
// failed" and "nothing to judge" were still indistinguishable, and any
// future analysis of THAT breakdown would have inherited the gap.
export function classifyGate(pillars) {
  const byId = {};
  pillars.forEach(p => { byId[p.id] = p; });
  const freePillarsPass = byId.price.status === 'pass' && byId.change.status === 'pass';
  if (!freePillarsPass) return 'REJECTED';
  const substantive = [byId.rvol, byId.news].filter(p => p.status !== 'not-checked');
  if (substantive.length === 0) return 'NOT_EVALUATED';
  const substantiveFailed = substantive.filter(p => p.status === 'fail');
  if (substantiveFailed.length === 0) return 'QUALIFIED';
  if (substantiveFailed.length === 1) return 'NEAR_MISS';
  return 'REJECTED';
}

// Computes all four pillars for one symbol-day given its day-D-own metrics
// row (from _rankTopMovers, unlagged) and a news headline (or null/undefined
// if none found in the 24h-pre-open window). Returns { pillars, tier }.
export function gateSymbolDay({ own, headline }) {
  const priceVal = own ? own.close : null;
  const changeVal = own ? own.dayOverDayPct * 100 : null; // dayOverDayPct is a fraction; threshold is in percent
  const relVolVal = own ? own.relVol : null;

  const pricePillar = { id: 'price', status: (typeof priceVal === 'number' && priceVal >= PRICE_MIN && priceVal <= PRICE_MAX) ? 'pass' : 'fail', value: priceVal };
  const changePillar = { id: 'change', status: (typeof changeVal === 'number' && changeVal >= CHANGE_MIN_PCT) ? 'pass' : 'fail', value: changeVal };
  const freePass = pricePillar.status === 'pass' && changePillar.status === 'pass';
  const rvolPillar = !freePass
    ? { id: 'rvol', status: 'not-checked', value: null }
    : (typeof relVolVal === 'number' ? { id: 'rvol', status: relVolVal >= RVOL_MIN ? 'pass' : 'fail', value: relVolVal } : { id: 'rvol', status: 'not-checked', value: null });
  const newsPillar = !freePass
    ? { id: 'news', status: 'not-checked', value: null }
    : { id: 'news', status: headline ? 'pass' : 'fail', value: headline };

  const pillars = { price: pricePillar, change: changePillar, rvol: rvolPillar, news: newsPillar };
  const tier = classifyGate([pricePillar, changePillar, rvolPillar, newsPillar]);
  return { pillars, tier };
}

// Real historical news lookup, batched per trading day, 24h before that
// day's regular-session open. dates: string[] (YYYY-MM-DD), symbolsByDate:
// (date) => string[]. Requires global.alpacaGet and global.ptWallClockToInstant
// and global.chunk to already be set up (as the Node driver scripts do).
export async function fetchNewsByDateSymbol(dates, symbolsByDate) {
  const newsByDateSymbol = new Map(); // `${date}|${symbol}` -> headline or null
  let newsRequests = 0;
  for (const date of dates) {
    const daySymbols = [...new Set(symbolsByDate(date))];
    const openInstant = global.ptWallClockToInstant(date, 6, 30);
    const startInstant = new Date(openInstant.getTime() - NEWS_MAX_AGE_HOURS * 3600 * 1000);
    for (const batch of global.chunk(daySymbols, 100)) {
      try {
        let pageToken;
        const items = [];
        do {
          const params = { symbols: batch.join(','), start: startInstant.toISOString(), end: openInstant.toISOString(), limit: 50, sort: 'desc' };
          if (pageToken) params.page_token = pageToken;
          const data = await global.alpacaGet('/news', params, 'https://data.alpaca.markets/v1beta1');
          newsRequests++;
          items.push(...(data.news || []));
          pageToken = data.next_page_token || null;
        } while (pageToken);
        for (const sym of batch) {
          const hit = items.find(n => (n.symbols || []).includes(sym));
          newsByDateSymbol.set(`${date}|${sym}`, hit ? hit.headline : null);
        }
      } catch (e) {
        console.warn(`[gate-classifier] news batch error for ${date}: ${e.message}`);
      }
    }
  }
  return { newsByDateSymbol, newsRequests };
}
