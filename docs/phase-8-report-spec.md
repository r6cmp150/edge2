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

## What it must never do

- Name a winner without an n beside it
- Recommend a trade — it's a scoreboard, not a signal
- Print a percentage without its denominator next to it
- Average a null as a zero
- Show a rate computed across sessions, engines, or windows that aren't comparable

## Build order — the report is LAST

Can't be validated until there are outcomes to read, which needs: the QUALIFIED floor settled on OPEN data (Monday), db/010 and --write, the outcome-filling job, and EDGE's server-side logger (needs scoreStock extraction landed). Design now so Monday isn't the bottleneck; don't build before there's data to build against.

## Acceptance test

Same standard as the trades_v2 migration: generate it and READ it. Not "does it run" — does a person reading the output reach a conclusion the data supports? Run it against whatever partial data exists, deliberately including an incomplete scan run and a closed-session run, and confirm the report REFUSES to pool them rather than quietly doing so.
