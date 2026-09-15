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

### 2.1 New table

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

### 2.2 Writer

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

### 2.3 `peak_price` becomes derived

Once `position_bars` exists, peak price for a position is
`max(price)` over its bars, not a mutable field updated on render. Keep
writing `peak_price` to `portfolio` for continuity, but compute it from
bars. **State plainly in the report that peak figures for trades closed
before this job started are render-sampled and not comparable.** Do not
average the two together.

---

### 2.4 The scheduler is now a Phase 9 blocker (added 2026-09-14)

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

**Done:** `.github/workflows/fill-outcomes.yml` now exists (see its own
header). `OUTCOME_FILLER_JWT` was confirmed missing via `gh secret list`
earlier 2026-09-15, then added the same day (confirmed via a second `gh
secret list` and a real dispatch that used it successfully — see §6 test
3/4 results and the 019/021 grant checks below). Current token: minted
2026-09-15, expires **2027-09-15T17:27:14Z**. Renew by that date: re-run
`SUPABASE_JWT_SECRET=... node scripts/sign-supabase-role-jwt.mjs outcome_filler 365`
and update the secret.

Two older tokens are also still valid, neither is in the secret anymore:
db/017's original 365-day mint (2026-09-10, expires 2027-09-11) was
superseded by the 2026-09-15 one above, and before that, outcome_filler's
very first mint (also 2026-09-10) got the pre-fix
`sign-supabase-role-jwt.mjs` default of 3650 days by accident. Neither
can be revoked short of rotating the underlying Supabase project JWT
secret, which is not planned (see the standing JWT-exposure decision for
this project) — so if a copy of either survives anywhere, it remains a
valid `outcome_filler` bearer credential with UPDATE rights until its own
expiry (2027-09-11, or roughly 2036-09-07 for the accidental one), not
whichever token is in this workflow's secret today. Live risk, not
history.

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

### 3.2 Model A — "will it come back?" (Roman's 2b)

**Question:** I am down X% on day D. Does it return to break-even within
2 sessions?

Conditioning variables (coarse deliberately — cells must be populated):
- drawdown band: −2/−4/−6/−8/−10/worse
- day of hold: 0, 1, 2, 3+
- RSI band: <30, 30–45, 45–60, >60
- volume ratio band: <0.75, 0.75–1.5, >1.5

Each cell stores `{n, p_recover_2d, median_return_2d, p_worse_2d}`.

**Minimum cell size: n ≥ 100.** Below that, fall back to the parent cell
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
