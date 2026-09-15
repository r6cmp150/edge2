// core/clock.js — owned by neither engine. core/ never imports from engines/.
// Market session state (Pacific-time market status, trading-day calendar).
// Moved from app.js (Phase 0 extraction) — see the breadcrumb comments left
// at each original call site.

const HOLIDAYS = new Set([
  '2024-01-01','2024-01-15','2024-02-19','2024-03-29','2024-05-27',
  '2024-06-19','2024-07-04','2024-09-02','2024-11-28','2024-12-25',
  '2025-01-01','2025-01-20','2025-02-17','2025-04-18','2025-05-26',
  '2025-06-19','2025-07-04','2025-09-01','2025-11-27','2025-12-25',
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
  '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25'
]);

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function getPT(date = new Date()) {
  return new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function ptDateStr(pt) {
  return pt.toLocaleDateString('en-CA'); // YYYY-MM-DD
}

// Converts a PT wall-clock date+time into the real absolute instant it
// represents — correct across the PDT/PST transition and, crucially,
// independent of the running machine's own system timezone. This is NOT
// the getPT() pattern (a Date whose local fields read as PT but whose own
// instant is off by the system-vs-PT offset) — that shape is safe only
// for a same-frame difference (see CLAUDE.md's rule) and this result gets
// sent to Alpaca as a bars request's start/end, an absolute instant
// leaving that coordinate system. Sidesteps the whole class of bug by
// never mutating a Date's local fields at all: formats a UTC guess back
// through Intl with an explicit America/Los_Angeles zone, measures how
// far off that reading is from the wanted wall-clock time, and corrects.
// Converges in one correction for any time not within a few hours of the
// DST transition itself (2am PT) — never true for replay's own callers
// (pre-market open, regular close) — confirmed by a second, idempotent
// pass rather than assumed.
function ptWallClockToInstant(dateStr, hour, minute) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let guess = new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
  const wantedUTC = Date.UTC(y, m - 1, d, hour, minute, 0);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(guess).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    // hour12:false renders midnight as '24', not '00' — normalize.
    const shownHour = parts.hour === '24' ? 0 : Number(parts.hour);
    const shownUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), shownHour, Number(parts.minute), 0);
    const diffMs = wantedUTC - shownUTC;
    if (diffMs === 0) break;
    guess = new Date(guess.getTime() + diffMs);
  }
  return guess;
}

function isTradingDay(pt) {
  const dow = pt.getDay();
  if (dow === 0 || dow === 6) return false;
  return !HOLIDAYS.has(ptDateStr(pt));
}

// TESTING ONLY — Settings > Testing > "Force pre-market mode (testing)".
// Lets the pre-market movers section (and its tap/expand/Groq flow) be
// exercised outside real pre-market hours. Remove once no longer needed.
function getMarketStatus() {
  if (state.settings.forcePreMarketMode) {
    return { status:'PRE', label:'PRE-MARKET (TEST MODE)', color:'#ffd166',
             countdown:'Forced via Settings testing toggle', isOpen:false };
  }
  const pt = getPT();
  const h = pt.getHours(), m = pt.getMinutes();
  const tMin = h * 60 + m;
  const trading = isTradingDay(pt);

  if (trading && tMin >= 390 && tMin < 780) {   // 6:30am–1:00pm
    const left = 780 - tMin;
    return { status:'OPEN', label:'MARKET OPEN', color:'#00ff88',
             countdown:`Closes in ${Math.floor(left/60)}h ${left%60}m`, isOpen:true };
  }
  if (trading && tMin >= 60 && tMin < 390) {     // 1:00am–6:30am
    const left = 390 - tMin;
    return { status:'PRE', label:'PRE-MARKET', color:'#ffd166',
             countdown:`Opens in ${Math.floor(left/60)}h ${left%60}m`, isOpen:false };
  }
  if (trading && tMin >= 780 && tMin < 1020) {   // 1:00pm–5:00pm
    const left = 1020 - tMin;
    return { status:'AH', label:'AFTER HOURS', color:'#ffd166',
             countdown:`Extended hours end in ${Math.floor(left/60)}h ${left%60}m`, isOpen:false };
  }

  // Closed — find next open
  const cd = getCountdownToOpen();
  return { status:'CLOSED', label:'MARKET CLOSED', color:'#4a6070',
           countdown:`Opens in ${cd}`, isOpen:false };
}

