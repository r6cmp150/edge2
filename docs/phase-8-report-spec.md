# Phase 8 — the comparison report

Specification of what the report must answer and what it must never do. Mechanics are Claude's to propose; the questions are not.

FORMAT DECIDED: extends the existing generateClaudeReport() text output. Roman taps a button, copies, pastes into chat. No new UI. Chosen because the text goes through a reader who checks it — which has caught six data defects this week that a rendered number would have hidden.

## The question this report exists to answer

Roman's words: "each one is clearly labeled on the report if it comes from edge or warrior so we can see which performs better."

One question, three faces, three different denominators:

- WARRIOR OVERALL — every signal Warrior surfaced, traded or not. Does the engine's output make money on paper?
- EDGE OVERALL — same, other engine.
- ROMAN VS EACH ENGINE — his trades against the full list he was shown. Does his selection beat taking the whole list?

The third cut is what needs signal_log. Without a record of signals shown but NOT taken, the report measures Roman's picking and calls it the engine's performance. That confusion is the entire reason Phase 7 exists.

## Where each number comes from

- Traded outcomes — trades_v2, with engine_source ('EDGE'/'WARRIOR'/NULL) and source ('App Signal'/'Own Decision') as INDEPENDENT axes. NULL engine_source means no engine produced it. Never collapse those two columns into one label — Roman can act on his own judgment on a stock Warrior surfaced, and that case has to stay visible.
- Untraded outcomes — signal_log's ret_5m … ret_5d, filled by the outcome job. The report is not buildable until that job runs.
- The link — trades_v2.signal_log_id, with the outcome job's resolution states: unresolved / taken-exact / taken-by-fallback / not-taken-confirmed. source = 'Own Decision' rows are excluded from fallback matching entirely.

## Rules the report enforces itself, not left to the reader

1. NEVER POOL POPULATIONS THAT AREN'T COMPARABLE.
   - OPEN vs CLOSED session rows. RVOL is structurally uncheckable outside market hours. Join through scan_session → scan_runs.session. Required, not optional.
   - Complete vs incomplete scan runs. A run that evaluated 40 of 60 looks exactly like a day with 40 candidates.
   - Periods where only one engine was logging. If Warrior logs from day 1 and EDGE from day 12, the first eleven days cannot appear in a head-to-head. State the overlapping window and compute only inside it.
   - Pre-migration trades. The 37 migrated rows are null for peak price, ATR, near-miss, news, signals-fired. Disclose the count; never let null average as zero.

2. NOT_EVALUATED IS A COUNT, NEVER A SILENCE. Tier totals must sum to candidates scanned. If 10 of 23 weren't judged, that appears on the same line as the qualification rate, not in a footnote.

3. THE REPORT MUST BE ABLE TO SAY "NOT ENOUGH DATA YET." The single most important requirement. At 30 trades nothing is meaningful, and a report that always names a winner will name one on three trades and be believed. Every comparison prints its n. Below the pre-committed review point (30 Warrior trades or 60 days) the headline reads PROVISIONAL and states what would change it.

4. HONEST DENOMINATOR FOR "ROMAN VS THE ENGINE." His picks compare against the full list shown that day, not the subset that happened to work. That's the same selection bias that contaminated the original backtest.

5. THE STANDING VERDICT TRAVELS WITH ANY POSITIVE RESULT. The 18-month backtest was negative at every horizon, every float bucket, every cell of the stop/target grid. If forward results look good on a small sample, that's a reason to check the sample. The report says so in its own text so the caveat can't be separated from the numbers.

## Exit-quality section (added 2026-09-10, Roman's request)

Roman asked for a much better sell rule — specifically "the best real time to pull out so I can sell high always." Told him plainly: nobody can call the top in real time, anything claiming to is either curve-fitted or guessing, and the backtest already tested ~50 stop/target combinations with every one negative. What replaces it: a measurable question instead of an impossible one. For every closed trade, compare the actual exit against the best exit that was genuinely available, report the gap, and let the trend across his own trades — not a picked rule — be the answer.

