// core/macro.js -- the macro observation, shared by the app and the scheduled logger (2026-11-19, the reviewer:
// "the observation functions extracted to core/macro.js so neither side reimplements the other"). MOVED VERBATIM from
// app.js (MACRO_ETFS, MACRO_CONDITIONS, and section 6b through macroWouldAdjust). Nothing here is new. observeMacro
// stays in app.js verbatim: its row literal must sit beside its insert for tests/_write-walker.js to read the write.
// A classic script, like the other core/ files: its globals are the app's, and index.html loads it before app.js.
// Call-time globals it reads (each counted in this file's code, 2026-11-19): scanFreshness and ptDateTimeOf
// (core/clock.js); fetchNewsForTickers, state.newsLastRequest and state.newsUnavailable (core/news.js);
// getMacroAdjustment and MACRO_ADJUSTMENTS (core/edge-scoring.js); wouldBeDisplayThreshold and GROQ_MODEL (app.js);
// state.settings.groqKey and fetch (askMacroGroq, to Groq).

// VIX excluded — it's a CBOE index, not an equity, and is not obtainable through
// Alpaca's /stocks endpoints on any tier. See Macro Market Overlay addendum.
const MACRO_ETFS = ['SPY', 'XLE', 'XLK', 'XBI', 'XLF', 'XLI', 'XLRE', 'XLY'];
const MACRO_CONDITIONS = [
  'RISK_OFF', 'GEOPOLITICAL', 'TECH_ROTATION_OUT', 'BROAD_RALLY', 'MOMENTUM_DAY',
  'SECTOR_WEAKNESS_BIOTECH', 'SECTOR_WEAKNESS_ENERGY', 'SECTOR_WEAKNESS_TECH', 'CHOPPY'
];

// ── 6b. MACRO MARKET OVERLAY ─────────────────────────────────────

// Step 1: pattern-match today's ETF moves into a market condition.
// Evaluated in spec order — `matched` preserves that order so matched[0] is the
// first-match winner; matched.length > 1 signals an ambiguous day for Step 2 (Groq).
function classifyMacroCondition(changes) {
  const spy = changes.SPY || 0;
  const xle = changes.XLE || 0;
  const xlk = changes.XLK || 0;
  const xbi = changes.XBI || 0;
  const xlf = changes.XLF || 0;
  const sectors = [xle, xlk, xbi, xlf];

  const matched = [];

  // RISK_OFF — VIX removed (unavailable via Alpaca /stocks); substituted with
  // a breadth check (3+ of 4 sector ETFs also negative) to keep the "broad
  // panic, everything dropping" intent. Confirmed with Roman before implementing.
  if (spy <= -2 && sectors.filter(v => v < 0).length >= 3) matched.push('RISK_OFF');

  if (spy <= -1 && xle >= 1) matched.push('GEOPOLITICAL');

  if (xlk <= -1.5 && (xle >= 0.5 || xlf >= 0.5)) matched.push('TECH_ROTATION_OUT');

  if (spy >= 1 && sectors.filter(v => v > 0).length >= 3) matched.push('BROAD_RALLY');

  if (spy >= 1.5 && xlk >= 1.5) matched.push('MOMENTUM_DAY');

  // Sector weakness — SPY flat or only mildly down (<1%)
  if (spy > -1) {
    if (xbi <= -1.5) matched.push('SECTOR_WEAKNESS_BIOTECH');
    if (xle <= -1.5) matched.push('SECTOR_WEAKNESS_ENERGY');
    if (xlk <= -1.5) matched.push('SECTOR_WEAKNESS_TECH');
  }

  const condition = matched.length ? matched[0] : 'CHOPPY';
  return { condition, matched };
}

// Fetches today's % change for the macro ETF basket and pattern-matches a
// market condition. Called once per session (see runScreener) — result is
// cached on state.macroContext, not re-fetched per scan or per card.
// ── MACRO, OBSERVE-ONLY (db/038, 2026-11-02) ─────────────────────────
// The condition is fetched EVERY scan (it used to be once per page load,
// cached all day with no fetch time, so a logged condition could belong to
// hours earlier: 10-29's 07:18 buys carry SPY +0.07 against -0.35 a minute
// later). Each fetch is one macro_observations row holding both answers,
// Groq's inputs, the path, the cut in effect (the base line, always) and
// the adjustment that WOULD have applied. Nothing here changes a score, the
// display cut, or what's shown (MACRO_OVERLAY_PINNED_OFF).
const MACRO_REQUIRED_ETFS = ['SPY', 'XLE', 'XLK', 'XBI', 'XLF']; // what classifyMacroCondition reads
const MACRO_GROQ_TEMPERATURE = 0; // a classifier: the same stored inputs must give the same answer (was 0.2)
const MACRO_HEADLINE_HOURS = 6;
const MACRO_HEADLINE_LIMIT = 5;

