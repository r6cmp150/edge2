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
//
// db/038 (2026-11-02): all four now have Supabase columns, and Supabase is
// where they're saved. This phone's old copy is only READ, once per load,
// for a value Supabase doesn't have yet (column NULL): that setting's source
// is then 'phone', the banner says so, and the next successful settings
// save uploads it. Nothing writes the phone copy any more. Both the read and
// the parse used to swallow every error (catch(e) {}); a failure is now a
// settings problem on the banner, not a silent reset to defaults.
const PHONE_ONLY_SETTINGS_KEY = 'edge_localOnlySettings';
const PHONE_ONLY_SETTING_KEYS = ['riskPerTradePct', 'floatThresholdShares', 'maxLossPct', 'developerTools'];

function noteSettingsProblem(message) {
  (state.settingsProblems = state.settingsProblems || []).push(message);
}

function loadLocalOnlySettings() {
  let raw;
  try { raw = localStorage.getItem(PHONE_ONLY_SETTINGS_KEY); }
  catch (e) { noteSettingsProblem(`couldn't read the settings stored on this phone (${e?.message || e})`); return; }
  if (!raw) return;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { noteSettingsProblem(`the settings stored on this phone are unreadable (${e?.message || e})`); return; }
  for (const k of PHONE_ONLY_SETTING_KEYS) {
    if (parsed && parsed[k] != null) { state.settings[k] = parsed[k]; state.settingsSource[k] = 'phone'; }
  }
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
// state.persistFailures is checked by updateMarketBanner (app.js) and
// rendered as a real, alarming banner state — not muted like the other
// disclosures this session added elsewhere (Phase 5 unvalidated, RVOL
// caveats), because THIS one means state stops saving at all, which is a
// materially worse failure than "one metric wasn't measured this scan."
// (Once cleared by ANY successful persist(); since 2026-11-08 only by the same key; since 2026-11-13 one entry per
// key, removed only by that key saving. See "Failure record" below.)
//
// Known, not fixed here: persistApiKeys/persistLocalOnlySettings (above)
// have the identical silent-swallow shape — out of scope for this pass
// (this fix was scoped to the field that motivated it), flagged so a
// future pass doesn't have to rediscover it.
//
// TIERS (2026-11-08, change 4a). The quota is shared, and a rebuildable cache was
// winning it: the `sold` cache alone was 1,734,554 characters (608 sales, measured
// 2026-11-08 at the app's own shape from live trades_v2), while the only
// copy of an unrecorded sale queued behind it. Standing rule: the only copy of an
// unrecorded write never shares a budget with anything rebuildable, and it goes first.
//   1  queues: the only copy of a write that hasn't reached the database
//   2  measured state: the only copy of something measured on this phone
//   3  preferences and small session state
//   4  caches: copies of what the database or a re-scan already holds
// A tier 1-3 write that hits the quota evicts tier-4 caches from storage, largest
// first, retrying after each; a cache write never evicts anything. Evicted caches stay
// in memory and are rebuilt by their next load. Every key persist() writes has a tier
// (tests/persist-tiers.test.js fails on one that doesn't).
//
// Failure record, CHANGED 2026-11-08: a success clears the failure only for the SAME
// key (it used to be any key, so a cache saving fine erased a queue that hadn't), and a
// lower-tier failure never overwrites a higher-tier one.
// CHANGED 2026-11-13: state.persistFailures, ONE ENTRY PER KEY. The record was a single slot: a same-tier failure
// replaced the one there, and that key's later save cleared it, so queue A's failure could vanish while A stayed
// unsaved (measured with a scratch run of this persist()). Now nothing is displaced: a failure records its own key,
// and only that key saving removes it. The banner lists every outstanding failure, most important tier first.
const PERSIST_TIER = {
  saleWriteFailures: 1, snapshotWriteFailures: 1, ratingWriteFailures: 1,
  ownedPeakRSI: 2, ownedPrevRSI: 2, warriorPreMarketRvolObservations: 2,
  signalToggles: 3, selectedUniverse: 3, notifications: 3, lastScanTime: 3, lastPassedCount: 3, lastScanDroppedCount: 3,
  // (c), carved 2026-11-12: the day's last Groq macro answer, which keeps Groq to one ask per trading day. Losing it costs
  // one extra Groq ask: small session state.
  macroGroqLast: 3,
  sold: 4, analysisPeriods: 4, signals: 4, news: 4, ownedScores: 4, universeAssetCache: 4, universePriorCloseCache: 4,
  warrior30DayVolumeCache: 4, warriorPreMarketVolumeCache: 4, warriorFloatCache: 4, warriorEdgarCikMapCache: 4,
};
const persistTier = key => PERSIST_TIER[key] ?? 3;

// The `sold` cache is stored BOUNDED: the most recent sales (state.sold is newest
// first) up to SOLD_CACHE_MAX_CHARS of JSON, with the total and the copy's OWN time.
// The Sold and Analytics tabs label it "most recent N of M, saved <storedAt>" until
// the database read replaces it. storedAt is when this copy was written, never the
// render time: a write that fails leaves the previous copy, and its date says so.
// Measured 2026-11-08 on live trades_v2 at the app's shape: a sale averages 2,853 chars,
// and this cap keeps the most recent 87 of 608 (sold 11-04 to 11-06), 298,708 chars, down
// from 1,734,554 for the whole list.
const SOLD_CACHE_MAX_CHARS = 300000;
function boundSoldCache(sold, info) {
  const all = Array.isArray(sold) ? sold : [];
  const rows = [];
  let size = 0;
  for (const r of all) {
    const n = JSON.stringify(r).length + 1;
    if (size + n > SOLD_CACHE_MAX_CHARS) break;
    rows.push(r);
    size += n;
  }
  // Offline on a bounded copy, state.sold is that copy plus any sales added since, so
  // the total is the copy's total plus what was added: a computed number, not a guess.
  const total = info && !info.legacy ? info.total + Math.max(0, all.length - info.kept) : all.length;
  return { format: 'bounded-v1', storedAt: new Date().toISOString(), total, rows };
}
function storedForm(key) {
  return key === 'sold' ? boundSoldCache(state.sold, state.soldCacheInfo) : state[key];
}
function largestStoredCache(exceptKey) {
  let best = null;
  for (const k of Object.keys(PERSIST_TIER)) {
    if (PERSIST_TIER[k] !== 4 || k === exceptKey) continue;
    const v = localStorage.getItem('edge_' + k);
    if (v && (!best || v.length > best.size)) best = { key: k, size: v.length };
  }
  return best;
}

function persist(key) {
  const tier = persistTier(key);
  const value = JSON.stringify(storedForm(key));
  const evicted = [];
  for (;;) {
    try {
      localStorage.setItem('edge_' + key, value);
      if (evicted.length) {
        console.warn(`persist('${key}', tier ${tier}): evicted cache(s) ${evicted.map(e => `${e.key} (${e.size} chars)`).join(', ')} to make room.`);
        (state.persistEvictions = state.persistEvictions || []).push({ for: key, evicted, at: new Date().toISOString() });
      }
      // Only this key saving removes this key's entry (the per-entry form of 11-08's same-key rule).
      if (state.persistFailures && state.persistFailures[key]) { delete state.persistFailures[key]; updateMarketBanner(); }
      return true;
    } catch (e) {
      // persist() never throws to its caller: a storage that can't even be read for a
      // victim just means nothing can be evicted.
      let victim = null;
      if (tier < 4) { try { victim = largestStoredCache(key); } catch (_) { victim = null; } }
      if (victim) {
        try { localStorage.removeItem('edge_' + victim.key); } catch (_) { /* nothing more to free */ }
        evicted.push(victim);
        continue;
      }
      console.error(`persist('${key}', tier ${tier}) failed — localStorage write threw: ${e.message}${evicted.length ? ` after evicting ${evicted.map(v => v.key).join(', ')}` : ''}. State for '${key}' may not survive a reload.`);
      // One entry per key, never displaced (2026-11-13): a single slot let a second failure replace the first, and
      // that key's later save clear it, so a queued sale could be left unsaved with nothing naming it.
      if (!state.persistFailures || typeof state.persistFailures !== 'object') state.persistFailures = {};
      state.persistFailures[key] = { key, tier, message: e.message, at: new Date().toISOString(), evicted };
      updateMarketBanner();
      return false;
    }
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
    macroPathAtBuy: row.macro_path_at_buy ?? null, // db/038
    barsAsOfAtBuy: row.bars_as_of_at_buy ?? null, // db/031: read back, so the update path resends it
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
    engineSource: row.engine_source,
    signalSnapshot: row.signal_snapshot,
    exitRuleId: row.exit_rule_id,
    minutesLate: row.minutes_late,
    // Phase 9 §4.2 (db/024, confirmed applied 2026-09-16) -- entry
    // measurement, none of it scores anything. Direct reads, no `||` --
    // 0 is real and meaningful for spread_at_buy/minutes_from_open.
    spreadAtBuy: row.spread_at_buy,
    minutesFromOpen: row.minutes_from_open,
    barsSinceSignal: row.bars_since_signal,
    entryVsSignalPricePct: row.entry_vs_signal_price_pct,
    // db/027 (order vs fill). Direct reads: NULL is meaningful in both --
    // orderType NULL = legacy (treated as a holding), filledAt NULL with an
    // orderType = PENDING ORDER (core/orders.js isPendingOrder).
    orderType: row.order_type,
    filledAt: row.filled_at,
    // db/028: read back so a sale can copy the BUY's version to trades_v2.
    // Deliberately NOT written back by mapPositionToSupabaseRow below.
    codeVersion: row.code_version ?? null,
    // db/042: read back so a sale can copy the position's mode (db/043's copied_from_position). Written once, at
    // the insert (insertPositionToSupabase), and like code_version never by the update path: an edit of a position
    // can't change whether it was placed at the broker.
    executionMode: row.execution_mode ?? null,
    executionModeSource: row.execution_mode_source ?? null,
  };
}

// db/038 (revision e): the macro path vocabulary. ONE list for every writer (portfolio.macro_path_at_buy,
// trades_v2.macro_path, rating_snapshots.macro_path, macro_observations.path), and the list
// tests/enumerated-values.test.js reads the written values from (carve of (c), 2026-11-12, ruled: enumerable code over
// declarations). 'unclassified' is a reading that ran and decided nothing; 'unknown' is NOT in it: it means no reading
// was attached at all, only macroPathColumn() writes it, and macro_observations can never hold it (its CHECK has none).
const MACRO_PATHS = ['pattern', 'groq', 'pattern_groq_failed', 'unclassified', 'not_fetched'];
function checkedMacroPath(path) {
  if (!MACRO_PATHS.includes(path)) throw new Error(`not a macro path: ${JSON.stringify(path)} (db/038's MACRO_PATHS)`);
  return path;
}
// A column that may say "no reading attached": a missing path is 'unknown', anything else must be on the list. An
// unexpected value throws here, before the write, rather than at the database's CHECK.
function macroPathColumn(path) {
  if (path == null) return 'unknown';
  return checkedMacroPath(path);
}
// rating_snapshots.tier: only scored rows are written (NOT_EVALUATED has no score), so these two.
const RATING_TIERS = ['SHOWN', 'BELOW_THRESHOLD'];
function checkedRatingTier(tier) {
  if (!RATING_TIERS.includes(tier)) throw new Error(`not a rating tier: ${JSON.stringify(tier)} (RATING_TIERS)`);
  return tier;
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
    macro_path_at_buy: macroPathColumn(position.macroPathAtBuy), // db/038 revision e: NOT NULL DEFAULT 'unknown'; a position from before has none
    bars_as_of_at_buy: position.barsAsOfAtBuy ?? null, // db/031
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
    engine_source: position.engineSource || null,
    signal_snapshot: position.signalSnapshot ?? null,
    exit_rule_id: position.exitRuleId ?? null,
    minutes_late: position.minutesLate ?? null,
    // Phase 9 §4.2 (db/024, confirmed applied 2026-09-16). `??`, not
    // `||` -- 0 is a real, meaningful value for spread_at_buy (bid==ask)
    // and minutes_from_open (a fill at exactly the open); `||` would
    // silently discard both.
    spread_at_buy: position.spreadAtBuy ?? null,
    minutes_from_open: position.minutesFromOpen ?? null,
    bars_since_signal: position.barsSinceSignal ?? null,
    entry_vs_signal_price_pct: position.entryVsSignalPricePct ?? null,
    order_type: position.orderType ?? null, // db/027 -- `??`: NULL means legacy / not filled, never coerced
    filled_at: position.filledAt ?? null,
    updated_at: new Date().toISOString(),
  };
}