**The mechanism already exists, checked directly rather than assumed new:** `trades_v2.best_exit_price`/`best_exit_date`/`best_exit_timing`/`price_at_plus5_days` are real, already-defined columns (`db/002_trades_v2.sql`), and `computeSellTimingAnalysis` (`app.js:1125`) already computes them correctly — best price is the highest daily HIGH actually achieved in the window from buy through 5 trading days past the sell, not a close, and `bestExitTiming` (BEFORE/ON/AFTER) says whether that peak came before, on, or after the day Roman actually sold. A trade isn't resolved (no data point yet) until 5 trading days have passed since the sale — `needsSellTimingResolution`/`sell_timing_resolved` already gate this correctly.

**The gap, and why this section has nothing to read without the outcome-filling job:** `writeSellTimingToSupabase` (`app.js:1207`) has been a no-op since the 2026-09-05 trades_v2 cutover — `trades_v2` has no anon UPDATE policy (fail-closed by design, same posture as signal_log's outcome columns), so the computation still runs client-side into `state.sold` for the current session's Sold-tab display, but nothing has persisted it to Supabase since the cutover. The code's own comment at that line already names the successor: "this gets replaced by the deferred outcome-filling job (its own narrowly-scoped credential, not yet built)." That job was scoped, before this request, as filling `signal_log.ret_5m…ret_5d` only — it now ALSO needs to write `trades_v2`'s four sell-timing columns back, via the same scoped-UPDATE-credential design already tested this session (see the `outcome_filler` role work), not a second credential. Say which columns explicitly rather than leaving "outcome-filling" ambiguous about its own scope.

**What the section reports**, once the job exists and has run long enough for real trades to clear the 5-day window:
- The gap per trade: `(best_exit_price − sell_price) / sell_price`, sold-short of the available peak.
- Average gap, split by engine_source (never pooled — same Rule 1 as everywhere else in this report).
- Average gap, split by hold-duration bucket (DAY / 3-DAY / WEEK / SAME DAY).
- Trend over time (e.g., gap by rolling window of N trades or by calendar month) — "is this improving," not just "what is it now."
- n disclosed at every cut, including how many closed trades are still inside the 5-day window and therefore contribute no data point yet (Rule 3's "not enough data yet" applies here identically — a 3-trade exit-quality average is exactly as unearned as a 3-trade win-rate headline).

## What it must never do

- Name a winner without an n beside it
- Recommend a trade — it's a scoreboard, not a signal
- Print a percentage without its denominator next to it
- Average a null as a zero
- Show a rate computed across sessions, engines, or windows that aren't comparable

## Build order — the report is LAST

Can't be validated until there are outcomes to read, which needs: the QUALIFIED floor settled on OPEN data, db/010 and --write, the outcome-filling job, and EDGE's server-side logger. Design now so this isn't the bottleneck; don't build before there's data to build against.

**The outcome-filling job moved up in priority (2026-09-10):** it was already required to build the report's core three-way comparison (it fills signal_log's ret_*, and without shown-but-not-taken data the report just measures Roman's picking). It's now also the sole dependency of the exit-quality section above — without it, that section has literally nothing to read, not degraded data. Scope it explicitly to cover BOTH signal_log.ret_5m…ret_5d AND trades_v2's four sell-timing columns (best_exit_price/best_exit_date/best_exit_timing/price_at_plus5_days) — the second half already has working computation logic sitting dead since the trades_v2 cutover (see the exit-quality section above), it just needs the job's scoped UPDATE credential pointed at it too.

## Acceptance test

Same standard as the trades_v2 migration: generate it and READ it. Not "does it run" — does a person reading the output reach a conclusion the data supports? Run it against whatever partial data exists, deliberately including an incomplete scan run and a closed-session run, and confirm the report REFUSES to pool them rather than quietly doing so.
