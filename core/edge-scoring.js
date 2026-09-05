// core/edge-scoring.js -- owned by neither engine. core/ never imports from engines/.
// EDGE's candidate scoring: scoreStock and its direct dependencies, moved
// VERBATIM from app.js (Phase 0.7-style extraction, move-only, no logic
// changes -- same discipline as the original Phase 0 extraction that
// already pulled calcRSI/calcATR/calcTrimmedATR/calcMA/calcAvgVolume into
// core/indicators.js, which this file calls as ordinary globals).
//
// Extracted 2026-09-05 specifically so EDGE can get a server-side signal
// logger matching Warrior's (engines/warrior/gate.js is a real ES module
// with zero DOM dependencies; scoreStock lived inline in app.js's
// classic-script scope until now, making it the one piece blocking an
// EDGE equivalent). Confirmed before moving, not assumed: scoreStock's
// only external dependencies beyond this file's own contents are
// calcRSI/calcATR/calcTrimmedATR/calcMA/calcAvgVolume (core/indicators.js)
// and getLivePrice (core/market-data.js), all already portable, plus two
// direct ambient-state reads (state.macroContext,
// state.settings.disableMacroOverlay) -- unchanged here, shimmable in a
// Node harness the same way core/api-client.js's alpacaHeaders() already
// is for Warrior's logger (see scripts/log-signals-warrior.mjs).
//
// Comparing a server-side EDGE score against Warrior's is only valid if
// scoreStock's real, live logic is what runs server-side -- not a
// reimplementation that could silently drift. This file is that logic,
// unmodified, not a copy.

const COMPANY_NAMES = {
  'SNDL':'SNDL Inc.','CLOV':'Clover Health','MVIS':'MicroVision','WKHS':'Workhorse Group',
  'GOEV':'Canoo Inc.','SPWR':'SunPower','PLUG':'Plug Power','FCEL':'FuelCell Energy',
  'BLNK':'Blink Charging','IDEX':'Ideanomics','ZOM':'Zomedica','CPRX':'Catalyst Pharma',
  'CRON':'Cronos Group','ACB':'Aurora Cannabis','TLRY':'Tilray Brands','COTY':'Coty Inc.',
  'F':'Ford Motor','SNAP':'Snap Inc.','SOFI':'SoFi Technologies','HOOD':'Robinhood Markets',
  'LCID':'Lucid Group','XPEV':'XPeng Inc.','NIO':'NIO Inc.','MARA':'Marathon Digital',
  'RIOT':'Riot Platforms','HUT':'Hut 8 Mining','BITF':'Bitfarms','CLSK':'CleanSpark',
  'CIFR':'Cipher Mining','KOSS':'Koss Corp','EXPR':'Express Inc.','AMC':'AMC Entertainment',
  'FFIE':'Faraday Future','MULN':'Mullen Automotive','XELA':'Exela Technologies',
  'KPLT':'Katapult Holdings','GFAI':'Guardforce AI','OCGN':'Ocugen Inc.',
  'INO':'Inovio Pharma','NVAX':'Novavax','SRNE':'Sorrento Therapeutics',
  'ATOS':'Atossa Therapeutics','CTIC':'CTI BioPharma','JAGX':'Jaguar Health',
  'LXRX':'Lexicon Pharma','OCUL':'Ocular Therapeutix','RILY':'B. Riley Financial',
  'SAVA':'Cassava Sciences','UAVS':'AgEagle Aerial','VNRX':'VolitionRx',
  'WTER':'Alkaline Water','YCBD':'cbdMD','NKLA':'Nikola Corp','RIDE':'Lordstown Motors',
  'HYLN':'Hyliion Holdings','ARBK':'Argo Blockchain','HIVE':'Hive Blockchain',
  'VERB':'Verb Technology','PHUN':'Phunware','CSSE':'Chicken Soup for the Soul',
  'PAYA':'Paya Holdings','PDSB':'PDS Biotech','ALBT':'Avalon GloboCare',
  'AEYE':'AudioEye','SEEL':'Seelos Biosciences','CPIX':'Cumberland Pharma',
  'NCPL':'Netcapital','HCWB':'HCW Biologics','CHRS':'Coherus BioSciences',
  'MTSL':'MiMedia Inc.','MVST':'Microvast','WATT':'Energous Corp','VVPR':'VivoPower',
  'SIGA':'SIGA Technologies','BLPH':'Bellerophon Therapeutics','OBSV':'ObsEva SA',
  'VBIV':'VBI Vaccines','CIDM':'Cinedigm','CYTH':'Cyclerion Therapeutics',
  'DFFN':'Diffusion Pharma','GNPX':'Genprobe','INFI':'Infinity Pharma',
  'KMPH':'KemPharm','MYOV':'Myovant Sciences','NBSE':'NeuBase Therapeutics',
  'PRPO':'Precipio Diagnostics','QLGN':'Qualigen Therapeutics','TPVG':'TriplePoint Venture',
  'XBIO':'Xenon Pharma','ZSAN':'Zosano Pharma','OGEN':'Oragenics',
  'APHA':'Aphria Inc.','SFIX':'Stitch Fix','WISH':'ContextLogic','RIVN':'Rivian Automotive',
  'BBBY':'Bed Bath & Beyond','GME':'GameStop','NEXT':'NextDecade','AULT':'Ault Global Holdings',
  'MDJM':'Mdjm Ltd','LIZI':'Lizhan Environmental'
};