// Every row a query matches (2026-11-04). PostgREST answers any read with at most
// 1,000 rows and no error, so an unpaged read of a bigger table quietly returns
// part of it. `query` builds the select with { count: 'exact' } and an order ending
// on a unique key, and selects that key: without a total order, pages can skip or
// repeat rows. Completeness comes from the count, after dropping any row a write
// during the read repeated. Same { data, error } shape as the read it replaces, and
// never partial rows.
const READ_PAGE_SIZE = 1000;
async function readAllRows(query) {
  const rows = [];
  for (;;) {
    const { data, error, count } = await query().range(rows.length, rows.length + READ_PAGE_SIZE - 1);
    if (error) return { data: null, error };
    if (count == null) return { data: null, error: new Error('no row count back, so completeness is unknown') };
    rows.push(...(data || []));
    if (rows.length >= count || !data || !data.length) {
      const unique = [...new Map(rows.map(r => [r.id, r])).values()];
      if (unique.length !== count) return { data: null, error: new Error(`read ${unique.length} rows of ${count}`) };
      return { data: unique, error: null };
    }
  }
}

async function loadPortfolioFromSupabase() {
  const { data, error } = await supabaseClient.from('portfolio').select('*').order('buy_date', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapSupabasePortfolioRowToPosition);
}

