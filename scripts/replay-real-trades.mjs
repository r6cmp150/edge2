#!/usr/bin/env node
// Phase 9 §3.2/§3.3, task 2 (Roman, 2026-09-15): replay all 37 of Roman's
// real closed trades (data/backups/trades.json -- the exact evidence base
// §0 of the spec cites) through both built models, day by day. None of
// these trades trained the tables (built entirely from Alpaca history,
// $1-$20 universe-wide) -- his book is genuinely out-of-sample. n=37 is
// illustrative, not validation, and is reported as such.
//
// Same-day trades (buy_date===sell_date, 13 of 37, confirmed against
// §3.1.3's own count) have exactly one evaluable day: day 0 itself, which
// is ALWAYS NOT_EVALUATED (structural, see build-exit-model-tables.mjs).
// For those, the model has nothing to say at any point during the hold --
// reported as such, not glossed over.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_LOSS_PCT = 6; // §3.4, current default
const MOMENTUM_VOL_RATIO_MIN = 1.0;
const MOMENTUM_DAYOVERDAY_MIN = 2.0;
const LOOKBACK_MIN_BARS = 20;

function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) kv[m[1]] = m[2]; }
  return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
}
function barDate(b) { return (b.t || '').split('T')[0]; }

function lossBand(retPct) {
  if (retPct > -2) return '-2'; if (retPct > -4) return '-4'; if (retPct > -6) return '-6';
  if (retPct > -8) return '-8'; if (retPct > -10) return '-10'; return 'worse';
}
function gainBand(retPct) {
  if (retPct < 2) return '+2'; if (retPct < 4) return '+4'; if (retPct < 6) return '+6';
  if (retPct < 8) return '+8'; if (retPct < 10) return '+10'; return 'better';
}
function rsiBand(rsi) { if (rsi == null) return null; if (rsi < 30) return '<30'; if (rsi < 45) return '30-45'; if (rsi < 60) return '45-60'; return '>60'; }
function volBand(v) { if (v == null) return null; if (v < 0.75) return '<0.75'; if (v < 1.5) return '0.75-1.5'; return '>1.5'; }
function dayBucket(d) { if (d === 0) return '0'; return d === 1 ? '1' : d === 2 ? '2' : '3+'; }

