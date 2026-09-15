#!/usr/bin/env node
// Phase 9 §3.3 validation (Roman, 2026-09-15): the question that decides
// whether Model B ships. Not "would it have made him sell early" (already
// answered: 0/25) -- the inverse: on the ACTUAL SELL DAY of each of his 25
// winning trades, what did Model B say, and was that "hold" advice
// correct? Correct = the stock kept running after he sold. Wrong = it
// fell, and holding would have given back some of the gain he'd already
// banked.
//
// Reference points verified against live trades_v2 before running this at
// scale: BITO sold +0.93%, best_exit_price implies +25.8% was available
// (buy 8.58, best_exit 10.79) -- matches Roman's own +25.9% figure. AMC
// +0.81% vs +11.3% available -- matches +11.1%. BTDR (the LOSING trade,
// not a winner, cited only as a cross-check) -7.22% vs +25.2% available
// at best_exit -- matches +25.1%. All three same-day trades (BITO, AMC
// bought and sold same session) -- see the finding this produces below.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
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

  const modelB = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'exit-model-b.json'), 'utf8'));
  const trades = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'backups', 'trades.json'), 'utf8'));
  const winners = trades.filter(t => t.pnl_pct > 0);
  console.log(`${winners.length} winning trades`);

  const rows = [];
  for (const t of winners) {
    // trades_v2's own outcome columns -- what actually happened after sale.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/trades_v2?ticker=eq.${t.ticker}&buy_date=eq.${t.buy_date}&sell_date=eq.${t.sell_date}&select=best_exit_price,best_exit_date,best_exit_timing,price_at_plus1_day,price_at_plus2_days,price_at_plus5_days,sell_timing_resolved`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    const [outcome] = await res.json();

    const fetchStart = new Date(new Date(t.buy_date + 'T00:00:00Z').getTime() - 45 * 86400000).toISOString().slice(0, 10);
    let bars;
    try {
      const data = await global.alpacaGet(`/stocks/${t.ticker}/bars`, {
        timeframe: '1Day', start: fetchStart, limit: 1000, sort: 'asc', feed: 'sip', adjustment: 'all',
        ...global.sipSafeEndParams(t.sell_date),
      });
      bars = (data.bars || []).sort((a, b) => new Date(a.t) - new Date(b.t));
    } catch (e) {
      rows.push({ ticker: t.ticker, buy_date: t.buy_date, sell_date: t.sell_date, actual_pnl_pct: +t.pnl_pct.toFixed(2), error: e.message });
      continue;
    }
    const entryIdx = bars.findIndex(b => barDate(b) === t.buy_date);
    const sellIdx = bars.findIndex(b => barDate(b) === t.sell_date);
    if (entryIdx === -1 || sellIdx === -1 || entryIdx < LOOKBACK_MIN_BARS) {
      rows.push({ ticker: t.ticker, buy_date: t.buy_date, sell_date: t.sell_date, actual_pnl_pct: +t.pnl_pct.toFixed(2), error: 'insufficient bars' });
      continue;
    }
    const holdDays = sellIdx - entryIdx;
    const entryClose = bars[entryIdx].c;
    const prevEntryBar = bars[entryIdx - 1];
    const entryDayOverDayPct = prevEntryBar && prevEntryBar.c ? ((entryClose - prevEntryBar.c) / prevEntryBar.c) * 100 : null;
    const closesToEntry = bars.slice(0, entryIdx + 1).map(b => b.c);
    const volumesToEntry = bars.slice(0, entryIdx + 1).map(b => b.v);
    const entryVolRatio = (() => { const avg = global.calcAvgVolume(volumesToEntry, 20); return avg > 0 ? bars[entryIdx].v / avg : null; })();
    const branch = (entryVolRatio != null && entryVolRatio >= MOMENTUM_VOL_RATIO_MIN
      && entryDayOverDayPct != null && entryDayOverDayPct >= MOMENTUM_DAYOVERDAY_MIN) ? 'momentum' : 'non_momentum';

    let cell = null;
    if (holdDays === 0) {
      cell = { status: 'NOT_EVALUATED', reason: 'day_0_structural' };
    } else {
      const closesRunning = bars.slice(0, sellIdx + 1).map(b => b.c);
      const volumesRunning = bars.slice(0, sellIdx + 1).map(b => b.v);
      const sellClose = bars[sellIdx].c;
      const retPct = ((sellClose - entryClose) / entryClose) * 100;
      if (retPct <= 0) {
        cell = { status: 'NOT_EVALUATED', reason: 'sell_day_close_not_actually_up' };
      } else {
        const rsi14 = global.calcRSI(closesRunning);
        const avgVol20 = global.calcAvgVolume(volumesRunning, 20);
        const volRatioAtD = avgVol20 > 0 ? bars[sellIdx].v / avgVol20 : null;
        const rb = rsiBand(rsi14), vb = volBand(volRatioAtD);
        const day = dayBucket(holdDays);
        if (rb == null || vb == null) cell = { status: 'NOT_EVALUATED', reason: 'missing_indicator' };
        else {
          const key = `${gainBand(retPct)}|${day}|${rb}|${vb}`;
          cell = modelB.branches[branch]?.[key] || { status: 'NOT_EVALUATED', reason: 'no_such_key' };
        }
      }
    }

    const additionalGainAvailablePct = (outcome && outcome.best_exit_timing === 'AFTER' && outcome.best_exit_price != null)
      ? +(((outcome.best_exit_price - t.sell_price) / t.sell_price) * 100).toFixed(2)
      : (outcome && (outcome.best_exit_timing === 'BEFORE' || outcome.best_exit_timing === 'ON') ? 0 : null);

    rows.push({
      ticker: t.ticker, buy_date: t.buy_date, sell_date: t.sell_date, sell_price: t.sell_price, hold_days: holdDays, branch,
      actual_pnl_pct: +t.pnl_pct.toFixed(2), model_cell: cell,
      best_exit_price: outcome?.best_exit_price ?? null, best_exit_timing: outcome?.best_exit_timing ?? null,
      price_at_plus1_day: outcome?.price_at_plus1_day ?? null, price_at_plus2_days: outcome?.price_at_plus2_days ?? null, price_at_plus5_days: outcome?.price_at_plus5_days ?? null,
      additional_gain_available_pct: additionalGainAvailablePct,
    });
  }

  console.log('\n=== ALL 25 WINNERS: sell-day model read vs what actually happened next ===');
  console.log(JSON.stringify(rows, null, 2));

  const evaluable = rows.filter(r => r.model_cell && r.model_cell.status === 'evaluated');
  const notEvaluable = rows.filter(r => !r.model_cell || r.model_cell.status !== 'evaluated');
  console.log(`\n${evaluable.length}/${rows.length} winners had an evaluable model read on their actual sell day.`);
  console.log('Not evaluable, by reason:', JSON.stringify(notEvaluable.reduce((acc, r) => { const k = r.error ? 'fetch_error' : r.model_cell?.reason || 'unknown'; acc[k] = (acc[k] || 0) + 1; return acc; }, {})));

  const holdAdvised = evaluable.filter(r => r.model_cell.p_peak_already_in <= 50);
  const sellAdvised = evaluable.filter(r => r.model_cell.p_peak_already_in > 50);
  console.log(`\nOf ${evaluable.length} evaluable: model said HOLD (p_peak_already_in<=50) on ${holdAdvised.length}, SELL (>50) on ${sellAdvised.length}.`);

  let holdCorrectGain = 0, holdWrongGivebackPct = 0, holdCorrectCount = 0, holdWrongCount = 0, holdAmbiguous = 0;
  const holdWrongDetail = [];
  for (const r of holdAdvised) {
    if (r.additional_gain_available_pct == null) { holdAmbiguous++; continue; }
    if (r.additional_gain_available_pct > 0) { holdCorrectGain += r.additional_gain_available_pct; holdCorrectCount++; }
    else {
      // Peak was at/before the sale -- holding would not have added gain.
      // Giveback = how much of the ALREADY-BANKED gain 5 more sessions of
      // holding would have surrendered, as a % of the sell price. Floored
      // at 0 -- a flat/roughly-unchanged price afterward is "didn't help",
      // not "cost him", and shouldn't be counted as a loss.
      const givebackPct = r.price_at_plus5_days != null
        ? Math.max(0, ((r.sell_price - r.price_at_plus5_days) / r.sell_price) * 100)
        : null;
      if (givebackPct != null) { holdWrongGivebackPct += givebackPct; holdWrongDetail.push({ ticker: r.ticker, givebackPct: +givebackPct.toFixed(2) }); }
      holdWrongCount++;
    }
  }
  console.log(`\nModel said HOLD and was directionally right (stock kept running after sale): ${holdCorrectCount}/${holdAdvised.length - holdAmbiguous}, total additional gain that was genuinely available: +${holdCorrectGain.toFixed(1)}pp summed across those trades`);
  console.log(`Model said HOLD but peak was already at/before the sale: ${holdWrongCount}/${holdAdvised.length - holdAmbiguous}, total giveback if he'd held 5 more sessions anyway: -${holdWrongGivebackPct.toFixed(1)}pp summed`, JSON.stringify(holdWrongDetail));
  console.log(`Ambiguous (best_exit_timing unresolved/missing): ${holdAmbiguous}`);

  if (sellAdvised.length) {
    console.log(`\nModel said SELL (p_peak_already_in>50) on ${sellAdvised.length} trade(s) where Roman also sold -- agreement, not disagreement:`, JSON.stringify(sellAdvised.map(r => ({ ticker: r.ticker, p_peak_already_in: r.model_cell.p_peak_already_in, additional_gain_available_pct: r.additional_gain_available_pct }))));
  }
}

main().catch((err) => { console.error('[analyze] FAILED —', err.message, err.stack); process.exit(1); });