// Only the add forms create portfolio rows. Every other save is an update of
// a row that must already exist (2026-10-21, phase-10 spec §7.5): this was an
// upsert, and a background save from a session still holding a position sold
// in another session re-created it -- the 10/01 batch's phantom rows 530-536,
// nine positions recorded as two sales each. savePortfolioToSupabase (a bulk
// upsert with no callers) deleted in the same change.
//
// code_version (db/028) is written HERE and nowhere else in the portfolio
// path. It is not in mapPositionToSupabaseRow: that mapper also feeds the
// update-only savePositionToSupabase, and db/028's write-once trigger
// rejects any update that changes the column, NULL included. With the
// mapper's `x ?? null` convention, a code_version line there would null
// the column on every peak-price save and fail every one (phase-10 §7.7
// trip-wire). The position object keeps it, so the sale can copy it.
// db/033: the signal a position was bought on, one row per position, never
// updated (anon has INSERT and SELECT only). Throws like its siblings here;
// the caller (app.js recordSignalSnapshotAtBuy) is what makes it never
// block or fail the add.
// rating_snapshots for a list of tickers (the scan price history, 2026-11-12): the ONE in-list in app code, and the
// reason it is allowed (tests/no-unchunked-in-list.test.js names this function): it CHUNKS the list (a long in-list
// overflowed the URL at 371 ids, 2026-11-01), PAGES each chunk through readAllRows, and readAllRows CHECKS the rows
// read against the exact count. All three, or it is not the thing allowed. { data, error }, never partial rows.
const TICKER_IN_CHUNK = 100;
async function selectRatingSnapshotsByTickers(tickers) {
  const list = [...new Set(tickers || [])].sort();
  const out = [];
  for (let i = 0; i < list.length; i += TICKER_IN_CHUNK) {
    const chunk = list.slice(i, i + TICKER_IN_CHUNK);
    const { data, error } = await readAllRows(() => supabaseClient.from('rating_snapshots')
      .select('id, ticker, captured_at, price', { count: 'exact' })
      .in('ticker', chunk).order('captured_at', { ascending: false }).order('id', { ascending: true }));
    if (error) return { data: null, error };
    out.push(...data);
  }
  return { data: out, error: null };
}