// Percent change vs the previous close per ETF, or NULL when the quote or the
// previous close is missing. Never 0: getLivePrice returns 0 for a missing
// snapshot, which used to become a 0% move, a flat sector nobody measured,
// fed straight into the classifier.
//
// A STALE quote is not a number either (2026-11-03). Before an ETF's first
// trade of the day, Alpaca's dailyBar is the previous session's, so dailyBar
// over prevDailyBar is YESTERDAY'S move, which looks perfectly valid. That
// ETF's move is unjudged: NULL, and named in `unjudged`, not `missing`.
function macroMovesFromSnapshots(snaps, nowMs) {
  const changes = {};
  const missing = [];
  const unjudged = [];
  const barDates = {};
  for (const t of MACRO_ETFS) {
    const snap = snaps ? snaps[t] : null;
    const price = (snap && snap.dailyBar && snap.dailyBar.c) || (snap && snap.latestTrade && snap.latestTrade.p) || null;
    const prev = (snap && snap.prevDailyBar && snap.prevDailyBar.c) || null;
    const bar = macroBarState(snap, nowMs);
    barDates[t] = bar.asOf ?? null;
    if (!(price > 0) || !(prev > 0)) { changes[t] = null; missing.push(t); continue; }
    if (bar.state !== 'CURRENT') { changes[t] = null; unjudged.push(t); continue; }
    changes[t] = ((price - prev) / prev) * 100;
  }
  return { changes, missing, unjudged, barDates };
}

// Is this ETF's dailyBar from the reading's own date? Same stamp as the gate
// and the card (scanFreshness), but NOT dailyBarSessionAge's answer, on
// purpose: that function calls a previous-session bar CURRENT before the open
// and on a closed day, because the gate asks "is this the newest bar there
// is?" and pre-market it is. The macro move asks "is this TODAY'S move?", and
// pre-market it isn't. An undated bar is UNJUDGED, never assumed current.
function macroBarState(snap, nowMs) {
  const asOf = scanFreshness(snap, nowMs).dailyBarAsOf;
  if (asOf == null) return { state: 'UNJUDGED' };
  return { state: asOf === ptDateTimeOf(nowMs).date ? 'CURRENT' : 'EARLIER_SESSION', asOf };
}

// Which answer the banner shows, and the path that says why. The rule for
// RESOLVING is unchanged (the pattern answer, unless it's CHOPPY, ambiguous,
// or couldn't be computed, when Groq's answer is used if there is one); it
// just no longer drives anything but the banner and the record.
function decideMacroPath({ patternCondition, ambiguous, groqCondition }) {
  const needsGroq = patternCondition == null || patternCondition === 'CHOPPY' || ambiguous;
  if (!needsGroq) return { path: 'pattern', condition: patternCondition };
  if (groqCondition) return { path: 'groq', condition: groqCondition };
  // Groq needed and failed: the pattern's own classification stands when it has one (CHOPPY, or an ambiguous one).
  // When there is none, the engine ran and classified nothing: its own value (db/038 revision e), never the same path
  // as a classification told apart by a NULL condition.
  if (patternCondition != null) return { path: 'pattern_groq_failed', condition: patternCondition };
  return { path: 'unclassified', condition: null };
}

// When Groq is asked (phase-10 spec, one rule): once per trading day
// UNCONDITIONALLY, so the disagreement record isn't conditioned on
// ambiguity, plus again whenever the pattern answer changes intraday.
// Otherwise the day's last answer is carried (groq_asked false).
function macroGroqAskReason(last, tradingDate, patternCondition) {
  if (!last || last.tradingDate !== tradingDate) return 'daily';
  if (last.patternCondition !== patternCondition) return 'pattern_changed';
  return null;
}

