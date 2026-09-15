# Phase 9 — Entry Timing and Exit Engine v3

Owner: architecture review. Implementer: Claude Code.
Written 2026-09-15. Evidence base: `data/backups/trades.json` (37 closed
trades, 2026-08-17 → 2026-09-04), `data/backups/rating_snapshots.json`
(1,406 rows), `app.js` as of commit `85095de`.

Roman's brief, verbatim:

> 1) We must get much better at choosing an entry point for me to enter
> the stocks. Considers everything from time of day to all other factors
> like volume
>
> 2) we need to get so so soooo much better at choosing an exit point. I
> feel like this part can even be rewritten from scratch if needed but
> two things must happen here
> a) as a stock is going up I need to be told how long to hold before it
> starts falling so I can sell high
> b) if a stock is falling and I am negative it needs to do much better on
> considering if stock will go back up in the next like 2 days. If not it
> needs to tell me to cut my losses and it needs to do a good job of that
> and be clear

---

## 0. The finding that reorders the whole plan

**The exit engine is calibrated for a ±20% world. Roman trades in a ±4%
world.**

Realized P&L across all 37 closed trades ranges from **−24.03% to
+3.90%**. Not one trade has ever gained more than 4%. Now line that up
against every exit threshold in `calcUnifiedRecommendation`
(app.js:4071–4230):

| Exit mechanism | Fires at | Times it has ever fired |
|---|---|---|
| Loss factor, tier 1 | −8% | 3 of 37 |
| Loss factor, tier 2 | −20% | 1 of 37 |
| Momentum protection arms | +20% gain | **0 of 37** |
| Trailing stop (peak × 0.85) | −15% from peak | **0 of 37** |
| Pullback factor, tier 1 | −15% from peak | **0 of 37** |

**Nine of the twelve losing trades finished between 0% and −8%, which
means no loss-related exit factor was ever evaluated for them at all.**
The engine had nothing to say about three quarters of its own losses.
The three losses that did trip a threshold — TENX −24.03%, KEEL −16.45%,
PGEN −8.68% — tripped it only after the loss had already grown to
between 2× and 6× the size of the best win in the book.

This is not a tuning problem. Every threshold in the exit engine was
chosen for a trade that moves 20%, and Roman's trades move 4%.

### 0.1 The corollary: HOLD STRONG is the default, not a conclusion

`MAX_HOLD_DAYS` is `{DAY: 1, '3-DAY': 4, WEEK: 7}`. The duration block
awards **+20** for "Within intended window" and a further **+10** for
"Early in hold window" (`days < maxHold/2`). `HOLD STRONG` is the label
for composite ≥ +30.

So a WEEK position on day 1 scores **+30 from the calendar alone**,
before a single fact about the stock is evaluated. Add the usual "RSI
neutral-bullish" (+15) and "Above 20-day MA" (+15) and it is at +60 —
deep into HOLD STRONG — on a position the engine knows nothing about.

The record matches: **22 of 37 trades were sold while the app was showing
HOLD STRONG**, and five of those were losses (CXM −4.55%, SLI −1.12%,
SPCH −1.08%, TLYS −0.93%, ABR −0.39%). The engine was saying "hold
strong" at the moment Roman was cutting a loss.

21 of 37 positions were classified WEEK and held an average of 1.7 days.
The duration classification is buying the position 30 free points against
a window it never uses.

### 0.2 Where the money actually went

Total: **−$73.73** across 37 trades, 68% win rate.

- Sum of all wins: **+$92.77** across 25 trades. Largest: CPRI +$11.00.
- Sum of all losses: **−$166.50** across 12 trades. Largest: TENX −$56.00.
- **Three trades — TENX −$56.00, KEEL −$31.50, BTDR −$20.40 — total
  −$107.90. The other 34 trades net +$34.17 at a 74% win rate.**

Position sizing is not a factor: cost basis is $34–$339, mean $249, and
the losers are not the big ones (TENX cost $233, below average).

Roman is good at picking stocks that go up. He has no mechanism that
stops one from going down.

### 0.3 Simulated hard loss cap

Replaying the 37 trades with a hard cut at N% of cost basis:

| Cap | Net P&L | vs actual |
|---|---|---|
| −3% | **+$32.23** | +$106 |
| −4% | **+$17.63** | +$91 |
| −5% | **+$5.81** | +$80 |
| **−6% (chosen)** | **−$3.16** | **+$71** |
| −8% | −$18.89 | +$55 |
| −10% | −$28.68 | +$45 |
| none (actual) | −$73.73 | — |

This is a backward-looking replay on 37 trades and assumes a fill at the
cap, which extended-hours and gap-down moves will not always give. It is
not a promise. It is a statement about which single change has the most
leverage on this book, and the answer is unambiguous.

**Roman's decision: −6%.** Implement it as a named, settings-visible
constant (`MAX_LOSS_PCT`), not a magic number, so it can be moved without
a code change. Note in the settings UI what the replay showed for −3%
through −10% so the tradeoff is visible at the point of adjustment.

### 0.4 Entry time — the real finding, after confirming what the field means

Roman has confirmed that `buy_time` is **his actual fill time**, not when
he logged the trade. That makes the following meaningful rather than an
artifact.

All times Pacific; the market is 06:30–13:00 PT.

| Window | n | Win rate | Total |
|---|---|---|---|
| 09:30–10:00 ET (first 30 min) | 5 | 100% | +$13.05 |
| 10:00–11:00 ET | 12 | 67% | −$15.98 |
| 11:00–16:00 ET | 10 | 60% | +$2.35 |
| **After 16:00 ET (after-hours session)** | **10** | **70%** | **−$73.15** |

Read that last row carefully, because the obvious conclusion is wrong.
Seven of the ten after-hours buys were *profitable*. The −$73.15 is
**three trades**: TENX (bought 16:25 PT = 7:25pm ET, −$56.00), KEEL
(14:06 PT = 5:06pm ET, −$31.50), NEOG (14:12 PT, −$13.75).

The honest statement: **all three of the trades that constitute the
entire loss were bought in the after-hours session, but most after-hours
buys were fine.** After-hours is where the tail risk lives, not where the
average outcome is bad. n = 10 cannot support anything stronger. Buying
into a thin after-hours book — wide spreads, no depth, and an overnight
gap before you can act — is a known mechanism for exactly this shape of
outcome, so the finding is consistent with the mechanism rather than
merely consistent with the data.

**Do not block after-hours entries.** Warn, size down, and measure.

### 0.5 What is *not* measurable yet, and should not be guessed at

