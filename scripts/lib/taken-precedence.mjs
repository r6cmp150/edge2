// Causality precondition for signal_log.taken_resolution (2026-10-09).
//
// A signal cannot be "taken" by -- or "traded against" by -- a trade that
// predates it. fill-outcomes' Pass 2 previously matched on (symbol,
// engine, buy_date in [signal_date, signal_date+9]) only, with no
// time-of-day check, so a 7:30am PT buy could be credited to a signal the
// logger first recorded at 12:15pm PT the same day. Verified against
// production on 2026-10-09: all 4 same-day matches in signal_log were
// exactly that (buy before first_shown_at); cross-day matches were fine.
//
// Buy instant = trades_v2.buy_date + buy_time, both PT wall clock (app.js
// writes buy_time from getPT() at the moment Roman enters the position).
// That is the ORDER-PLACEMENT moment, not the fill: for a market order they
// coincide; for a limit order (e.g. the 24 rows placed Sunday 2026-09-27
// that filled Sunday night or Monday) they don't. PLACEMENT IS THE CORRECT
// COMPARISON HERE, deliberately, for limit orders too: "taken" asks whether
// the signal could have informed the DECISION, and the decision is the
// order. A signal first shown Monday 6:45am cannot have caused an order
// placed Sunday, even if the fill came Monday 6:31am. A fill timestamp
// (trades_v2.filled_at) must never be substituted in here -- it belongs to
// hold duration, not attribution. (Re-placing an order after seeing a
// signal is a new decision; record the new placement time.)
//
// THE ASYMMETRY IS INTENTIONAL, NOT A BUG: hold duration uses FILL times
// (filled_at -> sold_at, when known) and this check uses the ORDER time.
// They answer different questions -- "how long was the money exposed" vs
// "could the signal have informed the decision" -- and each uses the
// timestamp that matches its question. Decided 2026-10-09 after it was
// proposed the other way and argued out; don't "fix" it to match. buy_time can be missing on older rows;
// with no time of day the only provable ordering is a strictly later
// calendar day, so a same-day trade with no buy_time does NOT qualify --
// unknown is not evidence of precedence.

export function tradeBuyInstant(trade, ptWallClockToInstant) {
  const m = /^(\d{2}):(\d{2})$/.exec(trade.buy_time || '');
  if (!m) return null;
  return ptWallClockToInstant(trade.buy_date, Number(m[1]), Number(m[2]));
}

export function signalPrecedesTrade(row, trade, ptWallClockToInstant) {
  const buyInstant = tradeBuyInstant(trade, ptWallClockToInstant);
  if (buyInstant) return new Date(row.first_shown_at) <= buyInstant;
  return trade.buy_date > row.signal_date;
}
