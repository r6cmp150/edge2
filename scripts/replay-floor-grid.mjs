#!/usr/bin/env node
// Phase 9 §0.3 grid correction (Roman, 2026-09-16): the ORIGINAL menu he
// chose -6% from (§0.3's table) used the naive method -- cap a trade's
// FINAL realized loss at N% only if it already ended up losing more than
// that, never asking whether an earlier intraday/close breach that later
// recovered should have force-exited it too. §0.3.1 found that blind
// spot makes the shipped -6% floor's own historical record look far
// better than the mechanism actually earned (n=8 real crossers, not 4;
// margin over doing nothing $1.87, not $70.57 -- and n=15 under the
// definition the shipped code ACTUALLY uses, where it's a net LOSS of
// $97.78 vs doing nothing).
//
// This redoes the WHOLE MENU the same honest way: for every (threshold,
// basis) cell, walk each of the 37 real trades day by day, force-exit at
// the FIRST day the basis's trigger condition is met (clean exit at the
// threshold price, same "assumes a fill at the cap" convention as
// §0.3/§0.3.1 throughout), and sum the real 37-trade book. No cell here
// reports a post-trigger recovery counterfactual (that's §0.3.1's
// separate analysis, already done for -6% specifically) -- this grid's
// job is comparability across a MENU, the same shape §0.3's original
// table had, just honestly triggered this time.
//
// Bases:
//   close    -- first day the CLOSE crosses the threshold price.
//   any      -- first day the LOW crosses OR the close crosses, whichever
//               is first -- the theoretical upper bound, but also -- per
//               Roman's own correction this session -- what the SHIPPED
//               calcUnifiedRecommendation actually behaves like: it
//               evaluates position.currentPrice at whatever moment the
//               portfolio renders, live off an IEX snapshot's dailyBar/
//               latestTrade (core/market-data.js getLivePrice,
//               fetchSnapshots feed:'iex', no recency embargo on IEX) --
//               there is no dampening, no "only checks the close" gate
//               anywhere in that path. This basis is the honest model of
//               production today, not a hypothetical.
//   persist2 -- first day that is the SECOND of two CONSECUTIVE closes
//               both across the threshold, both strictly after entry (a
//               single-day dip that recovers the next close never fires).
//
// Threshold definitions:
//   pct  -- buyPrice * (1 + pct/100), pct in {-4,-5,-6,-8,-10,-12,-15}.
//   atr  -- buyPrice - multiplier * trimmedAtrAtBuy, multiplier in
//           {1.5, 2, 2.5}. trades.json has ZERO of the 37 trades with
//           trimmed_atr_at_buy populated (checked directly, not assumed
//           -- the column simply predates capture for this trade set),
//           so this recomputes the identical quantity core/indicators.js
//           calcTrimmedATR() would have produced at buy time, from the
//           same 15-daily-bar lookback ending on buy_date, using the
//           SAME function (loaded from the real source file, not
//           reimplemented) -- a recomputed proxy for the missing column,
//           stated as such, not the stored value.
//
// Every cell reports: book total, trades triggered, and the single
// largest-swing trade's ticker/dollar-swing/% of the cell's total
// (floor-applied minus actual) delta -- the same check that found BTDR
// eating 92% of the -6%/close-only margin, applied uniformly so no other
// cell's concentration risk goes unmeasured the same way -6%'s almost did.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReplayBasis, findTrigger, floorDollar } from './lib/floor-replay.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PCT_THRESHOLDS = [-4, -5, -6, -8, -10, -12, -15];
const ATR_MULTIPLIERS = [1.5, 2, 2.5];
const BASES = ['close', 'any', 'persist2'];