With 37 trades, most entry factors have 2–13 observations per bucket.
Volume ratio, RSI band, day of week, and price tier all produce
differences that a sample this size cannot distinguish from noise. The
previously-reported "higher score predicts worse outcome" inversion
survives at this sample too (score <50 → +$16.82; score ≥90 → −$37.60),
but it is driven by the same handful of trades and should be treated as a
hypothesis to test, not a finding to act on.

Two entry observations are worth carrying forward as hypotheses only:

- `catalyst_setup = true`: 5 trades, 5 wins, +$22.80. n = 5.
- First 30 minutes of the session: 5 trades, 5 wins, +$13.05. n = 5.

**Part 4 below therefore does not re-tune entry scoring. It makes entry
measurable.** Re-tuning scoring on 37 trades would be fitting noise, and
we would not be able to tell afterwards whether it helped.

---

## 1. Measurement defects that must be fixed first

Each of these makes a number in the report or the database wrong today.
None is optional, because Phase 9's whole premise is measuring exit
quality, and these are the instruments.

### 1.1 `best_exit_price` is corrupted by splits inside the hold window

**CORRECTED 2026-09-15.** The first draft of this section said the fix
was to request split-adjusted bars (`adjustment=all`). That was wrong.
`fetchSellTimingBars` has requested `adjustment: 'all'` since
2026-09-01, before this spec was written. Claude Code checked the code
and pulled MSTU's real bars rather than accepting the framing, and the
corrected diagnosis below is its work, not mine.

`MSTU`: buy $1.88, recorded `best_exit_price` **$31.19**, a reported
optimal gain of **+1559%**. `price_at_plus5_days` carries the same
corruption ($29.18). MSTU ran a **reverse split** inside the hold window
— raw close $2.73 on 2026-08-21, $28.86 on 2026-08-24, a ~10.6× jump.

The real defect is a units mismatch that **no fetch parameter can fix**:

- `best_exit_price` comes from bars, expressed in *today's* share count.
- `buy_price` / `sell_price` are raw dollars Roman actually paid,
  pre-split, and are never touched by any adjustment.

Comparing them divides by a share count that changed mid-window. Raw
bars do not fix it either: raw post-split bars are ~10.6× the pre-split
price for the same reason. The share count moved, so both series are
right and the comparison is meaningless.

This is the cause of the implausible sell-timing figures flagged earlier
(+127.4%, 136.6%, 92.0%): one row is poisoning every average that
includes it.

**Fix:** do not try to reconstruct a "corrected" number. Detect the
corporate action and refuse to produce a figure.

#### 1.1.1 The guard alone is not sufficient — detect the split directly

A ±100% / −80% plausibility guard catches MSTU, because a reverse split
throws the number wildly out of range. It does **not** catch a forward
split, and that is the case that will bite silently:

| Split in window | Bars used | Apparent "best exit" | Guard verdict |
|---|---|---|---|
| Reverse 1:10 | either | +1559% | caught |
| **Forward 2:1** | adjusted | **≈ −50%** | **passes** |
| **Forward 2:1** | raw | **≈ 0%** | **passes** |

A −50% best exit on a stock Roman sold for a small gain reads as a
plausible bad trade. It would go into the report, into the exit-quality
scoreboard (§3.6), and into the training data for Model A and Model B,
and nothing would ever flag it. That is strictly worse than the MSTU row,
which at least announces itself.

**So the filler must detect the corporate action, not infer it from the
size of the answer.** Fetch the window **twice** — once with
`adjustment=all`, once with `adjustment=raw` — and compare bar for bar.
Absent a corporate action the two series are identical. Any bar where
`raw / adjusted` deviates from 1.0 by more than a small epsilon means a
split or dividend adjustment landed inside the window.

