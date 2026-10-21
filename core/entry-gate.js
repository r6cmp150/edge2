// core/entry-gate.js — EDGE entry gate (docs/phase-10-entry-gate-spec.md
// §7.4, §7.6 step 1, §7.7).
//
// A gate on ADVICE, never on RECORDING. Inside a gated window a signal is
// shown as not buyable; recording a trade Roman has already placed stays
// open (behind a confirm). A gate that blocked recording would delete rows
// for exactly the trades it exists to study, and a missing row is
// indistinguishable from a trade that never happened (§7.7).
//
// Evaluated at VIEW time (the moment Roman would place the order), never at
// scan time: scan results are routinely shown hours after the scan ran.
// Whether a recorded trade fell inside a window is derived on read from its
// buy_date/buy_time with the same function -- never stored.
//
// Gated (advice says "not a buy window"), strongest support first:
//   AFTER_HOURS  -- 28 trades / 8 dates, 5 negative, -$43 without its
//                   worst day; the only rule whose support survives
//                   date-clustering.
//   CLOSED       -- reasoning rule (a limit order placed blind to the open);
//                   its evidence is one Sunday evening, n=1 decision.
//   7:00-7:30 PT -- REGULAR session only; the weakest of the three.
// Open and LOGGED (no evidence either way -- must collapse into neither
// "allowed because untested" nor "blocked because untested"):
//   PRE_MARKET   -- zero entries in the whole book.
//   6:30-7:00 PT -- 3 trades once the gated windows are removed.
//
// Same session boundaries as everything else: classifySession (core/
// clock.js), so holidays and early closes come free. On an early-close day
// 7:00-7:30 is still inside REGULAR and still gated.

const ENTRY_GATE_FIRST_HOUR_START = 420; // 7:00am PT, minutes since midnight
const ENTRY_GATE_FIRST_HOUR_END = 450;   // 7:30am PT (exclusive)
const ENTRY_GATE_OPEN_START = 390;       // 6:30am PT, the open

// Returns { gated, rule, logged, label }.
//   gated  -- true when advice must say "not a buy window"
//   rule   -- 'AFTER_HOURS' | 'CLOSED' | 'FIRST_HOUR' | null
//   logged -- 'PRE_MARKET' | 'OPEN_6_30_7_00' | null (open, but counted
//             separately so it becomes judgeable)
//   label  -- short human text for the gated case, else null
// hhmm is PT wall clock "HH:MM"; dateStr is a PT "YYYY-MM-DD".
function entryGateAt(dateStr, hhmm) {
  const session = classifySession(dateStr, hhmm);
  if (session === 'AFTER_HOURS') return { gated: true, rule: 'AFTER_HOURS', logged: null, label: 'After hours — not a buy window' };
  if (session === 'CLOSED') return { gated: true, rule: 'CLOSED', logged: null, label: 'Market closed — not a buy window' };
  if (session === 'PRE_MARKET') return { gated: false, rule: null, logged: 'PRE_MARKET', label: null };
  const [h, m] = hhmm.split(':').map(Number);
  const tMin = h * 60 + m;
  if (tMin >= ENTRY_GATE_FIRST_HOUR_START && tMin < ENTRY_GATE_FIRST_HOUR_END) {
    return { gated: true, rule: 'FIRST_HOUR', logged: null, label: '7:00–7:30 PT — not a buy window' };
  }
  if (tMin >= ENTRY_GATE_OPEN_START && tMin < ENTRY_GATE_FIRST_HOUR_START) {
    return { gated: false, rule: null, logged: 'OPEN_6_30_7_00', label: null };
  }
  return { gated: false, rule: null, logged: null, label: null };
}

// The gate right now, in PT. getPT() fields are read only to format the PT
// wall clock (never mutated or sent anywhere -- CLAUDE.md's getPT rule).
function entryGateNow() {
  const pt = getPT();
  const hhmm = String(pt.getHours()).padStart(2, '0') + ':' + String(pt.getMinutes()).padStart(2, '0');
  return entryGateAt(ptDateStr(pt), hhmm);
}