function getCountdownToOpen() {
  const now = new Date();
  const ptNow = getPT(now);
  for (let d = 0; d <= 10; d++) {
    // Built entirely from ptNow (getPT()-derived), never from `now`
    // directly — advancing a real Date's .getDate() by d here would read
    // the SYSTEM's local calendar day before any PT conversion happens,
    // which can pick the wrong day near either timezone's midnight
    // boundary on a machine not set to Pacific (a real bug, found and
    // fixed 2026-08-26). Safe here because dayPT is only ever compared
    // against another getPT()-derived value (ptNow, below) — see
    // CLAUDE.md's rule on this exact pattern.
    const dayPT = new Date(ptNow);
    dayPT.setDate(ptNow.getDate() + d);
    if (!isTradingDay(dayPT)) continue;

    dayPT.setHours(6, 30, 0, 0);
    const diffMs = dayPT - ptNow;
    if (diffMs > 0) {
      const mins = Math.floor(diffMs / 60000);
      return `${Math.floor(mins/60)}h ${mins%60}m`;
    }
  }
  return '—';
}

function isAfternoonMode() {
  const pt = getPT();
  const tMin = pt.getHours() * 60 + pt.getMinutes();
  return tMin >= 720; // 12:00pm Pacific
}

// TESTING ONLY — see getMarketStatus() override above; both must agree so
// the section renders (getMarketStatus) and its data actually gets computed
// (isPreMarketHours, gating the computePreMarketMovers() call in runScreener).
function isPreMarketHours() {
  if (state.settings.forcePreMarketMode) return true;
  const pt = getPT();
  const tMin = pt.getHours() * 60 + pt.getMinutes();
  return isTradingDay(pt) && tMin >= 60 && tMin < 390;
}

function isAfterHoursMode() {
  return getMarketStatus().status === 'AH';
}

function isMarketHoursNow() {
  const pt = getPT();
  const tMin = pt.getHours() * 60 + pt.getMinutes();
  return isTradingDay(pt) && tMin >= 390 && tMin < 780; // 6:30am–1:00pm PT
}

// Bug 4 follow-up. Hours since the most recent trading day's regular-session
// close STRICTLY BEFORE `now` — e.g. on a Tuesday after a Monday holiday,
// this reaches back to the preceding Friday's close (~85h), not Monday's
// (which never opened). Used to size the news-fetch lookback window wide
// enough to cover a long weekend without hardcoding session lengths
// elsewhere. Walks backward day-by-day, mirroring getCountdownToOpen's
// forward walk above, so both share the same isTradingDay/HOLIDAYS source
// of truth rather than reasoning about weekends independently.
function hoursSincePreviousClose(now = new Date()) {
  const ptNow = getPT(now);
  for (let d = 1; d <= 10; d++) {
    // .setDate()/.setHours() on dayPT/closePT below look identical to the
    // getCountdownToOpen bug (a real Date's .getDate() read before PT
    // conversion) — they're safe here for a different reason: both are
    // derived from ptNow (getPT()-derived), never from a real Date
    // directly, and the ONLY use of the result is a difference against
    // ptNow (the return statement below). Same offset on both sides of a
    // subtraction cancels, so the duration is correct even though neither
    // dayPT nor closePT is individually a correct real instant. This stops
    // being safe the moment either one is used as an absolute timestamp
    // instead — .toISOString()'d, sent to an API, or persisted. See
    // CLAUDE.md's rule on this exact pattern.
    const dayPT = new Date(ptNow);
    dayPT.setDate(ptNow.getDate() - d);
    if (!isTradingDay(dayPT)) continue;
    const closePT = new Date(dayPT);
    closePT.setHours(13, 0, 0, 0); // 1:00pm PT regular session close
    return (ptNow - closePT) / 3600000;
  }
  return null; // no trading day found in the last 10 days — shouldn't happen
}