// The SPY/QQQ headlines from the last 6 hours, and the exact request behind
// them (core/news.js state.newsLastRequest). The feed is irreproducible by
// construction, so these are the only record of what Groq saw.
async function fetchMacroHeadlines() {
  const news = await fetchNewsForTickers(['SPY', 'QQQ']);
  const cutoff = Date.now() - MACRO_HEADLINE_HOURS * 3600000;
  const headlines = news.filter(n => new Date(n.created_at).getTime() >= cutoff).slice(0, MACRO_HEADLINE_LIMIT);
  const request = Object.assign({}, state.newsLastRequest || null, {
    filter_hours: MACRO_HEADLINE_HOURS, limit: MACRO_HEADLINE_LIMIT, returned: news.length,
    news_unavailable: !!state.newsUnavailable,
  });
  return { headlines, request };
}

const fmtMove = v => (v == null ? 'not available' : `${v.toFixed(2)}%`);
function buildMacroGroqPrompt(changes, headlines) {
  const headlineLines = headlines.length
    ? headlines.map(h => h.headline).join('\n')
    : '(no recent headlines available)';
  return `You are a macro market analyst. Based on these ETF movements and headlines,
classify today's market condition as exactly one of:
RISK_OFF, GEOPOLITICAL, TECH_ROTATION_OUT, BROAD_RALLY, MOMENTUM_DAY,
SECTOR_WEAKNESS_BIOTECH, SECTOR_WEAKNESS_ENERGY, SECTOR_WEAKNESS_TECH, CHOPPY

ETF movements today:
SPY: ${fmtMove(changes.SPY)}
XLE: ${fmtMove(changes.XLE)}
XLK: ${fmtMove(changes.XLK)}
XBI: ${fmtMove(changes.XBI)}
XLF: ${fmtMove(changes.XLF)}

Recent market headlines:
${headlineLines}

Respond with ONLY the condition label and a single sentence explanation.
Example: "GEOPOLITICAL — Oil prices spiking on Middle East tensions driving
energy up while broad market sells off."`;
}

// One Groq ask, with everything it was given and everything it said. Never
// throws: a failure is a recorded result (groq_failed, groq_error), since
// pattern_groq_failed is a value the record has to be able to count.
async function askMacroGroq(changes) {
  const out = { groq_condition: null, groq_failed: true, groq_error: null, groq_model: GROQ_MODEL, groq_temperature: MACRO_GROQ_TEMPERATURE,
    groq_request: null, groq_headlines: null, groq_headlines_empty: null, groq_raw_reply: null, explanation: null };
  const key = state.settings.groqKey;
  if (!key) { out.groq_error = 'no Groq key configured'; return out; }
  try {
    const { headlines, request } = await fetchMacroHeadlines();
    out.groq_request = request;
    out.groq_headlines = headlines.map(h => ({ id: h.id ?? null, created_at: h.created_at ?? null, source: h.source ?? null, headline: h.headline ?? '' }));
    out.groq_headlines_empty = headlines.length === 0;
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: buildMacroGroqPrompt(changes, headlines) }], temperature: MACRO_GROQ_TEMPERATURE, max_tokens: 2000 }),
    });
    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const data = await r.json();
    const raw = data.choices?.[0]?.message?.content ?? '';
    out.groq_raw_reply = raw;
    const text = raw.trim().replace(/^["']|["']$/g, '');
    const re = new RegExp(`^\\**\\s*(${MACRO_CONDITIONS.join('|')})\\**\\s*[—-]+\\s*(.*)$`, 's');
    const match = text.match(re);
    if (!match) { out.groq_error = 'the reply did not name one of the conditions'; return out; }
    out.groq_condition = match[1];
    out.explanation = match[2].trim();
    out.groq_failed = false;
    return out;
  } catch (e) {
    out.groq_error = String(e?.message || e).slice(0, 300);
    return out;
  }
}

// The counterfactual, recorded and never applied: what the overlay would have
// done to each category's score and display line under this condition.
function macroWouldAdjust(condition) {
  if (!condition) return null;
  const categories = Object.keys(MACRO_ADJUSTMENTS.CHOPPY);
  return {
    score: Object.fromEntries(categories.map(c => [c, getMacroAdjustment(condition, c)])),
    display_threshold: Object.fromEntries(categories.map(c => [c, wouldBeDisplayThreshold(condition, c)])),
  };
}