This costs one extra Alpaca call per resolved trade (well inside the
free tier's 200 req/min), needs no corporate-actions endpoint, and is
exact rather than threshold-tuned. When it trips, write
`best_exit_price`, `best_exit_date` and `price_at_plus5_days` as NULL
with `best_exit_timing = 'SPLIT_IN_WINDOW'`.

Keep the ±100% / −80% plausibility guard as well, writing
`best_exit_timing = 'DATA_ERROR'`. The two catch different things: the
ratio check catches corporate actions, the guard catches everything else
that can make a number absurd. A wrong number is worse than a missing
one; the three-state discipline applies here exactly as everywhere else
— `resolved` / `data_error` / `not_checked`, and never a zero or a
plausible-looking guess standing in for an unknown.

**Acceptance test:** re-select MSTU from the database after the run.
`best_exit_price` is NULL and `best_exit_timing` is `'SPLIT_IN_WINDOW'`.
Then construct a synthetic forward-split fixture (a symbol whose raw and
adjusted series differ by 2× across one boundary) and assert the same
outcome — the reverse-split case passing proves only that the loud
failure is caught.

### 1.2 Sell-timing columns have had no writer since cutover

`writeSellTimingToSupabase` is `return;` (disabled). `fill-outcomes.mjs`
fills `signal_log`, not `trades_v2`. Sixteen of the 37 rows in the old
table are unresolved, and **every trade from 2026-08-28 onward is
unresolved** — the entire recent record.

The consequence: **the app currently has no working measurement of
whether any exit was good.** That is the feedback loop Phase 9 depends
on.

**Fix:** extend `fill-outcomes.mjs` to fill `trades_v2`'s
`sell_timing_resolved`, `best_exit_price`, `best_exit_date`,
`best_exit_timing`, `price_at_plus5_days`, under the existing
`outcome_filler` role. Requires a new UPDATE policy + column grant for
that role on `trades_v2` (see §5 DDL).

**Acceptance test:** run the filler, then **re-select the rows from the
database** and assert non-null. Not a log line, not a status code —
PostgREST returns 200 with an empty body on an RLS-filtered update, which
is exactly how this class of bug has hidden four times already in this
project.

### 1.3 `buy_session` has only two values and one is wrong

```js
buySession: isPreMarketHours() ? 'PRE_MARKET' : 'REGULAR'   // app.js:3572
```

There is no `AFTER_HOURS` branch. All 37 trades are labelled `REGULAR`,
including ten bought after the close and one at 7:47pm ET. The report's
"Regular session entries" block (app.js:6001, 6800) is therefore
comparing 37 trades against 0 trades and printing the result as if it
meant something.

**Fix:** four values — `PRE_MARKET`, `REGULAR`, `AFTER_HOURS`, `CLOSED` —
derived from the market calendar the app already consults (Alpaca
`/v2/clock` / `core/clock.js`), not from a local-clock guess. Backfill
all existing rows from `buy_time` + `buy_date`.

**Acceptance test:** after backfill, `select buy_session, count(*) from
trades_v2 group by 1` returns at least two distinct non-null values, and
TENX/KEEL/NEOG specifically come back `AFTER_HOURS`.

### 1.4 `peak_price` is "whatever Roman happened to look at"

```js
if (!priceFetchFailed && currentPrice > (p.peakPrice || 0)) {   // app.js:3757
  p.peakPrice = currentPrice;
```

This runs **only when the portfolio tab renders**. The trailing stop
(`peakPrice * 0.85`), the pullback factors, and the whole peak-risk
scorer are computed off a number that reflects Roman's browsing habits
rather than the stock's price. A position that doubled and collapsed
overnight has a peak equal to whatever it was worth the last time he
opened the app.

Fixed by §2. Until §2 exists, no peak-derived figure in the report should
be presented without a caveat.

### 1.5 The backup job protects the dead table

`scripts/backup-tables.mjs` backs up `trades`, `portfolio`, `settings`,
`rating_snapshots`. It does **not** back up `trades_v2` or `signal_log` —
the two tables Phase 7 created and the ones everything now writes to.
Every trade since cutover is unbacked.

**Fix:** add `trades_v2` and `signal_log` to `TABLE_RULES` with
never-shrink rules (same posture as `trades`). Add `position_bars` when
§2 lands, with a grow-only rule.

---

## 2. Position price history — the primitive both exit features need

Neither 2(a) nor 2(b) is computable today, for the same reason: **the app
has no record of what a held position's price did while Roman wasn't
looking at it.**

`rating_snapshots` is not that record. 1,406 rows across 389 tickers,
**median one snapshot per ticker per day**, captured only when the app
renders. TENX was held for nine days and has one snapshot inside the
window.

"Tell me how long to hold before it starts falling" requires knowing that
it is falling. "Will it come back in two days" requires knowing where it
has been. Both need a price series that exists whether or not the browser
is open.

### 2.0 Superseded 2026-09-15: no capture needed, verified not reasoned

The premise above — "the app has no record of what a held position's
price did while Roman wasn't looking" — assumed the past is
unrecoverable, so something had to be watching continuously. Checked
directly rather than argued: if Alpaca's minute bars for an arbitrary
past window are retrievable **on demand**, the app can compute a
position's whole intraday path — peak, time of peak, volume profile,
distance from high — **at render time**, from history alone plus the
live snapshot for right now. Nothing needed to have been watching.

**Verified, not assumed, 2026-09-15** (`scripts/probe-minute-bar-retention.mjs`):

1. **60+ days back, retrievable.** BITO minute bars from 2026-07-17 (59
   days before the test): 298 real bars on `feed=iex`, 513 on
   `feed=sip` for the identical window — SIP is denser (the consolidated
   tape vs. one venue), both retrievable.
2. **Weekend/holiday boundary, correct.** A window spanning Fri
   2026-09-04 → Mon 2026-09-07 (Labor Day) returned bars for Friday only
   — zero for the entire holiday weekend, no error, no synthesized data.
   **Thin volume, real gaps, never interpolated.** DAMD (real, active,
   low-priced): 315/390 possible minutes filled (80.8%), largest gap 8
   minutes. DJT: 386/390 (99.0%), largest gap 3 minutes. Absent minutes
   are absent rows, exactly the discipline this project already applies
   elsewhere (§3.1.1's day-of-hold gap, `scan_runs`' closed marker) —
   just never needing a marker here, because a missing bar and a
   missing capture look identical and neither needs distinguishing at
   render time (there's nothing to distinguish a render-time query FROM).
3. **Recency embargo, measured precisely.** `feed=sip`: 403 at 14
   minutes old, 200 at 15 — an exact boundary, matching (and slightly
   sharper than) `core/universe.js`'s existing `PREMARKET_BAR_DELAY_MIN`
   constant (16, found live 2026-08-24, already carrying a 1-minute
   buffer over this same line). `feed=iex`: **no embargo at all** — 200
   even at 1 minute old. Render-time path: SIP for anything ≥15 minutes
   old (denser), IEX for the last 15 minutes, the live snapshot for the
   current instant.
4. **Cost per render.** One multi-symbol request, 5 symbols: 1-day
   window = 2,708 bars/183ms/1 page; 5-day = 5,304/176ms/1 page; 20-day
   = 10,000 (hits the page ceiling, needs a 2nd page). Roman's real
   holds are almost all 1–7 trading days (§3.9.1) — a real render costs
   1–2 Alpaca requests per position, trivial against 200 req/min even
   for a full portfolio tab.

**A fifth finding, not asked for, that changes the calculus on what's
lost by not storing:** `feed=sip` returns **zero** bars — daily or
minute — for RSLS across its entire history, including dates it
provably traded (the same dates `scripts/build-exit-model-dataset.mjs`
pulled real SIP rows from, hours earlier the same day). `feed=iex`, on
the identical symbol and dates, still returns 229 days of daily bars and
real minute bars (12 in one session, low-volume but genuine). SIP access
appears to depend on current listing status even for backdated queries;
IEX's historical data does not. **Practical consequence: use IEX, not
SIP, for anything that might later need to describe a delisted
symbol's past** — the render-time path already does, for the recency
reason above, so this falls out for free rather than needing a separate
rule.

**What's lost by not storing** (two named going in, a third found):

1. **A record of what the app actually showed at a past moment.**
   Real, unrecovered by this design. A render-time query answers "what
   does Alpaca's history say now," which is usually but not provably
   always identical to what an earlier render would have said — a
   corrected or backfilled bar would silently change the answer on
   replay. No dispute-resolution record exists either way without
   storing.
2. **Data for a symbol that later delists.** Weaker than assumed.
   Finding 5 shows the data does not simply vanish — it becomes
   unreachable via SIP specifically, while remaining reachable via IEX.
   The residual risk is narrower: IEX's OWN retention limit past the
   ~2-year window tested here is unverified, and this depends on the
   render path consistently choosing IEX over SIP for this reason,
   forever, not just today.
3. **Resilience to Alpaca being unreachable at the exact moment Roman
   opens the app.** Not raised by either named risk, but real: a stored
   history means a live-fetch failure degrades to "showing the last
   captured data" (the same posture `priceFetchFailed` already gives
   current price); a pure render-time design has nothing to fall back to
   for the whole peak/history feature in that window — the in-memory
   cache is session-scoped and doesn't survive a fresh load during an
   outage. Narrower blast radius than a scheduler drop (an outage is
   rare and typically short), but not zero.

**Decision: build the render-time derivation.** `position_bars` (§2.1),
its writer (§2.2), the scoped write role, and the migration that would
have created it (next free number, since `db/023` went to §2.7's
`workflow_runs` this same session, not to this) are dropped, not
deferred. §2.4's scheduler question stops blocking this track — nothing
here depends on a cron firing. §2.7's instrumentation stays: the other
five scheduled workflows still need it regardless of this decision.

§2.1–2.3 below are kept as the superseded design, not deleted — the
record of what was proposed and why it changed matters as much as the
change itself.

### 2.1 New table — SUPERSEDED by §2.0, kept for history

```sql
create table if not exists position_bars (
  id uuid primary key default gen_random_uuid(),
  position_id text not null,
  ticker text not null,
  captured_at timestamptz not null,
  session text not null
    check (session in ('PRE_MARKET','REGULAR','AFTER_HOURS','CLOSED')),
  price numeric not null,
  rsi numeric,
  volume_ratio numeric,
  is_daily_close boolean not null default false,
  source text not null,     -- 'alpaca_iex_minute' | 'alpaca_daily_close'
  created_at timestamptz not null default now(),
  unique (position_id, captured_at)
);
create index if not exists position_bars_pos_idx
  on position_bars (position_id, captured_at);
create index if not exists position_bars_daily_idx
  on position_bars (ticker, captured_at) where is_daily_close;
```

### 2.2 Writer — SUPERSEDED by §2.0, kept for history

A new scheduled workflow, `capture-position-bars.yml`, patterned on
`capture-movers-snapshot.yml` — which already solved this exact set of
problems and should be copied rather than re-derived:

- **Oversample and filter.** GitHub Actions cron delivered all six
  firings 2h22m–3h27m late on 2026-09-11. Fire every 15 minutes; the
  script checks the real `/v2/clock` and decides whether it is inside the
  target window. Never trust the cron to have fired when it said.
  **See §2.4 — as of 2026-09-14 oversampling is no longer sufficient on
  its own, and the scheduler choice is now an open question.**
- **DST.** Market open is 13:30 UTC in EDT and 14:30 UTC in EST. Use the
  clock endpoint, not a fixed UTC offset.
- **Market-closed is a row, not a gap.** A weekend or holiday firing
  writes a self-marked marker. A gap in the series must never be
  ambiguous between "didn't run" and "market was shut" — the same rule
  that already governs the movers log.
- **Writes under a scoped role**, not `anon`. Reuse `outcome_filler` or
  add a sibling; `anon` must not gain INSERT on this table.
- Capture every open position in `portfolio`, plus one `is_daily_close`
  row per position per session at the close.

Alpaca free tier: 200 req/min, no documented daily cap. At five open
positions and 26 firings a day this is ~130 requests/day. Well inside
free.

### 2.3 `peak_price` becomes derived — SUPERSEDED by §2.0, kept for history

Once `position_bars` exists, peak price for a position is
`max(price)` over its bars, not a mutable field updated on render. Keep
writing `peak_price` to `portfolio` for continuity, but compute it from
bars. **State plainly in the report that peak figures for trades closed
before this job started are render-sampled and not comparable.** Do not
average the two together.

---

### 2.4 The scheduler is now a Phase 9 blocker (added 2026-09-14)

**No longer blocks position display — see §2.0 (2026-09-15).** The
investigation below is unchanged and still governs the other five
scheduled workflows (§2.7's instrumentation exists because of it); it
stopped being a gate for THIS track specifically once §2.0 established
that position history doesn't need a cron to have fired at all.

On 2026-09-14 the signal-logging pipeline produced **nothing** — zero
`scan_runs` rows for the entire trading day. Both workflows reported
success. Investigation (Claude Code, 2026-09-15):

- `log-signals-edge`: six firings, every one delivered **2h51m–4h55m
  late**, delay shrinking through the day — the signature of a queue
  draining, not a clock drifting. Every firing missed both halves of its
  DST-paired cron and correctly self-diagnosed as a no-op.
- `log-signals-warrior`: cron fires every 15 minutes, ~32 firings
  expected. **Two appeared in the run history for the whole day.** Not 32
  late ones. Thirty were never delivered at all.

The no-op guards behaved correctly and no bad data was written. That is
the good news and it is also the problem: **a day that produced nothing
is indistinguishable from a quiet market**, and this one went unnoticed
until it was looked for by hand.

**Why this changes §2.2.** Oversampling defends against *lateness*. It
does not defend against *non-delivery*. At a ~94% drop rate, firing every
15 minutes yields two samples a day, and `position_bars` — the primitive
both exit models depend on — would have holes precisely on the volatile
days when a position moves. A model trained on a series with
load-correlated gaps is worse than no model, because the gaps are not
random.

GitHub's own documentation states that scheduled workflows may be delayed
or dropped under high load. This is documented behaviour, not an outage,
so it will recur.

**Options, all free, none yet chosen:**

1. **Supabase `pg_cron` + `pg_net`** — both on the free tier, both
   already in this stack. Runs on a real scheduler inside the database.
   Database writes need no PostgREST round trip and no JWT at all, which
   also removes the credential-handling problem in §2.5. `pg_net` handles
   the Alpaca fetches. Most likely answer.
2. **Cloudflare Workers cron triggers** — free tier, reliable delivery,
   but a second platform to operate.
3. **Keep GitHub Actions and accept the gaps** — only defensible if
   coverage detection (below) is in place and the gaps prove rare in
   practice. Monday says they are not rare.

**Coverage detection, which is needed regardless of which is chosen.**
The subtle part: an alarm that runs on the same unreliable scheduler can
itself be dropped, so a missed day and a missed alarm look identical
again. The alarm must not depend on the thing it is watching.

The cheapest correct answer is **pull-based, in the app**: on load, check
`scan_runs` for the last N trading days and show a banner naming any day
with no row. Roman opens the app on days he trades, so the check runs
when it matters, costs one query, and cannot be dropped by a scheduler.

### 2.5 The outcome filler has no production run path

`fill-outcomes.mjs` is referenced by **no workflow**
(`.github/workflows/` contains backup-tables, build-float-table,
capture-movers-snapshot, log-signals-edge, log-signals-warrior — and
nothing else), and `OUTCOME_FILLER_JWT` appears in no workflow file. The
33 `signal_log` rows carrying `ret_1d` were filled by a hand-run.

So outcome data accumulates only when someone remembers to run a script.
Phase 9's model training (§3.1), its scoreboard (§3.6), and the entire
exit-quality feedback loop assume outcomes fill continuously.

**Build `fill-outcomes.yml` with `workflow_dispatch` plus a daily
schedule**, with `OUTCOME_FILLER_JWT` as a repository secret. This is
also the right way to run the one-off verification steps: dispatch the
workflow rather than handing the token to a local shell. The credential
stays where it belongs, the verification runs in the exact environment
production will use, and the missing production path gets built as a side
effect of testing.

## 2.6 Build order correction: Section 3 does not depend on Section 2

Added 2026-09-15, after Section 1 closed. **Superseded twice since:**
§3.9 rejected both models this section was arguing for build order on;
§2.0 found the position-history primitive itself doesn't need
`position_bars` or a scheduler at all. Kept for the reasoning shape
(build order follows data dependency, not document order), not for its
conclusions about what to build.

The original plan read as a sequence: Section 1, then 2, then 3. §2.4's
scheduler problem therefore looked like it blocked everything. It does
not, and the distinction is worth stating precisely because it decides
what gets built next.

**`position_bars` is needed to render a live exit call.** It answers
"what is this position doing right now, while Roman isn't looking."

**The models in §3.1–§3.3 are built offline from historical daily bars.**
They need two years of Alpaca history for the eligible universe and no
scheduler at all. A backtest harness already exists in
`scripts/replay-scan.mjs` and `scripts/run-symbol-day-scan.mjs`.

So the dependency is one-directional and late: the models can be built,
validated and committed as lookup tables **before** `position_bars`
exists. What they cannot do without it is fire on a live position
between sessions.

**Revised order:**

1. §3.1 dataset + §3.2/§3.3 model tables — starts now, blocked on
   nothing. This is the work Roman actually asked for.
2. §3.4's hard −6% floor — also starts now. It needs only the current
   price the app already fetches on render, and it is the single
   highest-leverage change in Phase 9 (§0.3).
3. Scheduler instrumentation (below) — in parallel, cheap.
4. §2 `position_bars` — once the scheduler question has an evidence-based
   answer.

### 2.7 Instrument the scheduler before replacing it

2026-09-14 is one day of evidence. It is a bad day, but switching
platforms on a single observation is the same mistake as tuning entry
scoring on 37 trades.

There is already a signal in that one day worth testing: the **dense**
every-15-minute cron lost ~94% of its firings, while the **sparse**
six-times-daily cron delivered all six, merely late. If GitHub
deprioritises dense schedules, the fix may be schedule shape rather than
a new platform — which would cost nothing.

**Log every firing, including no-ops.** Today a workflow that fires and
correctly declines to act leaves no trace, so delivery rate is
unmeasurable. A `workflow_runs` row per firing — workflow name, declared
cron time, actual fire time, delivered-vs-dropped inferred from the gaps,
and the no-op reason — turns "GitHub is unreliable" from an impression
into a number.

After a week there is a real delivery rate per schedule density, and the
platform question answers itself. Candidates if the answer is bad:
Cloudflare Workers cron (free, runs the existing JS, reliable delivery)
or Supabase `pg_cron` + `pg_net` (free, already in the stack, but a poor
fit for anything needing indicator computation — PL/pgSQL is the wrong
tool for RSI).

## 3. Exit engine v3

Roman said this can be rewritten from scratch. It should be. The current
engine is twelve hand-tuned factor weights that have never been validated
against an outcome, calibrated for a price regime he does not trade in.

The replacement is not more rules. It is **measured base rates**, with
the sample size shown.

### 3.1 The dataset

Build offline, committed to the repo as JSON — the same pattern as
`data/float-table.json`, which already solved the "browser can't do this,
so a scheduled job does it and commits the answer" problem.

Source: Alpaca daily bars, `adjustment=all`, two years, for the
**instrument-eligible universe as of each historical date** — not today's
symbol list. `scripts/probe-survivorship-bias.mjs` already exists;
whatever it concluded governs here. A model built on "symbols that still
exist in 2026" will look excellent and be worthless, because it will
never have seen a stock that went to zero, which is precisely the case
the cut-losses feature is for.

Restrict to Roman's actual trading population: price $1–$20 (Ross
Cameron's published band, which is thesis, not an implementation
artifact), and the same instrument-type filter the live universe uses.

For each (symbol, entry_day) pair, simulate a hold and record, for each
subsequent session D = 1…7:
- return from entry
- drawdown from entry
- RSI(14), volume ratio vs 20-day average, % from 20-day MA
- whether that session made a lower low than the prior session
- the eventual maximum close within the 7-session window, and which day
  it fell on

### 3.1.1 The 1.28M rows are not 1.28M observations

Added 2026-09-15, on reading the built dataset's shape: 1,282,479 rows,
3,930 distinct symbols, 2024-10-14 → 2026-09-03 (~480 trading days).

That is ~326 entry-days per symbol, i.e. an entry on very nearly every
session. Consecutive entries for the same symbol carry **7-day forward
windows that overlap by six of seven sessions**. Two rows one day apart
are not two observations of anything; they are one price path counted
twice, minus a day.

Worse, symbols move together. A market-wide selloff generates thousands
of rows landing in the same drawdown cell on the same three dates, all
driven by one event.

So the effective sample size is smaller than the row count by a large and
unknown factor. A naive count of 412 rows in a cell could be 8 symbols
across 3 dates during a single selloff — an honest n of roughly 3.

**This matters because §3.7 promises the user a sample size.** "412
similar cases" invites Roman to treat it as 412 independent pieces of
evidence. If it isn't, the number is a lie told with a straight face —
worse than showing nothing, because it manufactures confidence.

**Rules:**

1. Every cell stores `n_rows`, `n_symbols`, `n_dates` — all three.
2. The minimum is on all three (§3.2): 100 rows, 30 symbols, 20 dates. A
   cell failing any one is `NOT_EVALUATED`, however many rows it has.
3. **The UI shows the distinct-symbol count, not the row count.** "31% of
   the time, across 84 different stocks" is a claim that survives
   scrutiny. "412 cases" is not.
4. Report the per-cell concentration: if the top date contributes more
   than ~20% of a cell's rows, that cell is one event wearing a
   distribution's clothes, and it says so.

### 3.1.2 Two validity questions the shape does not settle

**Population mismatch.** The dataset is every symbol-day in the $1–$20
band. Roman's trades are signals that survived EDGE/Warrior scoring — top
movers with elevated RVOL, a small and heavily selected subset. The base
rate for "a random $1–$20 stock, down 4%, day 2" is not obviously the
base rate for "an EDGE-qualified momentum name, down 4%, day 2." They may
differ in either direction.

This is testable rather than arguable: build the tables twice, once on
the full band and once on entry-days that pass a momentum precondition
(entry-day volume ratio and price move resembling the live scan's own
thresholds), and compare the cells. If they agree, the full-band version
is fine and has more data. If they diverge, the full-band version is
measuring the wrong population and would be confidently wrong.

**Regime confounding.** Two years is one market. If the window contains a
sustained rally, "recovers within 2 days" encodes that rally, and the
model will keep asserting it after the regime changes.

The honest check is free: **fit on 2024-10 → 2025-09, validate on
2025-10 → 2026-09.** Compare `p_recover` per cell across the two halves.
If a cell swings from 45% to 20%, that cell is measuring the market, not
the setup, and must not ship as a stable probability. Out-of-sample
agreement is the only evidence that any of this generalises, and it costs
one extra pass over data already on disk.

### 3.1.3 What the built dataset settled, and what it changed

Results in 2026-09-15, against the 1.28M-row build.

**Overlap inflation: not a problem here.** 216 of 288 cells clear all
three minimums; **zero** cells have rows but fail the symbol or date
bars, and no passing cell draws more than 20% of its rows from one date.
The §3.1.1 worry was real and worth checking; the data says this grid
does not suffer from it. The three-part minimum stays in place as a
guard, not because it is currently binding.

**Regime stability: good, within limits.** Fit 2024-10→2025-09, validate
2025-10→2026-09: median |Δp_recover| 1.3pp, mean 1.7pp, max 12.0pp. That
is tight. It demonstrates stability across two adjacent years of one
broad regime — it does not demonstrate survival of a regime *change*, and
must not be described as if it did.

**Day 0 is structurally empty, and that is 35% of Roman's trades.** All
72 empty cells are the day-of-hold=0 bucket. Entry-day return is 0 by
construction in a daily-bar dataset, so "down X% on day 0" is
unrepresentable without intraday bars. Thirteen of Roman's 37 closed
trades were same-day.

Consequence, stated rather than papered over: **for a position bought
today, Model A and Model B have nothing to say.** The cell returns
`NOT_EVALUATED`, the UI says so in words, and the only protection in
force is §3.4's −6% floor. Do not substitute the day-1 cell as a proxy —
that is precisely the quiet substitution §3.7 forbids.

**Survivorship is decorative, and it biases the model in the dangerous
direction.** Only **15 genuinely delisted symbols** (0.4% of 3,930)
contributed rows. The other 72 apparent contributors were **ticker reuse**
— 92 symbols appear on both Alpaca's active and inactive asset lists
because a failed company's ticker was later reassigned, and bar requests
are keyed by symbol string rather than asset ID, so those fetches
returned the *surviving* company's continuous history. Found by noticing
that 3,915 active + 87 inactive ≠ 3,930 distinct.

This is not fixable with free data: Alpaca's history for delisted
symbols largely disappears with the listing. So the honest statement is
that **the model has barely seen a stock go to zero**, and its recovery
probabilities are therefore optimistic exactly in the tail the
cut-losses feature exists to catch.

**Architectural consequence:** this is the reason §3.4's −6% floor
overrides the model rather than advising it. The model's blind spot is
the catastrophic case; the floor is blind to nothing because it does not
predict. A model that has never seen TENX go to zero must never be able
to talk Roman out of the floor. Wire it so the model can return HOLD only
for positions already above the floor — not as a policy choice, as a
structural one.

### 3.1.4 Entry-day momentum is a dimension, not a filter

The population check (Task 4) found a real divergence: full-band 44.4%
vs momentum-restricted 61.1% at −4% drawdown / day 3+ / RSI<30 /
vol>1.5×, a 16.7pp disagreement, with momentum names recovering *more*
often. Only 10.12% of rows pass the precondition (volRatio ≥ 1.0 and
entry-day move ≥ 2.0%).

The obvious move is to adopt the momentum-restricted table, since Roman
trades momentum names. **Checked against his actual trades, that is
wrong.** Of his 37 closed trades, **19 have `volume_ratio_at_buy` below
1.0** — more than half would fail the precondition. So would two of the
three trades that constitute his entire loss (BTDR −$20.40 at 0.54,
PGEN −$16.50 at 0.33).

Neither table describes him. His entries are genuinely heterogeneous:
some are volume-driven momentum, some are quiet.

**So entry-day momentum becomes a fifth conditioning dimension rather
than a filter on the population.** Both branches populate — ~130k rows
on the momentum side (214/288 cells), ~1.15M on the other — so the grid
can carry the split. Each live position is then scored against the cell
matching the kind of entry it actually was.

This is the same rule this project keeps rediscovering: when two things
differ, model them separately rather than collapsing them and picking a
winner. `engine_source` vs `source` was the same call.

### 3.2 Model A — "will it come back?" (Roman's 2b)

**Question:** I am down X% on day D. Does it return to break-even within
2 sessions?

Conditioning variables (coarse deliberately — cells must be populated):
- drawdown band: −2/−4/−6/−8/−10/worse
- day of hold: 0, 1, 2, 3+
- RSI band: <30, 30–45, 45–60, >60
- volume ratio band: <0.75, 0.75–1.5, >1.5

Each cell stores `{n, p_recover_2d, median_return_2d, p_worse_2d}`.

**Minimum cell size: n ≥ 100 rows AND ≥ 30 distinct symbols AND ≥ 20
distinct dates** (revised 2026-09-15, see §3.1.1 — a raw row count is not
a sample size in this dataset). Below that, fall back to the parent cell
(drop the volume dimension, then RSI). If the parent is still thin, the
cell returns `NOT_EVALUATED` and the UI says so. Three-state discipline:
`pass` / `fail` / `not-checked`, and a thin cell is `not-checked`, never
a guess dressed as a number.

**Output to the user — this is the "be clear" part Roman asked for:**

> **CUT — TENX, down 6.2%, day 2**
> Stocks in this state recovered to break-even within 2 days **31% of the
> time** (412 similar cases).
> Typical outcome 2 days from here: **−1.8%**.
> Your hard cut is −6%. You are past it.

A number, a sample size, a direction, and the reason. No composite score,
no factor list, no arithmetic the user has to do.

### 3.3 Model B — "how long do I hold?" (Roman's 2a)

**Question:** I am up X% on day D. Is the peak in?

Same dataset, same conditioning, different target. Each cell stores
`{n, p_peak_already_in, p_higher_close_tomorrow,
median_additional_gain_1d, median_giveback_to_day7}`.

`p_peak_already_in` is the fraction of similar cases where today's close
was the highest close of the remaining window. That is, literally, "how
long to hold before it starts falling."

**Output:**

> **SELL INTO STRENGTH TODAY — CPRI, up 3.3%, day 1**
> From here, **58%** of similar setups closed *lower* tomorrow (380
> cases). Median gain from holding one more day: **−0.4%**.
> Holding to day 7 gave back a median **−2.1%** from today's price.

versus:

> **HOLD — BBAI, up 3.9%, day 1**
> **64%** closed higher tomorrow (297 cases). Median additional gain:
> **+1.2%**. Peak typically lands on day 3.

### 3.4 The hard floor

Evaluated before anything else, exactly as the current stop-loss hard
floor is, and it overrides both models:

1. `pnlPct <= -MAX_LOSS_PCT` (**−6%**, Roman's choice) → **CUT NOW**,
   unconditional. The model does not get a vote. This is the single
   highest-leverage change in Phase 9 (§0.3).
2. `price <= position.stop` → CUT NOW (existing behaviour, retained).

The −6% floor supersedes the entire existing loss-factor ladder (−8% /
−20%), which never fires in time. Delete it rather than leaving two
loss mechanisms disagreeing.

### 3.5 What gets deleted

- The duration free-points block (+20 "within window", +10 "early"). It
  makes HOLD STRONG the default (§0.1). Time-in-trade enters through
  `day of hold` as a model dimension instead, where it is measured rather
  than assumed to be good.
- Momentum protection at +20% and the peak × 0.85 trailing stop. Zero
  fires in 37 trades; the arming threshold is 5× Roman's best result
  ever. If a trailing stop is wanted, derive the distance from the
  measured give-back distribution (§3.3's `median_giveback_to_day7`), not
  from a round number.
- The −8% / −20% loss ladder, replaced by §3.4.

### 3.6 The scoreboard — non-negotiable

Replacing twelve unvalidated weights with a lookup table that *looks*
more rigorous is worth nothing unless we can tell whether it worked.

Every time the engine renders a call, log it: `exit_calls` row with
position_id, timestamp, model cell used, `n`, the call (CUT / SELL INTO
STRENGTH / HOLD), the probability shown, and the price at the time.
`fill-outcomes.mjs` fills in what actually happened 1, 2 and 5 sessions
later.

Then the report answers one question directly: **when the model said CUT,
how often was cutting right?** If that number is not above chance after
three months, the model is wrong and we will know, rather than
discovering it through another −$56 trade.

This is the same failure the sell-warning compliance section already
demonstrates: it prints 0/0/0 while trades record "HOLDING", because it
measures nothing. Do not build a second one.

### 3.7 Honesty constraints on the UI

- Always show `n`. A probability without a sample size is a bluff.
- Never show a cell below the minimum without the `NOT_EVALUATED` label.
- The call is a historical base rate, not a prediction, and the copy must
  not imply otherwise. "31% of similar cases recovered" is honest.
  "31% chance of recovery" is not.

---

## 3.9 Verdict on the model track, and what replaces it

Written 2026-09-15, after both models were built, tested and rejected.

**Neither model ships.** Model A (§3.2) adds one trading day of warning on
1 of 12 losers over what §3.4's floor already does. Model B (§3.3)
returned "hold" on 10 of 10 evaluable sell days — 3 right, 6 wrong, which
is what an always-hold default produces. `p_higher_close_tomorrow` is
noise (IQR 42–46%). The tables stay in the repo as evidence; nothing is
wired.

The work was not wasted: it produced a defensible reason not to ship a
plausible-looking feature, which is cheaper than discovering the same
thing from live trades three months out.

### 3.9.1 One cause, stated once so it is not rediscovered

**Roman's trades resolve faster than daily bars can describe.** 13 of 37
closed same-day; 25 of 37 closed within one day of entry. Day-0 state is
unrepresentable in any daily-bar dataset — entry-day return is 0 by
construction — so two years of history and twenty behave identically
there.

Every failure above reduces to this. It is a property of the data source,
not of the modelling, and no additional daily history changes it.

A second face of the same limit showed up in the winner replay: 6 of 25
sell days were dropped because the day's *close* disagreed with Roman's
intraday *fill*. The model's unit of time and his unit of decision are
different things.

### 3.9.2 The pivot: information, not prediction

His book is now well characterised. Wins average +1.5% and cap at +3.9%.
Losses ran to −24% before the floor existed. The floor fixes the loss
tail — on his 37 trades it moves −$73.73 to −$3.16. **What remains is
that his wins are too small**, and the resolved sell-timing data says the
moves were there: BITO +25.8% available against +0.93% taken, AMC +11.3%
against +0.81%, RR +19.2pp.

The instinct was to answer "how long do I hold?" with a probability. Two
attempts say that is not available from this data. The alternative is
cheaper and more honest: **show him what the position is actually doing,
and let him decide.** Not "58% chance the peak is in" — instead "up 2.1%
now, high of 3.4% at 10:40, volume fading since 11:15."

Facts have no blind spot to disclose, no cell population to defend and no
regime to survive. And this is a trade journal, not an execution system;
the decision is his, so the useful thing to give him is sight, not a
verdict.

### 3.9.3 Consequence for the build order

§2's `position_bars` was scoped as infrastructure for the models and
deferred in §2.6. **It is now the deliverable itself**, and it requires
intraday capture — which makes §2.4's scheduler question the real gate
again, this time for a reason that earns it.

Revised remaining plan:

1. **Settle the scheduler** (§2.7 instrumentation, then choose). Blocking.
2. **`position_bars` at intraday resolution** — the live picture of a
   held position, filled whether or not the app is open.
3. **A peak/give-back display**, not a recommendation: today's high, the
   distance from it, where volume went. The one number from the model
   work worth keeping is `median_giveback_to_day7`, shown as history
   rather than forecast.
4. **Let the counterfactual columns accumulate.** `price_at_plus1_day` /
   `plus2_days` / `plus5_days` are now being filled for every trade.
   Within a few months they answer "does Roman sell too early" from his
   own live trades, at a resolution no universe backtest could reach.

**Intraday modelling is not ruled out** — Alpaca's free IEX minute bars
could represent day 0 — but it is a much larger build, and it should not
start until the position display has shown whether sight alone closes
the gap. That is the cheaper experiment and it runs first.

## 4. Entry

### 4.1 After-hours warning at the point of purchase

When `buy_session` resolves to `AFTER_HOURS` or `PRE_MARKET` at the
moment of the buy, the confirm dialog shows:

> **After-hours entry.** Your three worst trades were all bought after
> the close (TENX −24%, KEEL −16%, NEOG −4%). Seven of your ten
> after-hours buys were fine — but the spread is wide, the book is thin,
> and you cannot act on a gap before the open.

Warn, do not block. n = 10 does not justify a block, and Roman's stated
risk appetite is medium-to-high.

### 4.2 Make entry measurable

Record, at buy, the fields that would let this question be answered at
n = 150 that cannot be answered at n = 37:

- `spread_at_buy` (bid/ask at the moment of purchase — the direct measure
  of the after-hours execution cost that §0.4 can only infer)
- `minutes_from_open` (signed; negative pre-market, > 390 after-hours)
- `bars_since_signal` (how stale the signal was when acted on)
- `entry_vs_signal_price_pct` (slippage from the signal's price to the
  fill — currently invisible)

All four are nullable, three-state, and none is used to score anything
yet. They exist so that in three months there is something to analyse.

### 4.3 Explicitly not doing

**No re-tuning of entry scoring weights in Phase 9.** §0.5 gives the
reason: at 37 trades, every entry bucket differences is inside the noise
generated by three trades. The score-inversion hypothesis is real and
worth testing, and testing it requires the signal log's forward test to
accumulate, not a code change now.

---

## 5. DDL and sequencing

Order matters; each step must round-trip before the next starts.

Renumbered 2026-09-15 to match Section 1's build order — the
`outcome_filler` widening is needed first, since §1.2 is the first thing
being built.

1. `019_trades_v2_outcome_grants.sql` — UPDATE policy + column-level
   grant for `outcome_filler` on the five sell-timing columns. **`revoke`
   before the narrowing `grant`**, as in `005`. `db/017`'s own header
   already anticipated this file ("pass 2 … will widen this SAME role");
   follow what it describes rather than inventing a second role.
2. `020_backfill_buy_session.sql` — a data UPDATE, not DDL. Backfills
   `buy_session` on existing `trades_v2` rows from `buy_time` +
   `buy_date` using the same four-state classification the app will use
   going forward. Must produce the same answer as `classifySession()`; if
   the SQL and the JS can disagree, one of them is wrong and we will not
   find out which.
3. `021_position_bars.sql` — table + indexes + RLS (select for `anon`,
   insert for the scoped role, no update for anyone).
4. `022_entry_measurement.sql` — the four §4.2 columns on `portfolio` and
   `trades_v2`.
5. `023_exit_calls.sql` — the §3.6 scoreboard table.

**How these get applied:** by hand, pasted into the Supabase SQL editor,
same as every migration from `005` onward. No service-role key is
introduced to the repo or to any local environment — see §5.1.

### 5.1 Why no service-role key

`service_role` bypasses row-level security entirely. Phase 7 spent weeks
building fail-closed RLS, a narrowly-scoped `outcome_filler` role with
column-level grants, and the "no anon UPDATE" posture that closed a live
hole on the table recording Roman's money. A service-role key in
`.env.local` makes all of that decorative, because anything holding it
can do anything to any table regardless of policy.

It is also the exact failure this project has already had twice: the
Supabase JWT secret was exposed, and Roman's standing decision is not to
rotate it. Adding a strictly more powerful credential to the same repo
compounds a known-unrotated exposure rather than containing it.

Manual application through the SQL editor costs one paste per migration
and keeps the blast radius at zero. That is the right trade at this
scale.

Existing `004b` stays gated until the first real trade round-trips
through `trades_v2`. **`db/004_cutover_lock_trades_update.sql` is still
entirely commented out** — every line, including both statements. When
its time comes it must be uncommented, not merely run; run as-is it
reports "Success. No rows returned" and does nothing.

---

## 6. Acceptance tests

The standing rule, stated four times in this project because it has been
violated four times: **a value computed correctly and present in memory
is not a value that persists.** `engine_source`, `universe_rank`,
`request_count`, and the `signal_snapshot`/`exit_rule_id`/`minutes_late`
trio were each computed correctly and each silently dropped on the way to
the database.

Every acceptance test below is a **round trip re-selected from the
database**. Never a code read, never a UI display, never an HTTP status
code.

1. **position_bars populates.** After one trading day with ≥1 open
   position: `select count(*), count(distinct captured_at) from
   position_bars where ticker = '<held>'` returns ≥ 20 rows spanning the
   session, plus exactly one `is_daily_close = true` row.
2. **Market-closed is unambiguous.** After a weekend firing, a
   self-marked closed row exists for that timestamp.
3. **Sell timing fills.** Run the filler; re-select `trades_v2` rows sold
   ≥ 5 sessions ago; `sell_timing_resolved = true` and
   `best_exit_price is not null` for all of them.
4. **Splits cannot corrupt.** Re-select MSTU: `best_exit_price` is NULL
   and `best_exit_timing` is `'SPLIT_IN_WINDOW'`. Then the synthetic
   forward-split fixture from §1.1.1 returns the same — the reverse-split
   case alone proves only that the loud failure is caught.
5. **Session has more than one value.** `select buy_session, count(*)
   from trades_v2 group by 1` returns ≥ 2 non-null values; TENX, KEEL and
   NEOG each return `AFTER_HOURS`.
6. **The hard floor fires.** Construct a position at −6.1%; the rendered
   call is CUT NOW and the reason names the floor, not a composite.
7. **Thin cells are labelled, not guessed.** Construct a state with no
   populated cell; the UI shows `NOT_EVALUATED` and no probability.
8. **The scoreboard records.** After one rendered call, re-select
   `exit_calls`; the row carries the cell id, `n`, the call and the
   price.
9. **Backup covers the live tables.** After one run, `data/backups/`
   contains `trades_v2.json` and `signal_log.json` with row counts
   matching the database.

---

## 7. Open, not resolved here

- **Mobile viewport has never been verified.** `resize_window` reports
  success while `innerWidth` stays 1707px. This is a mobile website that
  has never been rendered at phone dimensions. It is not a Phase 9 item
  but it is the largest untested surface in the app.
- **Coverage tracking.** A day where the schedule underperforms produces
  no row and no signal; absence is indistinguishable from a quiet market.
  §2.2's market-closed-marker rule is the same idea and should be
  generalised.
- **Shared SIP clamp helper.** Three copies exist. §2 and §3.1 will each
  want one, and the fourth and fifth copies will drift.
- **Thanksgiving** is the first live test of the array-position holiday
  fix.