const NEG_KEYWORDS = ['recall','lawsuit','fraud','investigation','bankruptcy','downgrade','loss report','criminal'];

const MACRO_ADJUSTMENTS = {
  RISK_OFF:                { HEALTHCARE: -20, ENERGY: -15, TECH: -20, RETAIL: -20, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER: -20 },
  GEOPOLITICAL:            { HEALTHCARE: -10, ENERGY:  10, TECH: -15, RETAIL: -15, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER: -10 },
  TECH_ROTATION_OUT:       { HEALTHCARE:  -5, ENERGY:  10, TECH: -20, RETAIL: -20, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:  -5 },
  BROAD_RALLY:             { HEALTHCARE:  10, ENERGY:   5, TECH:  10, RETAIL:  10, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:  10 },
  MOMENTUM_DAY:            { HEALTHCARE:   5, ENERGY:   0, TECH:  15, RETAIL:  15, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:   5 },
  SECTOR_WEAKNESS_BIOTECH: { HEALTHCARE: -15, ENERGY:   0, TECH:   0, RETAIL:   0, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:  -5 },
  SECTOR_WEAKNESS_ENERGY:  { HEALTHCARE:   0, ENERGY: -15, TECH:   0, RETAIL:   0, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:  -5 },
  SECTOR_WEAKNESS_TECH:    { HEALTHCARE:   0, ENERGY:   0, TECH: -15, RETAIL: -15, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:  -5 },
  CHOPPY:                  { HEALTHCARE:   0, ENERGY:   0, TECH:   0, RETAIL:   0, FINANCIAL: 0, INDUSTRIAL: 0, REAL_ESTATE: 0, CONSUMER: 0, OTHER:   0 },
};

function getMacroAdjustment(condition, category) {
  if (!condition || !category) return 0;
  return MACRO_ADJUSTMENTS[condition]?.[category] ?? 0;
}

function classifyDuration(rsi, volRatio, closes) {
  const rsi3ago = closes.length >= 17 ? calcRSI(closes.slice(0, -3)) : rsi;
  const rsiTrending = rsi > rsi3ago;

  if (rsi > 68 || volRatio > 3) return 'DAY';

  if (rsi >= 48 && rsi <= 60 && rsiTrending && volRatio >= 1.2 && volRatio <= 1.8)
    return 'WEEK';

  if (rsi >= 52 && rsi <= 68 && volRatio >= 1.5 && volRatio <= 3)
    return '3-DAY';

  if (rsi > 65) return 'DAY';
  if (rsi < 50) return 'WEEK';
  return '3-DAY';
}

