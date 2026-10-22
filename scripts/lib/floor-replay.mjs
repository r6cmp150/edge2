// scripts/lib/floor-replay.mjs -- the ONE implementation of "replay a loss
// floor against Roman's real trades" (2026-10-21, phase-10 §7.7 duplicate
// rule). replay-floor-grid.mjs (every threshold x basis) and
// replay-floor-with-recovery.mjs (the -6% post-trigger counterfactual)
// each carried their own trade loading, bar alignment, split exclusion,
// trigger detection and floor-dollar formula. They agreed only because the
// copies happened to match. Until the shared split check, they returned
// different dollar levels for the same "close-only -6% vs doing nothing"
// question (-$71.86 / -$73.73 vs -$68.01 / -$69.88) while agreeing on the
// $1.87 margin, which is why nobody noticed.
//
// Canonical split: the GRID answers "what does each floor do to the book";
// the RECOVERY script answers only "what would have happened after the
// floor fired". Both get their trade set, triggers and floor dollars from
// here, so they cannot disagree on those again.
import { detectSplitInWindow } from './sell-timing.mjs';

export function barDate(b) { return (b.t || '').split('T')[0]; }

// Fetch adjusted + raw daily bars for every trade, align entry/sell, and
// classify each trade: { error } | { splitInHold: true } | usable.
// preBuyDays / postSellDays only widen the fetch window (the grid needs
// 15+ bars before entry for ATR; the recovery script needs +5 trading
// days after a trigger). They never change which trades are usable: the
// split check is always buy_date..sell_date.
export async function loadReplayBasis(trades, { alpacaGet, sipSafeEndParams, preBuyDays, postSellDays }) {
  const perTrade = [];
  for (const t of trades) {
    const fetchStart = new Date(new Date(t.buy_date + 'T00:00:00Z').getTime() - preBuyDays * 86400000).toISOString().slice(0, 10);
    const fetchEndWanted = new Date(new Date(t.sell_date + 'T00:00:00Z').getTime() + postSellDays * 86400000).toISOString().slice(0, 10);
    let allBars, rawBars;
    try {
      const [allData, rawData] = await Promise.all([
        alpacaGet(`/stocks/${t.ticker}/bars`, { timeframe: '1Day', start: fetchStart, limit: 1000, sort: 'asc', feed: 'sip', adjustment: 'all', ...sipSafeEndParams(fetchEndWanted) }),
        alpacaGet(`/stocks/${t.ticker}/bars`, { timeframe: '1Day', start: fetchStart, limit: 1000, sort: 'asc', feed: 'sip', adjustment: 'raw', ...sipSafeEndParams(fetchEndWanted) }),
      ]);
      allBars = (allData.bars || []).sort((a, b) => new Date(a.t) - new Date(b.t));
      rawBars = (rawData.bars || []).sort((a, b) => new Date(a.t) - new Date(b.t));
    } catch (e) {
      perTrade.push({ ticker: t.ticker, trade: t, error: e.message });
      continue;
    }
    const entryIdx = allBars.findIndex(b => barDate(b) === t.buy_date);
    const sellIdx = allBars.findIndex(b => barDate(b) === t.sell_date);
    if (entryIdx === -1 || sellIdx === -1) {
      perTrade.push({ ticker: t.ticker, trade: t, error: `bar not found (entryIdx=${entryIdx}, sellIdx=${sellIdx})` });
      continue;
    }
    // Split-adjusted bars anywhere in the hold make every trigger day and
    // price wrong against the unadjusted buy_price: exclude the trade from
    // the whole basis, never just from one figure.
    const splitInHold = allBars.length > sellIdx && rawBars.length > sellIdx && detectSplitInWindow(allBars, rawBars, sellIdx, entryIdx);
    perTrade.push({ ticker: t.ticker, trade: t, allBars, rawBars, entryIdx, sellIdx, splitInHold });
  }
  return {
    perTrade,
    errors: perTrade.filter(r => r.error),
    splitExcluded: perTrade.filter(r => !r.error && r.splitInHold),
    clean: perTrade.filter(r => !r.error && !r.splitInHold),
  };
}

// First bar index in the hold at which the floor fires, or null.
//   close    -- the close crosses
//   any      -- the low OR the close crosses, whichever bar comes first
//   persist2 -- two consecutive closes past the line
export function findTrigger(allBars, entryIdx, sellIdx, thresholdPrice, basis) {
  if (basis === 'close') {
    for (let idx = entryIdx; idx <= sellIdx; idx++) if (allBars[idx].c <= thresholdPrice + 1e-9) return idx;
    return null;
  }
  if (basis === 'any') {
    for (let idx = entryIdx; idx <= sellIdx; idx++) {
      if (allBars[idx].l <= thresholdPrice + 1e-9) return idx;
      if (allBars[idx].c <= thresholdPrice + 1e-9) return idx;
    }
    return null;
  }
  if (basis === 'persist2') {
    for (let idx = entryIdx + 1; idx <= sellIdx; idx++) {
      if (allBars[idx].c <= thresholdPrice + 1e-9 && allBars[idx - 1].c <= thresholdPrice + 1e-9) return idx;
    }
    return null;
  }
  throw new Error(`unknown basis ${basis}`);
}

// Dollar result of a clean exit at the floor price (the "assumes a fill at
// the cap" convention every phase-9 floor replay uses).
export function floorDollar(trade, thresholdPrice) {
  return trade.shares * (thresholdPrice - trade.buy_price);
}