async function main() {
  const { alpacaKeyId, alpacaSecretKey } = readEnvLocal();
  global.state = { settings: { alpacaKey: alpacaKeyId, alpacaSecret: alpacaSecretKey } };
  global.persist = () => {};
  const apiClientSrc = readFileSync(path.join(REPO_ROOT, 'core', 'api-client.js'), 'utf8');
  eval(apiClientSrc + '\nglobal.alpacaGet = alpacaGet; global._coreClient = _coreClient; global.sipSafeEndParams = sipSafeEndParams;');
  const indicatorsSrc = readFileSync(path.join(REPO_ROOT, 'core', 'indicators.js'), 'utf8');
  eval(indicatorsSrc + '\nglobal.calcRSI = calcRSI; global.calcMA = calcMA; global.calcAvgVolume = calcAvgVolume;');

  const modelA = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'exit-model-a.json'), 'utf8'));
  const modelB = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'exit-model-b.json'), 'utf8'));
  const trades = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'backups', 'trades.json'), 'utf8'));

  function lookup(table, band, day, rb, vb, branch) {
    const key = `${band}|${day}|${rb}|${vb}`;
    return table.branches[branch]?.[key] || null;
  }

  const NAMED = ['TENX', 'KEEL', 'BTDR', 'NEOG', 'PGEN'];
  const results = [];

  for (const t of trades) {
    const fetchStart = new Date(new Date(t.buy_date + 'T00:00:00Z').getTime() - 45 * 86400000).toISOString().slice(0, 10);
    let bars;
    try {
      const data = await global.alpacaGet(`/stocks/${t.ticker}/bars`, {
        timeframe: '1Day', start: fetchStart, limit: 1000, sort: 'asc', feed: 'sip', adjustment: 'all',
        ...global.sipSafeEndParams(t.sell_date),
      });
      bars = (data.bars || []).sort((a, b) => new Date(a.t) - new Date(b.t));
    } catch (e) {
      results.push({ ticker: t.ticker, buy_date: t.buy_date, error: e.message });
      continue;
    }
    const entryIdx = bars.findIndex(b => barDate(b) === t.buy_date);
    const sellIdx = bars.findIndex(b => barDate(b) === t.sell_date);
    if (entryIdx === -1 || sellIdx === -1 || entryIdx < LOOKBACK_MIN_BARS) {
      results.push({ ticker: t.ticker, buy_date: t.buy_date, error: `insufficient bars (entryIdx=${entryIdx}, sellIdx=${sellIdx})` });
      continue;
    }
    const entryClose = bars[entryIdx].c;
    const prevEntryBar = bars[entryIdx - 1];
    const entryDayOverDayPct = prevEntryBar && prevEntryBar.c ? ((entryClose - prevEntryBar.c) / prevEntryBar.c) * 100 : null;
    const closesToEntry = bars.slice(0, entryIdx + 1).map(b => b.c);
    const volumesToEntry = bars.slice(0, entryIdx + 1).map(b => b.v);
    const entryVolRatio = (() => {
      const avg20 = global.calcAvgVolume(volumesToEntry, 20);
      return avg20 > 0 ? bars[entryIdx].v / avg20 : null;
    })();
    const branch = (entryVolRatio != null && entryVolRatio >= MOMENTUM_VOL_RATIO_MIN
      && entryDayOverDayPct != null && entryDayOverDayPct >= MOMENTUM_DAYOVERDAY_MIN) ? 'momentum' : 'non_momentum';

    const days = [];
    let floorDay = null;
    const closesRunning = closesToEntry.slice();
    const volumesRunning = volumesToEntry.slice();
    for (let idx = entryIdx; idx <= sellIdx; idx++) {
      const d = idx - entryIdx;
      const bar = bars[idx];
      if (idx > entryIdx) { closesRunning.push(bar.c); volumesRunning.push(bar.v); }
      const retPct = ((bar.c - entryClose) / entryClose) * 100;
      if (floorDay == null && retPct <= -MAX_LOSS_PCT + 1e-9) floorDay = d;

      let cell = null, model = null;
      const day = dayBucket(d);
      if (d === 0) {
        cell = { status: 'NOT_EVALUATED', reason: 'day_0_structural' }; model = null;
      } else if (retPct === 0) {
        cell = { status: 'NOT_EVALUATED', reason: 'exact_breakeven' }; model = null;
      } else {
        const rsi14 = global.calcRSI(closesRunning);
        const avgVol20 = global.calcAvgVolume(volumesRunning, 20);
        const volRatioAtD = avgVol20 > 0 ? bar.v / avgVol20 : null;
        const rb = rsiBand(rsi14), vb = volBand(volRatioAtD);
        if (rb == null || vb == null) { cell = { status: 'NOT_EVALUATED', reason: 'missing_indicator' }; }
        else if (retPct < 0) { model = 'A'; cell = lookup(modelA, lossBand(retPct), day, rb, vb, branch); }
        else { model = 'B'; cell = lookup(modelB, gainBand(retPct), day, rb, vb, branch); }
      }
      days.push({ d, date: barDate(bar), retPct: +retPct.toFixed(2), model, cell });
    }
    results.push({ ticker: t.ticker, buy_date: t.buy_date, sell_date: t.sell_date, pnl_pct: t.pnl_pct, branch, floorDay, holdDays: sellIdx - entryIdx, days });
  }

  console.log('=== NAMED TRADES: day-by-day model output vs floor ===');
  for (const name of NAMED) {
    const matches = results.filter(r => r.ticker === name);
    for (const r of matches) {
      console.log(`\n-- ${r.ticker} ${r.buy_date}->${r.sell_date} (actual pnl ${r.pnl_pct?.toFixed(2)}%, branch=${r.branch}, floor would fire on hold-day=${r.floorDay ?? 'never during this hold'}) --`);
      if (r.error) { console.log('  ERROR:', r.error); continue; }
      for (const day of r.days) {
        console.log(`  day ${day.d} (${day.date}) ret=${day.retPct}% ->`, JSON.stringify(day.cell));
      }
    }
  }

  console.log('\n\n=== ALL LOSING TRADES: does the model warn before the floor fires? ===');
  const losers = results.filter(r => !r.error && r.pnl_pct < 0);
  console.log(`(${losers.length} losing trades)`);
  for (const r of losers) {
    const firstEvaluable = r.days.find(d => d.cell && d.cell.status === 'evaluated');
    const summary = {
      ticker: r.ticker, buy_date: r.buy_date, sell_date: r.sell_date, actual_pnl_pct: +r.pnl_pct.toFixed(2),
      floor_day: r.floorDay, same_day_as_first_evaluable: firstEvaluable ? firstEvaluable.d === r.floorDay : null,
      first_evaluable_day: firstEvaluable ? firstEvaluable.d : 'none (all NOT_EVALUATED, e.g. pure same-day trade)',
      p_recover_2d_at_first_evaluable: firstEvaluable && firstEvaluable.model === 'A' ? firstEvaluable.cell.p_recover_2d : null,
    };
    console.log(JSON.stringify(summary));
  }

  console.log('\n\n=== ALL 25 WINNERS: earliest day Model B would have said sell (p_peak_already_in > 50), vs actual sell ===');
  const winners = results.filter(r => !r.error && r.pnl_pct > 0);
  console.log(`(${winners.length} winners replayed)`);
  const earlySellSummary = [];
  for (const r of winners) {
    let earliestSellDay = null;
    for (const day of r.days) {
      if (day.model === 'B' && day.cell && day.cell.status === 'evaluated' && day.cell.p_peak_already_in > 50) {
        earliestSellDay = day; break;
      }
    }
    earlySellSummary.push({
      ticker: r.ticker, buy_date: r.buy_date, sell_date: r.sell_date, actual_pnl_pct: r.pnl_pct, hold_days: r.holdDays,
      earliest_model_sell_day: earliestSellDay ? earliestSellDay.d : null,
      ret_at_earliest_sell: earliestSellDay ? earliestSellDay.retPct : null,
      would_have_sold_earlier: earliestSellDay ? earliestSellDay.d < r.holdDays : false,
    });
  }
  console.log(JSON.stringify(earlySellSummary, null, 2));
  const wouldHaveSoldEarlier = earlySellSummary.filter(x => x.would_have_sold_earlier);
  console.log(`\n${wouldHaveSoldEarlier.length}/${winners.length} winners: model would have signaled sell (p_peak_already_in>50) BEFORE the actual sell day`);
  let costTotal = 0;
  for (const x of wouldHaveSoldEarlier) {
    const cost = x.actual_pnl_pct - x.ret_at_earliest_sell;
    costTotal += cost;
    console.log(`  ${x.ticker}: sold at model-day ${x.earliest_model_sell_day} (${x.ret_at_earliest_sell}%) vs actual day ${x.hold_days} (${x.actual_pnl_pct.toFixed(2)}%) -> ${cost >= 0 ? 'cost' : 'saved'} ${Math.abs(cost).toFixed(2)}pp`);
  }
  console.log(`total pp difference across those trades if the model's earlier-sell signal had been followed: ${costTotal.toFixed(2)}pp`);
}

main().catch((err) => { console.error('[replay] FAILED —', err.message, err.stack); process.exit(1); });