function calcEntryTargetStop(price, atr, duration, resistance = {}) {
  const entry = price;
  const atrFloor = Math.max(atr, price * 0.02); // minimum 2% of price
  let tMult, sMult;
  switch (duration) {
    case 'DAY':   tMult = 1.0; sMult = 0.75; break;
    case '3-DAY': tMult = 2.0; sMult = 1.0;  break;
    case 'WEEK':  tMult = 3.5; sMult = 1.5;  break;
    default:      tMult = 1.5; sMult = 1.0;
  }
  const rawTarget = entry + atrFloor * tMult;

  // Cap raw target at nearest resistance ceiling above entry (52wk high, swing high, or 20-day MA)
  const { high52, swingHigh10, ma20 } = resistance;
  const levels = [];
  if (high52 != null)      levels.push({ price: high52 * 0.98,      label: '52-week high' });
  if (swingHigh10 != null) levels.push({ price: swingHigh10 * 0.99, label: 'recent swing high' });
  if (ma20 != null && price < ma20) levels.push({ price: ma20 * 0.99, label: '20-day MA' });

  const applicable = levels.filter(l => l.price > entry);
  let target = rawTarget, cappedBy = null;
  if (applicable.length) {
    const nearest = applicable.reduce((a, b) => (b.price < a.price ? b : a));
    if (rawTarget > nearest.price) { target = nearest.price; cappedBy = nearest.label; }
  }
  target = Math.max(target, entry * 1.02);

  return {
    entry,
    target,
    stop: Math.min(entry - atrFloor * sMult, entry * 0.95),
    cappedBy
  };
}

function calcRiskScore(price, atr, rsi, volRatio, hasNegNews) {
  let r = price < 4 ? 6 : price < 10 ? 4 : 3;
  const atrPct = price > 0 ? (atr / price) * 100 : 0;
  if (atrPct > 10) r += 2; else if (atrPct > 6) r += 1;
  if (rsi > 75 || rsi < 30) r += 2;
  if (hasNegNews) r += 2;
  return Math.min(10, Math.max(1, r));
}