function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) kv[m[1]] = m[2]; }
  return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
}
async function main() {
  const { alpacaKeyId, alpacaSecretKey } = readEnvLocal();
  global.state = { settings: { alpacaKey: alpacaKeyId, alpacaSecret: alpacaSecretKey } };
  const apiClientSrc = readFileSync(path.join(REPO_ROOT, 'core', 'api-client.js'), 'utf8');
  eval(apiClientSrc + '\nglobal.alpacaGet = alpacaGet; global.sipSafeEndParams = sipSafeEndParams;');
  const indicatorsSrc = readFileSync(path.join(REPO_ROOT, 'core', 'indicators.js'), 'utf8');
  eval(indicatorsSrc + '\nglobal.calcTrimmedATR = calcTrimmedATR;');

  const trades = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'backups', 'trades.json'), 'utf8'));
  console.log(`Loaded ${trades.length} trades from data/backups/trades.json.`);

  // Trade set, alignment and split exclusion: scripts/lib/floor-replay.mjs,
  // shared with replay-floor-with-recovery.mjs. 35 calendar days before
  // buy_date -- comfortably >15 trading days for the ATR lookback
  // (calcTrimmedATR needs the 15 bars ENDING at entry).
  const basis = await loadReplayBasis(trades, { alpacaGet: global.alpacaGet, sipSafeEndParams: global.sipSafeEndParams, preBuyDays: 35, postSellDays: 3 });
  const perTrade = basis.perTrade;
  for (const r of perTrade) {
    if (r.error) continue;
    r.trimmedAtrAtBuy = null;
    if (r.entryIdx >= 14) {
      r.trimmedAtrAtBuy = global.calcTrimmedATR(r.allBars.slice(0, r.entryIdx + 1));
      if (!(r.trimmedAtrAtBuy > 0)) r.trimmedAtrAtBuy = null; // 0/NaN from calcTrimmedATR's own <15-bar guard treated as "not computable," not a real zero-volatility reading
    }
  }

  const errors = perTrade.filter(r => r.error);
  const splitExcluded = perTrade.filter(r => !r.error && r.splitInHold);
  const clean = perTrade.filter(r => !r.error && !r.splitInHold);
  console.log(`${perTrade.length} trades processed: ${errors.length} fetch/align errors, ${splitExcluded.length} split-in-hold (excluded from every cell), ${clean.length} usable.`);
  if (errors.length) errors.forEach(e => console.log(`  ERROR ${e.ticker}: ${e.error}`));
  if (splitExcluded.length) splitExcluded.forEach(e => console.log(`  SPLIT ${e.ticker} ${e.trade.buy_date}->${e.trade.sell_date}`));
  const atrMissing = clean.filter(r => r.trimmedAtrAtBuy == null).length;
  console.log(`${atrMissing} of ${clean.length} usable trades have <15 trading days of history before buy_date -- excluded from ATR-scaled cells specifically (still included in pct-based cells).`);

  function runCell(thresholdFn, basis, label) {
    const rows = clean.filter(r => thresholdFn(r) != null);
    let bookTotal = 0, triggeredCount = 0;
    let biggestSwing = null; // { ticker, swing, floorDollar, actualDollar }
    let totalDelta = 0; // sum of (floorDollar - actualDollar) across triggered trades -- the cell's own margin over "no cap at all" restricted to just the trades this cell touches
    const triggeredList = [];
    for (const r of rows) {
      const thresholdPrice = thresholdFn(r);
      const idx = findTrigger(r.allBars, r.entryIdx, r.sellIdx, thresholdPrice, basis);
      if (idx == null) { bookTotal += r.trade.pnl_dollars; continue; }
      triggeredCount++;
      const floorD = floorDollar(r.trade, thresholdPrice);
      const delta = floorD - r.trade.pnl_dollars;
      totalDelta += delta;
      bookTotal += floorD;
      triggeredList.push({ ticker: r.ticker, delta, floorDollar: floorD, actualDollar: r.trade.pnl_dollars });
      if (biggestSwing == null || Math.abs(delta) > Math.abs(biggestSwing.delta)) {
        biggestSwing = { ticker: r.ticker, delta, floorDollar: floorD, actualDollar: r.trade.pnl_dollars };
      }
    }
    const pctOfDelta = biggestSwing && totalDelta !== 0 ? (biggestSwing.delta / totalDelta) * 100 : null;
    return { label, n: rows.length, bookTotal, triggeredCount, biggestSwing, pctOfDelta, triggeredList };
  }

  console.log(`\n${'='.repeat(78)}\nPERCENTAGE-THRESHOLD GRID (${clean.length}-trade basis)\n${'='.repeat(78)}`);
  const pctResults = [];
  for (const pct of PCT_THRESHOLDS) {
    for (const basis of BASES) {
      const res = runCell((r) => r.trade.buy_price * (1 + pct / 100), basis, `${pct}% / ${basis}`);
      pctResults.push({ pct, basis, ...res });
    }
  }
  const actualTotal = clean.reduce((s, r) => s + r.trade.pnl_dollars, 0);
  console.log(`Actual (no cap at all), same ${clean.length}-trade basis: $${actualTotal.toFixed(2)}\n`);
  console.log('pct    basis      n  triggered  book_total   vs_actual   biggest_contributor');
  for (const r of pctResults) {
    const vsActual = r.bookTotal - actualTotal;
    const biggest = r.biggestSwing
      ? `${r.biggestSwing.ticker} ${r.biggestSwing.delta >= 0 ? '+' : ''}$${r.biggestSwing.delta.toFixed(2)}${r.pctOfDelta != null ? ` (${r.pctOfDelta.toFixed(0)}% of this cell's delta)` : ''}`
      : '(none triggered)';
    console.log(`${String(r.pct).padStart(4)}%  ${r.basis.padEnd(9)}  ${String(r.n).padStart(2)}  ${String(r.triggeredCount).padStart(9)}  $${r.bookTotal.toFixed(2).padStart(9)}  ${vsActual >= 0 ? '+' : ''}$${vsActual.toFixed(2).padStart(8)}  ${biggest}`);
    if (r.pct === -6) {
      console.log(`       [-6% ${r.basis} full trigger list: ${r.triggeredList.map(x => `${x.ticker} ${x.delta>=0?'+':''}$${x.delta.toFixed(2)}`).join(', ') || '(none)'}]`);
    }
  }

  console.log(`\n${'='.repeat(78)}\nATR-SCALED GRID (recomputed trimmedAtrAtBuy, ${atrMissing} of ${clean.length} excluded for <15d history)\n${'='.repeat(78)}`);
  const atrRows = clean.filter(r => r.trimmedAtrAtBuy != null);
  const atrActualTotal = atrRows.reduce((s, r) => s + r.trade.pnl_dollars, 0);
  console.log(`Actual (no cap at all), same ${atrRows.length}-trade ATR-computable basis: $${atrActualTotal.toFixed(2)}\n`);
  console.log('mult   basis      n  triggered  book_total   vs_actual   biggest_contributor');
  for (const mult of ATR_MULTIPLIERS) {
    for (const basis of BASES) {
      const res = runCell((r) => r.trimmedAtrAtBuy != null ? r.trade.buy_price - mult * r.trimmedAtrAtBuy : null, basis, `${mult}x / ${basis}`);
      const vsActual = res.bookTotal - atrActualTotal;
      const biggest = res.biggestSwing
        ? `${res.biggestSwing.ticker} ${res.biggestSwing.delta >= 0 ? '+' : ''}$${res.biggestSwing.delta.toFixed(2)}${res.pctOfDelta != null ? ` (${res.pctOfDelta.toFixed(0)}% of this cell's delta)` : ''}`
        : '(none triggered)';
      console.log(`${String(mult).padStart(4)}x  ${basis.padEnd(9)}  ${String(res.n).padStart(2)}  ${String(res.triggeredCount).padStart(9)}  $${res.bookTotal.toFixed(2).padStart(9)}  ${vsActual >= 0 ? '+' : ''}$${vsActual.toFixed(2).padStart(8)}  ${biggest}`);
    }
  }
}

main().catch((err) => { console.error('[replay-floor-grid] FAILED —', err.message, err.stack); process.exit(1); });
