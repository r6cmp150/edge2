// core/store.js — owned by neither engine. core/ never imports from engines/.
// localStorage / Supabase persistence (Supabase client, portfolio + settings CRUD).
// Moved from app.js verbatim (Phase 0 extraction). Left in app.js: writeTradeToSupabase,
// mapTradesV2ToSoldShape, and other Sold/report-specific persistence — those are
// tightly coupled to EDGE's trade-recording shape, not generic position/settings storage.

// Client is named supabaseClient (not `supabase`) — the CDN bundle's UMD
// wrapper puts the library itself on window.supabase, and declaring a
// top-level `const supabase` in a classic (non-module) script collides
// with that global and throws "Identifier 'supabase' has already been
// declared" in some load orders.
const SUPABASE_URL = 'https://kbjqxaukyawcmcyjoiey.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JXOwCMF_a5ylZL8V5mwfzw_MRivRMpl';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function persistApiKeys() {
  try {
    localStorage.setItem('edge_apiKeys', JSON.stringify({
      alpacaKey: state.settings.alpacaKey,
      alpacaSecret: state.settings.alpacaSecret,
      groqKey: state.settings.groqKey,
    }));
  } catch(e) {}
}

// developerTools (Phase 4) and riskPerTradePct (Phase 5) don't have
// columns in the Supabase settings table — adding them needs a schema
// migration this session doesn't have the access to run. Until then,
// saveSettingsToSupabase()'s row simply omits them, meaning a write
// silently no-ops for these two fields specifically: found live
// 2026-08-28 when riskPerTradePct's persistence was being built and
// developerTools (already shipped, Phase 4) turned out to have the exact
// same gap — the toggle "saved" but reset to its default on every reload.
// Persisted locally instead, same alongside-Supabase-not-instead-of-it
// shape as persistApiKeys above (API keys are deliberately never sent to
// Supabase at all; these two are meant for Supabase eventually, just
// don't have anywhere there to live yet). Every OTHER setting stays
// exclusively Supabase-backed per the Data Migration project's Step 4 —
// this is a narrow, explicit exception for the two fields with nowhere
// else to go, not a reversion of that decision.
function persistLocalOnlySettings() {
  try {
    localStorage.setItem('edge_localOnlySettings', JSON.stringify({
      developerTools: state.settings.developerTools,
      riskPerTradePct: state.settings.riskPerTradePct,
      floatThresholdShares: state.settings.floatThresholdShares, // Phase 6 (2026-09-04) — same no-Supabase-column gap as the two above, not a reversion of the Data Migration decision
    }));
  } catch(e) {}
}

