#!/usr/bin/env node
// Phase 9 §0.3 correction (Roman, 2026-09-16): the original -6% hard-cap
// replay assumed a clean exit at the cap and never asked what the stock
// did afterward -- exactly the same blind spot "Did I sell too early?"
// found in Roman's REAL sells (BTDR sold at -7.2%, then +29.2% at +5d).
// This re-runs the SAME trades (data/backups/trades.json, minus any with a
// split in the hold -- 33 of 37 as of 2026-10-21; the
// exact evidence base §0's own header cites) with the counterfactual
// attached: for every trade whose price path crossed -6% of cost basis
// -- intraday (daily LOW) or on a close, whichever came first -- what did
// it do at +1/+2/+5 TRADING days after the FLOOR'S OWN trigger point, not
// after Roman's actual (different day, different price) sale.
//
// Cost basis is the REAL buy_price from trades.json, not a bar's close on
// the buy date -- "hard cut at N% of cost basis" (§0.3's own phrase)
// means N% of what Roman actually paid, matching the app's own floor
// check in calcUnifiedRecommendation (pnlPct <= -MAX_LOSS_PCT+1e-9,
// pnlPct computed against position.buyPrice).
//
// Split/data-error guard: same shape as scripts/lib/sell-timing.mjs --
// raw vs adjustment=all divergence anywhere in the relevant window nulls
// the counterfactual rather than reporting a number corrupted by a split,
// with the exclusion stated explicitly, not silently dropped.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSplitInWindow } from './lib/sell-timing.mjs';
import { loadReplayBasis, findTrigger, floorDollar, barDate } from './lib/floor-replay.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_LOSS_PCT = 6;

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

  const trades = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'backups', 'trades.json'), 'utf8'));
  console.log(`Loaded ${trades.length} trades from data/backups/trades.json.`);

  // Trade set, alignment, split exclusion and trigger detection come from
  // scripts/lib/floor-replay.mjs, shared with replay-floor-grid.mjs, so
  // this script's floor totals cannot disagree with the grid's -6% rows.
  // What is unique here is only the post-trigger counterfactual below.
  // (Before 2026-10-21 this script had its own copies, and its split check
  // guarded only the counterfactual: BIZD's split-adjusted hold still set a
  // trigger and the floor total, 37 trades instead of 33.)
  const { errors, splitExcluded, clean: usable } = await loadReplayBasis(trades, { alpacaGet: global.alpacaGet, sipSafeEndParams: global.sipSafeEndParams, preBuyDays: 5, postSellDays: 20 });
  const floorTriggerPrice = t => t.buy_price * (1 - MAX_LOSS_PCT / 100);

  function buildCounterfactual(r, basis) {
    const { allBars, rawBars, entryIdx, sellIdx, trade } = r;
    const price = floorTriggerPrice(trade);
    const floorIdx = findTrigger(allBars, entryIdx, sellIdx, price, basis);
    if (floorIdx == null) return { crossed: false };
    const via = basis === 'any' && allBars[floorIdx].l <= price + 1e-9 ? 'intraday low' : 'close';
    const idx1 = floorIdx + 1, idx2 = floorIdx + 2, idx5 = floorIdx + 5;
    const haveEnough = allBars.length > idx5 && rawBars.length > idx5;
    const splitInWindow = haveEnough && detectSplitInWindow(allBars, rawBars, idx5, entryIdx);
    const priceAt = (idx) => (haveEnough && !splitInWindow && allBars[idx]) ? allBars[idx].c : null;
    const pctFromTrigger = (p) => p != null ? ((p - price) / price) * 100 : null;
    return {
      crossed: true, floorDate: barDate(allBars[floorIdx]), floorVia: via, floorTriggerPrice: price,
      insufficientData: !haveEnough, splitInWindow,
      priceAt1: priceAt(idx1), priceAt2: priceAt(idx2), priceAt5: priceAt(idx5),
      pctAt1: pctFromTrigger(priceAt(idx1)), pctAt2: pctFromTrigger(priceAt(idx2)), pctAt5: pctFromTrigger(priceAt(idx5)),
      dateAt5: (haveEnough && allBars[idx5]) ? barDate(allBars[idx5]) : null,
    };
  }
  const clean = usable.map(r => ({ ticker: r.ticker, buy_date: r.trade.buy_date, sell_date: r.trade.sell_date, trade: r.trade,
    anyBreach: buildCounterfactual(r, 'any'), closeOnly: buildCounterfactual(r, 'close') }));

  if (errors.length) {
    console.log(`
${errors.length} trade(s) FAILED to fetch/align -- excluded from totals, reported separately:`);
    errors.forEach(e => console.log(`  ${e.ticker} ${e.trade.buy_date}->${e.trade.sell_date}: ${e.error}`));
  }
  if (splitExcluded.length) {
    console.log(`
${splitExcluded.length} trade(s) excluded for a split in the hold (same check as replay-floor-grid.mjs):`);
    splitExcluded.forEach(e => console.log(`  SPLIT ${e.ticker} ${e.trade.buy_date}->${e.trade.sell_date}`));
  }

  function report(scenarioKey, scenarioLabel) {
    const crossers = clean.filter(r => r[scenarioKey].crossed);
    console.log(`\n${'='.repeat(70)}\nSCENARIO: ${scenarioLabel}\n${'='.repeat(70)}`);
    console.log(`${crossers.length} of ${clean.length} trades crossed -6% of cost basis under this definition:`);
    for (const r of crossers) {
      const c = r[scenarioKey];
      console.log(`  ${r.ticker.padEnd(6)} buy ${r.buy_date} -> floor trigger ${c.floorDate} (via ${c.floorVia}, price $${c.floorTriggerPrice.toFixed(2)}) -> actual sell ${r.sell_date} ${r.trade.pnl_pct.toFixed(1)}%`);
      const floorD = floorDollar(r.trade, c.floorTriggerPrice);
      const delta = floorD - r.trade.pnl_dollars; // negative = floor cost him money on this specific trade vs what actually happened
      console.log(`    floor-applied $${floorD.toFixed(2)} vs actual $${r.trade.pnl_dollars.toFixed(2)} -> floor ${delta >= 0 ? 'gained' : 'cost'} $${Math.abs(delta).toFixed(2)} on this trade`);
      if (c.insufficientData) { console.log(`    INSUFFICIENT DATA past the trigger -- excluded from the recovery counterfactual.`); continue; }
      if (c.splitInWindow) { console.log(`    SPLIT DETECTED in the +1..+5d window -- excluded from the recovery counterfactual.`); continue; }
      console.log(`    off the FLOOR'S trigger price: +1d ${c.pctAt1?.toFixed(1)}%  +2d ${c.pctAt2?.toFixed(1)}%  +5d ${c.pctAt5?.toFixed(1)}% (${c.dateAt5})`);
    }

    let actualTotal = 0, floorAppliedTotal = 0, hold5Total = 0, hold5ExcludedCount = 0;
    const hold5ExcludedTickers = [];
    for (const r of clean) {
      actualTotal += r.trade.pnl_dollars;
      const c = r[scenarioKey];
      if (!c.crossed) { floorAppliedTotal += r.trade.pnl_dollars; hold5Total += r.trade.pnl_dollars; continue; }
      floorAppliedTotal += floorDollar(r.trade, c.floorTriggerPrice);
      if (c.priceAt5 != null) {
        hold5Total += r.trade.shares * (c.priceAt5 - r.trade.buy_price);
      } else {
        // Never average/sum a null as zero -- excluded explicitly, named.
        hold5ExcludedCount++;
        hold5ExcludedTickers.push(r.ticker);
      }
    }

    console.log(`\n-- THREE TOTALS, same ${clean.length}-trade basis (${scenarioLabel}) --`);
    console.log(`Actual (what really happened):                            $${actualTotal.toFixed(2)}`);
    console.log(`Floor-applied (clean exit at -6%, ${crossers.length} trade(s) affected):   $${floorAppliedTotal.toFixed(2)}`);
    const hold5Note = hold5ExcludedCount
      ? ` (${crossers.length - hold5ExcludedCount}/${crossers.length} crossers computable, ${hold5ExcludedCount} excluded [${hold5ExcludedTickers.join(', ')}] -- NOT assumed zero)`
      : ` (all ${crossers.length} crossers computable)`;
    console.log(`Hold-5-more-days-past-the-trigger:                        $${hold5Total.toFixed(2)}${hold5Note}`);
    console.log(`Floor vs hold-5-more-days: ${(floorAppliedTotal - hold5Total) >= 0 ? 'floor wins by' : 'hold-5-more-days wins by'} $${Math.abs(floorAppliedTotal - hold5Total).toFixed(2)}`);
    return { actualTotal, floorAppliedTotal, hold5Total };
  }

  report('anyBreach', 'ANY BREACH (intraday low OR close <= -6% -- the theoretical upper bound; true only if a continuous stop existed or Roman was watching at the exact low)');
  report('closeOnly', 'CLOSE ONLY (daily close <= -6% -- approximates what a normal daily check of the app would actually have shown, since calcUnifiedRecommendation only evaluates when the portfolio is rendered, not continuously)');
}

main().catch((err) => { console.error('[replay-floor-with-recovery] FAILED —', err.message, err.stack); process.exit(1); });