// EARLY_CLOSES: date -> regular-session close time, minutes since
// midnight PT. Both 2026 entries close at 1:00pm ET = 10:00am PT (day
// after Thanksgiving, Christmas Eve) -- the two Wall Street early closes
// that land in this app's operating window before the next HOLIDAYS-style
// table update is due. AFTER_HOURS still runs its normal 4-hour extended
// session AFTER whichever close applies that day -- it's the regular
// session that shrinks on an early-close day, not the extended one, so
// AFTER_HOURS is computed as [closeMin, closeMin+240) rather than a fixed
// window.
//
// db/020_backfill_buy_session.sql's SQL twin does NOT implement this --
// that migration is a one-time backfill, already approved and run
// against data with no early-close trades in it (2026-08-17 forward,
// before either 2026 date above). Adding EARLY_CLOSES here is correct for
// classifySession() going forward but makes 020's SQL a snapshot of this
// function as it stood before this comment, not a living twin of it --
// the duplication this file's classifySession() comment warns about
// ended here. A future backfill that needs to be early-close-aware is a
// NEW migration against 020's already-applied state, not an edit to 020.
const EARLY_CLOSES = {
  '2026-11-27': 600, // day after Thanksgiving
  '2026-12-24': 600, // Christmas Eve
};

// classifySession -- the four-value session classifier (phase-9-entry-
// exit-spec.md §1.3). Takes an already-PT wall-clock date+time (a
// 'YYYY-MM-DD' string and an 'HH:MM' 24h string), NOT an absolute
// instant -- both the live call site (buy_time is captured via getPT()
// at the moment of purchase, already Pacific) and the historical backfill
// (buy_date/buy_time pulled straight from trades_v2) already have PT wall-
// clock values in hand, so no getPT()-instant conversion is needed either
// way; see CLAUDE.md's rule on why mutating/converting a getPT()-derived
// Date into an absolute instant is unsafe, and why this function sidesteps
// the whole class by never doing that conversion at all.
//
// Same time windows as getMarketStatus() (OPEN/PRE/AH/CLOSED), restated
// here because getMarketStatus() only ever answers for "right now" via a
// bare getPT() call with no override -- it cannot classify a historical
// buy_time. Whichever of these changes, the other must change with it or
// "now" and "backfilled" will silently disagree.
//
// db/020_backfill_buy_session.sql reimplements this SAME logic in SQL to
// backfill existing rows in one UPDATE -- the two must produce identical
// answers on every row (verified by the backfill migration's own
// verification query) or one of them is wrong and it will not be obvious
// which.
function classifySession(dateStr, hhmm) {
  const d = new Date(dateStr + 'T12:00:00'); // noon, local-parsed -- date-of-week only, see businessDaysBetween's own comment on this exact pattern
  const dow = d.getDay();
  if (dow === 0 || dow === 6 || HOLIDAYS.has(dateStr)) return 'CLOSED';

  const [h, m] = hhmm.split(':').map(Number);
  const tMin = h * 60 + m;
  const closeMin = EARLY_CLOSES[dateStr] ?? 780; // 1:00pm PT normally, 10:00am PT on an early close
  if (tMin >= 390 && tMin < closeMin) return 'REGULAR';                   // 6:30am-close
  if (tMin >= 60 && tMin < 390) return 'PRE_MARKET';                      // 1:00am-6:30am PT
  if (tMin >= closeMin && tMin < closeMin + 240) return 'AFTER_HOURS';    // close-(close+4h)
  return 'CLOSED';
}

function businessDaysBetween(startDateStr, endDateStr) {
  // T12:00:00 (no zone -> parsed as local time), not T00:00:00, is
  // deliberate: noon gives ~12h of slack on either side before a
  // system/PT timezone offset could shift this onto the wrong calendar
  // day. Not strictly PT-aware, but that slack covers any realistic
  // machine timezone — not worth the complexity of a real PT anchor here.
  const start = new Date(startDateStr + 'T12:00:00');
  const end   = new Date(endDateStr   + 'T12:00:00');
  let count = 0;
  const cur = new Date(start);
  while (cur < end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}