async function insertSignalSnapshotAtBuy(row) {
  const { error } = await supabaseClient.from('signal_snapshot_at_buy').insert([row]);
  if (error) throw error;
}

// db/042: the mode a buy was recorded under, as the two columns. Only live or paper, chosen at this trade (the
// toggle re-read at confirm, or the prompt's tap): this build never records a buy as not_known, so a not_known
// buy from this build is a defect (the not_known count, STATUS.md). No mode is refused, not defaulted.
function recordedModeColumns(mode) {
  if (mode === 'live') return { execution_mode: 'live', execution_mode_source: 'recorded_at_trade' };
  if (mode === 'paper') return { execution_mode: 'paper', execution_mode_source: 'recorded_at_trade' };
  throw new Error(`no execution mode chosen for this trade (${mode}); nothing was recorded`);
}

async function insertPositionToSupabase(position) {
  if (!position.codeVersion) position.codeVersion = currentCodeVersion();
  const row = { ...mapPositionToSupabaseRow(position), code_version: position.codeVersion, ...recordedModeColumns(position.executionMode) };
  const { error } = await supabaseClient.from('portfolio').insert([row]);
  if (error) throw error;
}

// db/028 code_version for a row this browser is recording NOW. app is the
// ?v= stamp of the <script src="app.js?v=..."> this page actually loaded, so
// a tab left open across a deploy reports the old stamp it's really running.
// It's never a hand-maintained constant (build_version was, and said v2.18.0
// for a month). 'unavailable' is an explicit, honest value if the tag can't
// be read; recording must never fail because of a version lookup. scoring /
// scoring_hash are core/edge-scoring.js's test-pinned identity.
function currentCodeVersion() {
  let app = 'unavailable';
  try {
    const el = document.querySelector('script[src*="app.js?v="]');
    const m = el && el.getAttribute('src').match(/[?&]v=([^&#]+)/);
    if (m) app = m[1];
  } catch (_) { /* no DOM: leave 'unavailable' */ }
  return { app, scoring: SCORING_VERSION, scoring_hash: SCORING_HASH };
}

// An update that matches zero rows has more than one cause, and only one of
// them means the position is gone, so a follow-up select tells them apart
// (failure path only). Callers may act on POSITION_MISSING; the other two
// mean "not saved, position still real" and must never hide it. Distinguished
// even though portfolio has no RLS today (db/NOTE_portfolio_rls_not_applied.sql)
// -- a later policy would make UNWRITABLE reachable without touching this code.
//   POSITION_MISSING    -- select confirms no row: closed in another session
//   POSITION_UNWRITABLE -- the row exists; the update was refused
//   POSITION_UNKNOWN    -- the select itself failed; can't tell which
async function savePositionToSupabase(position) {
  const row = mapPositionToSupabaseRow(position);
  const { data, error } = await supabaseClient.from('portfolio')
    .update(row).eq('position_id', position.id).select('position_id');
  if (error) throw error;
  if (data && data.length > 0) return;
  const fail = (code, message) => { const e = new Error(message); e.code = code; e.positionId = position.id; e.ticker = position.ticker; return e; };
  const check = await supabaseClient.from('portfolio')
    .select('position_id').eq('position_id', position.id).limit(1);
  if (check.error) throw fail('POSITION_UNKNOWN', `${position.ticker}: update matched no row and the existence check failed (${check.error.message}) -- not saved, not re-created`);
  if (!check.data || check.data.length === 0) throw fail('POSITION_MISSING', `${position.ticker}: position ${position.id} is no longer in Supabase (closed in another session) -- not re-created`);
  throw fail('POSITION_UNWRITABLE', `${position.ticker}: position ${position.id} exists but the update changed no row -- not saved`);
}

// A delete is confirmed by the rows it returns, never by the absence of an
// error (2026-11-08): with RLS off on portfolio, a delete that matches no row
// is a silent success. Zero rows is followed up, as savePositionToSupabase does:
//   'REMOVED'               -- the delete returned the row
//   'ALREADY_GONE'          -- nothing deleted, and a select confirms no row:
//                              closed in another session (resolves, not throws;
//                              the caller decides what that means for it)
//   throws POSITION_NOT_REMOVED -- nothing deleted and the row is still there
//   throws POSITION_UNKNOWN     -- nothing deleted and the check failed
async function deletePositionFromSupabase(positionId) {
  const { data, error } = await supabaseClient.from('portfolio').delete().eq('position_id', positionId).select('position_id');
  if (error) throw error;
  if (data && data.length > 0) return 'REMOVED';
  const fail = (code, message) => { const e = new Error(message); e.code = code; e.positionId = positionId; return e; };
  const check = await supabaseClient.from('portfolio').select('position_id').eq('position_id', positionId).limit(1);
  if (check.error) throw fail('POSITION_UNKNOWN', `position ${positionId}: the delete removed no row and the existence check failed (${check.error.message}) -- can't tell whether it is still open`);
  if (check.data && check.data.length > 0) throw fail('POSITION_NOT_REMOVED', `position ${positionId}: the delete removed no row and the row is still there`);
  return 'ALREADY_GONE';
}

// settings is a single-row table (Roman's row, id 3, since 2026-08-17). The
// load remembers which row it read; a save updates exactly that row and must
// get it back.
//
// THE APP NEVER CREATES A SETTINGS ROW (2026-11-02). The save used to re-read
// the newest id and, when that read came back empty, INSERT a fresh row from
// whatever was in memory -- after an empty load, the defaults. Row-level
// security answers a read it won't allow with an EMPTY list, not an error, so
// one flaky or denied read plus any Settings tap would have written the
// defaults as the newest row, and every later load (ordered by id) would have
// returned them, shadowing the real row for good. Empty is unknown, not
// absent: a save that can't confirm the row refuses, changes nothing, and
// says to reload. A missing row is created deliberately, in SQL.
// API keys/PIN are intentionally absent from both directions; the caller is
// responsible for merging those back in from localStorage.
let settingsRowId = null; // the row the last successful load read; null = none confirmed
const SETTINGS_NOT_SAVED = 'Setting NOT saved: EDGE2 could not confirm your settings row '
  + '(a connection or permission problem looks the same as a missing row). Nothing was changed. '
  + 'Reload the app, then make the change again.';

// Every user setting and its column (db/038 added the last four).
// disableMacroOverlay is NOT here: macro is observe-only and the overlay is
// pinned off by the build (MACRO_OVERLAY_PINNED_OFF in app.js); the save
// writes the column as true and the load never reads it back into settings.
const SETTINGS_COLUMNS = {
  budget: 'budget', includeUnder2: 'include_under2', showWatch: 'show_watch', minVolume: 'min_volume',
  forcePreMarketMode: 'force_pre_market_mode', riskPerTradePct: 'risk_per_trade_pct',
  floatThresholdShares: 'float_threshold_shares', maxLossPct: 'max_loss_pct', developerTools: 'developer_tools',
};
const BOOLEAN_SETTINGS = new Set(['includeUnder2', 'showWatch', 'forcePreMarketMode', 'developerTools']);
const SETTINGS_ROW_MISSING = 'Your settings row is missing from Supabase (or this session can\'t read it: '
  + 'a permission problem looks the same). EDGE2 won\'t run on default settings. Reload to try again; '
  + 'if it persists, the row has to be restored in SQL.';

// Returns ONLY the settings Supabase holds a value for: a NULL column (one of
// the four db/038 added, before its first save) is absent, so the caller keeps
// that setting's phone value or default and its source says which. A missing
// row is an error, never "nothing migrated yet": Roman's row has existed since
// 2026-08-17, and an RLS-denied read returns the same empty result.
async function loadSettingsFromSupabase() {
  const { data, error } = await supabaseClient
    .from('settings').select('*').order('id', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) { settingsRowId = null; throw new Error(SETTINGS_ROW_MISSING); }
  settingsRowId = data.id;
  const out = {};
  for (const [k, col] of Object.entries(SETTINGS_COLUMNS)) {
    if (data[col] == null) continue;
    out[k] = BOOLEAN_SETTINGS.has(k) ? !!data[col] : data[col];
  }
  // db/042: shown in Settings and on the Add button. Never what a trade is recorded under: confirm re-reads it
  // (readExecutionMode), so a tab left open can't record under a toggle changed elsewhere. Not in SETTINGS_COLUMNS:
  // it is never saved through saveSettingsToSupabase, only through writeExecutionMode. (Carve of (c), 2026-11-12.)
  out.executionMode = data.execution_mode ?? null;
  out.executionModeSetAt = data.execution_mode_set_at ?? null;
  return out;
}

// db/042: the toggle as the database holds it NOW: { mode: 'live' | 'paper' | null (never set), setAt }. Throws when
// it can't be read, including when no settings row was confirmed: unknown, never null. The caller decides what that
// means. setAt comes with the mode so a screen never shows the mode from one read beside the time from another.
async function readExecutionMode() {
  if (settingsRowId == null) throw new Error('no settings row confirmed (reload the app)');
  const { data, error } = await supabaseClient.from('settings').select('execution_mode, execution_mode_set_at').eq('id', settingsRowId).limit(1);
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error('the settings row could not be read');
  const m = data[0].execution_mode;
  if (m !== null && m !== 'live' && m !== 'paper') throw new Error(`unexpected execution_mode ${m}`);
  return { mode: m, setAt: data[0].execution_mode_set_at ?? null };
}

// db/042: set the toggle, then log the change -- settings first, so a log row never records a change that didn't
// happen. Resolves { settings: null | message, log: null | message, at }, never throws (at: the instant written as
// execution_mode_set_at, null when the setting wasn't saved): the caller shows any failure,
// and a trade waiting on the choice proceeds either way. `from` is the mode as last READ from the database (null =
// never set); a caller that couldn't read it doesn't call this, since the log would have to guess it.
async function writeExecutionMode(to, from) {
  if (to !== 'live' && to !== 'paper') return { settings: `not a mode: ${to}`, log: 'not attempted', at: null };
  if (from !== null && from !== 'live' && from !== 'paper') return { settings: `not a mode: ${from}`, log: 'not attempted', at: null };
  // THE PHONE'S CLOCK, not the server's: execution_mode_set_at and the log's changed_at are this one instant, so they
  // agree with each other, but a wrong phone clock writes a wrong provenance time (the log's recorded_at is the
  // server's DEFAULT now(), the cross-check). Noted by the reviewer 2026-11-12; the columns' COMMENTs say so with the
  // next migration that touches settings or execution_mode_changes, since a COMMENT is schema.
  const at = new Date().toISOString();
  try {
    if (settingsRowId == null) throw new Error(SETTINGS_NOT_SAVED);
    const { data, error } = await supabaseClient.from('settings')
      .update({ execution_mode: to === 'live' ? 'live' : 'paper', execution_mode_set_at: at, updated_at: at })
      .eq('id', settingsRowId).select('id');
    if (error) throw error;
    if (!data || data.length !== 1) throw new Error(SETTINGS_NOT_SAVED);
  } catch (e) {
    return { settings: e.message, log: 'not attempted: the setting did not change', at: null };
  }
  try {
    const { error } = await supabaseClient.from('execution_mode_changes').insert([{
      changed_at: at,
      from_mode: from === null ? null : from === 'live' ? 'live' : 'paper',
      to_mode: to === 'live' ? 'live' : 'paper',
    }]);
    if (error) throw error;
  } catch (e) {
    return { settings: null, log: e.message, at };
  }
  return { settings: null, log: null, at };
}

// Writes every setting whose source is a real value (supabase, phone, user),
// never one still on its default: a default nobody chose must not become a
// stored setting. On success, every written setting's source is 'supabase'.
async function saveSettingsToSupabase(settings, sources = (typeof state !== 'undefined' && state.settingsSource) || {}) {
  const row = { disable_macro_overlay: true, updated_at: new Date().toISOString() };
  const written = [];
  for (const [k, col] of Object.entries(SETTINGS_COLUMNS)) {
    if (sources[k] === 'default' || settings[k] === undefined) continue;
    row[col] = BOOLEAN_SETTINGS.has(k) ? !!settings[k] : settings[k];
    written.push(k);
  }
  if (settingsRowId == null) throw new Error(SETTINGS_NOT_SAVED);
  const { data, error } = await supabaseClient
    .from('settings').update(row).eq('id', settingsRowId).select('id');
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error(SETTINGS_NOT_SAVED);
  for (const k of written) sources[k] = 'supabase';
  return written;
}