function scoreStock(ticker, snap, bars, newsItem, spyChangePct = 0, category = null) {
  const price = getLivePrice(snap);
  const prevClose = snap.prevDailyBar?.c || price;
  const volume = snap.dailyBar?.v || 0;

  if (bars.length < 15) return null;

  const sorted = [...bars].sort((a,b) => new Date(a.t) - new Date(b.t));
  const closes = sorted.map(b => b.c);
  const vols   = sorted.map(b => b.v);

  const rsi = calcRSI(closes);
  const atr = calcATR(sorted); // simple/untrimmed — feeds Risk Score only
  const trimmedAtr = calcTrimmedATR(sorted); // feeds target/stop only
  const ma20 = calcMA(closes, 20);
  const avgVol10 = calcAvgVolume(vols, 10);
  const volRatio = avgVol10 > 0 ? volume / avgVol10 : 1;
  const todayChange = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

  const duration = classifyDuration(rsi, volRatio, closes);
  // Resistance levels for target capping (Change 6). Window is whatever bars are
  // available (~100-125 trading days from the screener fetch), not a true 252-day
  // 52-week window — treated as an approximation per product decision.
  const high52 = Math.max(...sorted.map(b => b.h));
  const low52 = Math.min(...sorted.map(b => b.l));
  const last10ExclToday = sorted.slice(-11, -1);
  const swingHigh10 = last10ExclToday.length ? Math.max(...last10ExclToday.map(b => b.h)) : null;
  const { entry, target, stop, cappedBy } = calcEntryTargetStop(price, trimmedAtr, duration, { high52, swingHigh10, ma20 });

  let score = 0;
  // Volume spike (−10 to +20) — Change 9 (Scoring Formula v2): flipped so 1-2x
  // (75% win rate, best zone) scores highest; 3x+ (50% win rate, -4.7% avg,
  // worst performer — late retail pile-in) is now penalized instead of rewarded.
  if (volRatio >= 3) score -= 10;
  else if (volRatio >= 2) score += 10;
  else if (volRatio >= 1) score += 20;
  else if (volRatio >= 0.5) score += 15;
  // else (<0.5x): 0 pts — too quiet for a reliable liquidity signal
  // Price momentum (0–20)
  if (todayChange >= 4) score += 20;
  else if (todayChange >= 2) score += 10;
  // RSI (−10 to +20) — Change 8 (Scoring Formula v2): buckets re-derived from
  // 28-trade analysis. RSI 65-75 no longer rewarded (0% win rate in data);
  // RSI 75+ now penalized. Does not affect the separate Mean Reversion signal below.
  if (rsi >= 55 && rsi <= 65) score += 20;
  else if (rsi >= 35 && rsi < 55) score += 15;
  else if (rsi < 35) score += 10;
  else if (rsi > 65 && rsi <= 75) score += 0;
  else if (rsi > 75) score -= 10;
  // Above 20-day MA
  if (price > ma20) score += 10;

  // News: compute hasNegNews for risk/display — no longer affects score
  let hasNegNews = false;
  if (newsItem) {
    const hl = (newsItem.headline || '').toLowerCase();
    hasNegNews = NEG_KEYWORDS.some(kw => hl.includes(kw));
  }
  // Bug 4 follow-up (behavior restoration, not a new rule): calcRiskScore's
  // negative-news penalty below was implicitly bounded before Bug 4, because
  // the old "since midnight" fetch window meant nothing more than a few
  // hours old could ever reach it. Widening the fetch to 72h silently
  // widened this penalty's reach too — a 3-day-old headline started adding
  // the same +2 as a 10-minute-old one. hasRecentNegNews restores the prior
  // effective ~24h reach. hasNegNews itself stays unbounded — it also drives
  // the sentiment badge (getNewsSentiment), which this doesn't touch.
  const newsAgeH = newsItem ? (Date.now() - new Date(newsItem.created_at).getTime()) / 3600000 : Infinity;
  const hasRecentNegNews = hasNegNews && newsAgeH <= 24;

  // Volume Build: 2 consecutive days of rising volume + today >= 1.3x avg (0–15)
  // Change 10 (Scoring Formula v2): loosened from 3 to 2 consecutive days —
  // near-miss data showed 2-day setups had a 100% win rate vs 67% for actual
  // 3-day fires, suggesting the old threshold caught the setup one day late.
  let consRisingVolDays = 0;
  for (let i = vols.length - 1; i > 0; i--) {
    if (vols[i] > vols[i-1]) consRisingVolDays++;
    else break;
  }
  let volBuild = false;
  if (vols.length >= 2 && volRatio >= 1.3) {
    const n = vols.length;
    if (vols[n-1] > vols[n-2]) {
      volBuild = true;
      score += 15;
    }
  }
  const volBuildNearMiss = !volBuild ? { consecutiveDays: consRisingVolDays, volRatio } : null;

  // CATALYST_SETUP detection (Change D: now scored +10, was Phase 1
  // informational-only at 0 pts; still does not affect signal beyond its
  // contribution to score, or target/stop/risk directly). All three must
  // hold: price near its 52-week low (same-window approximation as high52
  // above, per product decision — no extra fetch), RSI rising off oversold
  // but still <55, and volume building for 2+ consecutive days (reuses
  // consRisingVolDays from VOL_BUILD above, not rebuilt).
  const near52wLow = low52 > 0 && price <= low52 * 1.20;
  const rsi3ago = closes.length >= 18 ? calcRSI(closes.slice(0, -3)) : rsi;
  const risingFromOversold = rsi > rsi3ago && rsi < 55;
  const volBuilding2Days = consRisingVolDays >= 2;
  const catalystSetup = near52wLow && risingFromOversold && volBuilding2Days;
  if (catalystSetup) score += 10;

  // Mean Reversion: price 8–15% below 20MA, RSI < 45 and turning up (0–20)
  let meanReversion = false;
  const maPct = ma20 > 0 ? ((price - ma20) / ma20) * 100 : 0;
  if (maPct <= -8 && maPct >= -15 && rsi < 45 && closes.length >= 17) {
    const rsi2ago = calcRSI(closes.slice(0, -2));
    if (rsi > rsi2ago) {
      meanReversion = true;
      score += 20;
    }
  }
  const meanReversionNearMiss = !meanReversion ? { pctBelowMA: maPct, rsi } : null;

  // Consecutive up days (0–15 pts)
  let consUpDays = 0;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sorted[i].c > sorted[i-1].c) consUpDays++;
    else break;
  }
  let consUpPts = 0;
  if (consUpDays >= 4) consUpPts = 15;
  else if (consUpDays === 3) consUpPts = 10;
  else if (consUpDays === 2) consUpPts = 5;
  score += consUpPts;

  // Relative strength vs SPY (0–15 pts)
  const rsVsSPY = todayChange - spyChangePct;
  let relStrengthPts = 0;
  if (rsVsSPY >= 2) relStrengthPts = 15;
  else if (rsVsSPY >= 1) relStrengthPts = 10;
  else if (rsVsSPY > 0) relStrengthPts = 5;
  score += relStrengthPts;

  const signalsFired = [];
  if (volBuild) signalsFired.push('VOL_BUILD');
  if (meanReversion) signalsFired.push('MEAN_REVERSION');
  if (consUpDays >= 3) signalsFired.push('CONS_UP');

  const volTrend = volBuild ? 'building' : volRatio >= 1.5 ? 'spike' : 'normal';

  // Sub-$10 early entry timing (Change C) — RSI/volume-based adjustment layered
  // on top of the existing formula, tier-specific to sub-$10 stocks only (both
  // $1-$3 and $4-$9 ranges). Does not affect RAW_SCORE_MAX — see the comment
  // on that constant's definition for why these stack on top of it instead.
  let sub10Pts = 0;
  if (price < 10) {
    if (rsi < 45) sub10Pts += 10;
    else if (rsi >= 45 && rsi <= 55) sub10Pts += 5;
    else if (rsi > 60) sub10Pts -= 10;

    if (volRatio < 1.5) sub10Pts += 5;
    else if (volRatio > 2.5) sub10Pts -= 10;

    score += sub10Pts;
  }

  // Macro Market Overlay (Step 3): category-specific adjustment applied on top
  // of the raw accumulated score above, which is otherwise untouched. Floored
  // at 0 per spec (no upper cap — raw score can run up to RAW_SCORE_MAX plus
  // whatever macroAdjustment adds). macroCondition is null (adjustment 0) if macroContext hasn't
  // loaded yet or the fetch failed — never blocks scoring.
  // "Disable macro overlay" (state.settings.disableMacroOverlay) forces the
  // adjustment itself to 0 rather than skipping detection — macroCondition/
  // macroChanges below stay populated as normal (fetchMacroContext still runs
  // and the condition is still classified every session), only its effect on
  // score is suppressed. Forcing macroAdjustment to 0 here (not just skipping
  // the += below) also keeps it accurate for anything downstream that reads
  // s.macroAdjustment for display (e.g. the score breakdown row) — it
  // correctly shows no macro effect rather than a would-be value that was
  // never actually applied.
  const macroCondition = state.macroContext?.condition || null;
  const macroAdjustment = state.settings.disableMacroOverlay ? 0 : getMacroAdjustment(macroCondition, category);
  const macroChanges = state.macroContext?.changes || null;
  score = Math.max(0, score + macroAdjustment);

  const risk = calcRiskScore(price, atr, rsi, volRatio, hasRecentNegNews);
  const priceRange = price <= 3 ? '$1–$3' : price <= 9 ? '$4–$9' : '$10–$20';
  const signal = score >= 116 ? 'STRONG BUY' : score >= 73 ? 'SOFT BUY' : 'WATCH';

  return {
    ticker, company: COMPANY_NAMES[ticker] || ticker,
    price, prevClose, todayChange, volume, volRatio,
    rsi, atr, trimmedAtr, ma20, duration, entry, target, stop, cappedBy,
    score, risk, signal, priceRange, news: newsItem, hasNegNews,
    volBuild, meanReversion, maPct, volTrend, signalsFired,
    volBuildNearMiss, meanReversionNearMiss,
    consUpDays, consUpPts, spyChange: spyChangePct, rsVsSPY, relStrengthPts,
    macroCondition, macroAdjustment, macroChanges, category,
    catalystSetup, sub10Pts,
    bars: sorted
  };
}