function loadLocalOnlySettings() {
  try {
    const raw = localStorage.getItem('edge_localOnlySettings');
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch(e) {}
}

// Quota-failure surfacing (2026-09-04, found live while adding
// state.warriorPreMarketRvolObservations — an array persisted on every
// PRE-session scan with no retention bound until this same pass capped
// it): this function backs EVERY persisted state field in the app
// (signals, sold, portfolio-adjacent caches, this new one), and used to
// swallow ANY write failure silently, quota exhaustion included. A quota
// failure doesn't just drop the one field that pushed it over — every
// LATER persist() call for ANY key keeps failing the same way, silently,
// for the rest of the session. "A save that silently stops working" is
// this project's own recurring bug shape (the request-counter undercount,
// the truthfulness-of-requests-issued fixes earlier this project);
// applying the same principle here rather than adding a second, narrower
// try/catch around just the new field.
//
// state.persistFailure is checked by updateMarketBanner (app.js) and
// rendered as a real, alarming banner state — not muted like the other
// disclosures this session added elsewhere (Phase 5 unvalidated, RVOL
// caveats), because THIS one means state stops saving at all, which is a
// materially worse failure than "one metric wasn't measured this scan."
// Cleared automatically the next time ANY persist() call succeeds, so a
// transient/resolved quota issue doesn't leave a stale alarm on screen.
//
// Known, not fixed here: persistApiKeys/persistLocalOnlySettings (above)
// have the identical silent-swallow shape — out of scope for this pass
// (this fix was scoped to the field that motivated it), flagged so a
// future pass doesn't have to rediscover it.
function persist(key) {
  try {
    localStorage.setItem('edge_' + key, JSON.stringify(state[key]));
    if (state.persistFailure) { state.persistFailure = null; updateMarketBanner(); }
  } catch(e) {
    console.error(`persist('${key}') failed — localStorage write threw: ${e.message}. State for '${key}' (and every other key, until this clears) may not survive a reload.`);
    state.persistFailure = { key, message: e.message, at: new Date().toISOString() };
    updateMarketBanner();
  }
}

// Unlike writeTradeToSupabase()/writeRatingSnapshots() in app.js, which
// swallow errors internally (console.error + return, since a failed
// historical-data write shouldn't block the UI action that triggered it),
// the functions below THROW on error instead. That's deliberate: the
// migration button and app-init read path both need to catch a real failure
// and show it explicitly rather than silently continuing — swallowing the
// error here would defeat the point.

// position.id (client Date.now().toString()) <-> portfolio.position_id.
// buy_date/peak_price_date come back from Postgres as full timestamptz
// strings; sliced to plain yyyy-mm-dd since that's the format the rest of
// the app assumes (e.g. the p.buyDate.split('-') display code).
function mapSupabasePortfolioRowToPosition(row) {
  return {
    id: row.position_id,
    ticker: row.ticker,
    company: row.company,
    shares: row.shares,
    buyPrice: row.buy_price,
    buyDate: row.buy_date ? row.buy_date.split('T')[0] : row.buy_date,
    target: row.target,
    stop: row.stop,
    duration: row.duration,
    scoreAtBuy: row.score_at_buy,
    rsiAtBuy: row.rsi_at_buy,
    volRatioAtBuy: row.vol_ratio_at_buy,
    riskAtBuy: row.risk_at_buy,
    newsAtBuy: row.news_at_buy,
    signalsFiredAtBuy: row.signals_fired_at_buy || [],
    volBuildNearMiss: row.vol_build_near_miss,
    meanReversionNearMiss: row.mean_reversion_near_miss,
    cappedByAtBuy: row.capped_by_at_buy,
    rawAtrAtBuy: row.raw_atr_at_buy,
    trimmedAtrAtBuy: row.trimmed_atr_at_buy,
    macroConditionAtBuy: row.macro_condition_at_buy,
    thresholdAtBuy: row.threshold_at_buy,
    catalystSetup: !!row.catalyst_setup,
    peakPrice: row.peak_price,
    peakPriceDate: row.peak_price_date ? row.peak_price_date.split('T')[0] : row.peak_price_date,
    momentumProtectionActivated: !!row.momentum_protection_activated,
    rsiSuspendedAtGainPct: row.rsi_suspended_at_gain_pct,
    buyTime: row.buy_time,
    buyDayOfWeek: row.buy_day_of_week,
    buySession: row.buy_session,
    subTenEntryAdjustment: row.sub_ten_entry_adjustment,
    groqProbabilityAtBuy: row.groq_probability_at_buy,
    priceMomentumPts: row.price_momentum_pts,
    volSpikePts: row.vol_spike_pts,
    rsiPts: row.rsi_pts,
    maPts: row.ma_pts,
    volBuildPts: row.vol_build_pts,
    meanReversionPts: row.mean_reversion_pts,
    consUpDays: row.cons_up_days,
    consUpPts: row.cons_up_pts,
    relStrengthPts: row.rel_strength_pts,
    macroAdjustmentPts: row.macro_adjustment_pts,
    maPctAtBuy: row.ma_pct_at_buy,
    rawScoreAtBuy: row.raw_score_at_buy,
  };
}

function mapPositionToSupabaseRow(position) {
  return {
    position_id: position.id,
    ticker: position.ticker,
    company: position.company,
    shares: position.shares,
    buy_price: position.buyPrice,
    buy_date: position.buyDate,
    target: position.target,
    stop: position.stop,
    duration: position.duration,
    score_at_buy: position.scoreAtBuy,
    rsi_at_buy: position.rsiAtBuy,
    vol_ratio_at_buy: position.volRatioAtBuy,
    risk_at_buy: position.riskAtBuy,
    news_at_buy: position.newsAtBuy,
    signals_fired_at_buy: position.signalsFiredAtBuy || [],
    vol_build_near_miss: position.volBuildNearMiss,
    mean_reversion_near_miss: position.meanReversionNearMiss,
    capped_by_at_buy: position.cappedByAtBuy,
    raw_atr_at_buy: position.rawAtrAtBuy,
    trimmed_atr_at_buy: position.trimmedAtrAtBuy,
    macro_condition_at_buy: position.macroConditionAtBuy,
    threshold_at_buy: position.thresholdAtBuy,
    catalyst_setup: !!position.catalystSetup,
    peak_price: position.peakPrice,
    peak_price_date: position.peakPriceDate,
    momentum_protection_activated: !!position.momentumProtectionActivated,
    rsi_suspended_at_gain_pct: position.rsiSuspendedAtGainPct,
    buy_time: position.buyTime,
    buy_day_of_week: position.buyDayOfWeek,
    buy_session: position.buySession,
    sub_ten_entry_adjustment: position.subTenEntryAdjustment,
    groq_probability_at_buy: position.groqProbabilityAtBuy,
    price_momentum_pts: position.priceMomentumPts,
    vol_spike_pts: position.volSpikePts,
    rsi_pts: position.rsiPts,
    ma_pts: position.maPts,
    vol_build_pts: position.volBuildPts,
    mean_reversion_pts: position.meanReversionPts,
    cons_up_days: position.consUpDays,
    cons_up_pts: position.consUpPts,
    rel_strength_pts: position.relStrengthPts,
    macro_adjustment_pts: position.macroAdjustmentPts,
    ma_pct_at_buy: position.maPctAtBuy,
    raw_score_at_buy: position.rawScoreAtBuy,
    updated_at: new Date().toISOString(),
  };
}

async function loadPortfolioFromSupabase() {
  const { data, error } = await supabaseClient.from('portfolio').select('*').order('buy_date', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapSupabasePortfolioRowToPosition);
}

async function savePortfolioToSupabase(portfolio) {
  if (!portfolio.length) return;
  const rows = portfolio.map(mapPositionToSupabaseRow);
  const { error } = await supabaseClient.from('portfolio').upsert(rows, { onConflict: 'position_id' });
  if (error) throw error;
}

async function savePositionToSupabase(position) {
  const row = mapPositionToSupabaseRow(position);
  const { error } = await supabaseClient.from('portfolio').upsert([row], { onConflict: 'position_id' });
  if (error) throw error;
}

async function deletePositionFromSupabase(positionId) {
  const { error } = await supabaseClient.from('portfolio').delete().eq('position_id', positionId);
  if (error) throw error;
}

// settings has no natural unique key (single-row table, no auth/RLS scoping
// per the migration's explicit scope) — read-then-write against whatever row
// currently has the highest id, insert a fresh row only if none exists yet.
// API keys/PIN are intentionally absent from both directions; the caller is
// responsible for merging those back in from localStorage.
async function loadSettingsFromSupabase() {
  const { data, error } = await supabaseClient
    .from('settings').select('*').order('id', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    budget: data.budget,
    includeUnder2: !!data.include_under2,
    showWatch: !!data.show_watch,
    minVolume: data.min_volume,
    forcePreMarketMode: !!data.force_pre_market_mode,
    disableMacroOverlay: !!data.disable_macro_overlay,
  };
}

async function saveSettingsToSupabase(settings) {
  const row = {
    budget: settings.budget,
    include_under2: !!settings.includeUnder2,
    show_watch: !!settings.showWatch,
    min_volume: settings.minVolume,
    force_pre_market_mode: !!settings.forcePreMarketMode,
    disable_macro_overlay: !!settings.disableMacroOverlay,
    updated_at: new Date().toISOString(),
  };
  const { data: existing, error: selectError } = await supabaseClient
    .from('settings').select('id').order('id', { ascending: false }).limit(1).maybeSingle();
  if (selectError) throw selectError;
  if (existing) {
    const { error } = await supabaseClient.from('settings').update(row).eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabaseClient.from('settings').insert([row]);
    if (error) throw error;
  }
}
