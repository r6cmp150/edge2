# Phase 10 — entry timing: findings and spec

From the 2026-10-21 report (292 closed trades, 270 resolved). Goal
Roman set: **the stock should go up right after he buys**, instead of
stagnating or dropping.

All times Pacific. Market opens 6:30am PT, closes 1:00pm PT.

> **Read §7 before acting on §1–§4.** §7 (2026-10-21) withdraws §0(b),
> narrows §1 to an oversold floor, drops the Friday rule, moves the
> first-hour rule to 7:00–7:30, cuts §2/§4 to two neutralisations, and
> replaces §6's build order.

---

## 0. Read this first: what this data can and cannot answer

**The report has no post-entry price path.** Every outcome column is the
*realized trade result*, which is the entry and Roman's exit decision
blended together. So "did the stock go up right after I bought" is not
directly measurable in it.

Two things follow, and both matter.

**(a) The obvious subset analysis is invalid.** Restricting to trades
sold the same day looks wonderful — n=69 (regular session, bought before
10:00), **76.8% win, +0.87% avg**. Within it, nothing discriminates:
RSI <45 wins 76.5%, above-20-day-MA 75.8% vs not-above 77.8%. That is
not evidence that entries are fine. It is conditioning on the dependent
variable: a trade gets sold the same day *because* it went up. The
mirror image is the 2+ day holds — n=59, 32.2% win, **−$828** — which
are not caused by holding, they are the entries that failed immediately
and then got held in hope. **Hold length is a symptom of entry quality,
not a cause of outcome.**

**(b) What remains valid** is any measure computed over all 270 trades
without conditioning on hold or exit: win rate and average return by
entry feature. Exit behaviour is noise in those, not selection. Every
number below is computed that way.

**§5 is the fix for this gap and is the most important section here.**

---

## 1. The finding: RSI at purchase, mid-band

This is the only entry feature in the dataset with a large, robust edge.

| RSI at purchase | n | Win rate | Avg return | P&L |
|---|---|---|---|---|
| <35 | 51 | 54.9% | −1.07% | −$123 |
| **35–45** | **55** | **45.5%** | **−1.28%** | **−$250** |
| 45–50 | 22 | 68.2% | +1.16% | +$150 |
| **50–55** | **24** | **87.5%** | **+1.09%** | **+$107** |
| 55–65 | 46 | 58.7% | −0.95% | −$218 |
| 65+ | 17 | 52.9% | −0.71% | −$35 |

*(regular-session entries, n=215, to remove the Sunday/after-hours
confound)*

Across all 270: **RSI 45–55 → n=55, 72.7% win, +0.86% avg, +$242.**
The other 215 trades: 50.7% win, **−$926**.

### Why I believe it (four tests it survived)

1. **Drop the single largest winner** — the test that killed the −6%
   floor last month. +$242 → **+$112**. Still positive. Not one trade
   deep.
2. **Every calendar month, same sign.** Aug +$10 vs −$79 · Sep +$41 vs
   −$640 · Oct +$190 vs −$207. Win rate 83% / 68% / 78% inside the band
   against 68% / 43% / 56% outside it.
3. **Every price tier, same sign.** <$5: 69.6% vs 49.0% · $5–10: 64.3%
   vs 45.5% · $10+: 83.3% vs 60.4%. So this is not the price-tier effect
   wearing an RSI costume.
4. **Chronological split-half.** Fit nothing; just apply the band to the
   first 135 trades and then the last 135. First half 76.5% win / +$72,
   second half 83.9% / +$325. It works on data it wasn't chosen from.

### It is a plateau, not a spike

With the §3 exclusions applied, every band from 42–55 through 45–58
produces 80–87% win and +$288 to +$407, all surviving the drop-best-trade
test. Only when widened to 40–60 does it degrade (68.4%, +$114, and
−$17 once the best trade is removed).

**So the edge is in the shape of the RSI distribution, not in a magic
number.** Pick 45–58 and don't tune it further — tuning inside a plateau
is fitting noise.

---

## 2. The app's RSI component is inverted at the top

Current `RSI position` scoring:

```
<35 = 10 | 35-55 = 15 | 55-65 = 20 (labelled "best zone") | 65-75 = 0 | 75+ = -10
```

The zone receiving the **maximum** 20 points returned **−0.95%** and lost
$218. The zone receiving 15 contains the only profitable band. The
component is paying most for the entries that perform worst.

**Replace with:**

```
RSI < 35      :  −5   (was +10)  — 54.9% win, −1.07%
RSI 35–42     : −10   (was +15)  — the worst band in the book
RSI 42–45     :  +5
RSI 45–58     : +25   (was +15/+20) — the edge
RSI 58–65     :   0   (was +20)
RSI 65–75     :  −5   (was 0)
RSI 75+       : −10   (unchanged)
```

Note this inverts the sign on `RSI < 35`, which currently earns points.
41 trades bought under RSI 30 returned −2.10% and −$211. Deeply oversold
is not a discount, it is a falling knife — TENX (RSI 11.9, −24.0%) and
KEEL (RSI 19.9, −16.4%) are both in there.

---

## 3. Four hard exclusions

Each is a time-and-place rule, not a scoring nudge. Marginal value with
RSI 42–58 held fixed:

| Gate | n kept | Win | Avg | P&L | minus best trade |
|---|---|---|---|---|---|
| RSI band only | 97 | 69.1% | +0.26% | +$220 | +$90 |
| + drop Sunday/CLOSED orders | 86 | 69.8% | +0.33% | +$223 | +$93 |
| + drop AFTER_HOURS orders | 90 | 72.2% | +0.43% | +$273 | +$143 |
| + drop Friday entries | 81 | 74.1% | +0.50% | +$286 | +$156 |
| + drop the first hour | 74 | 68.9% | +0.59% | +$346 | +$216 |
| **all four** | **48** | **81.2%** | **+1.26%** | **+$397** | **+$267** |

### 3.1 No orders placed while the market is CLOSED

24 trades, **33.3% win, −2.58% avg, −$213.** Worst session bucket in the
dataset. These are the Sunday limit orders. Roman is choosing a price
with no idea what the open will do.

### 3.2 No orders placed AFTER_HOURS

31 trades, 51.6% win, **−1.60% avg**, −$102. Thin book, wide spreads, and
the next real print is 17 hours away.

### 3.3 No Friday entries

57 trades, **45.6% win, −1.48% avg, −$238.** Worst weekday. Best are
Thursday (73.7%, +0.64%) and Tuesday (58.3%, but +$52 and 68.2% in the
regular session).

A Friday entry has to survive a weekend before it gets a second chance,
and the n=292 hold-time result says surviving a weekend is where money
goes to die.

### 3.4 No entries in the first hour (6:30–7:30 PT)

| Window | n | Win | Avg | P&L | minus worst trade |
|---|---|---|---|---|---|
| 6:45–7:00 | 5 | 100% | +1.14% | +$13 | — *(too thin to use)* |
| **7:00–7:15** | **25** | **48.0%** | **−2.70%** | **−$235** | **−$187** |
| 7:15–7:30 | 45 | 53.3% | −0.81% | −$142 | −$81 |
| **7:30–8:00** | **17** | **76.5%** | **+0.77%** | **+$79** | +$90 |
| 8:00–9:00 | 33 | 57.6% | −0.41% | −$48 | +$6 |
| 9:00–10:00 | 27 | 63.0% | +0.04% | +$91 | +$133 |
| 10:00–11:00 | 22 | 59.1% | −0.44% | −$20 | +$11 |
| 11:00–12:00 | 25 | 56.0% | −0.61% | −$114 | −$37 |
| 12:00+ | 16 | 50.0% | −0.45% | +$6 | +$19 |

7:00–7:15 is the single worst entry window in the day and it holds up
after removing its worst trade (−$187 of −$235 remains). The twelve
worst trades in the whole book include four bought between 7:00 and 7:20.

**I was wrong about this before.** Last session I told Roman to buy
between 6:30 and 8:00am PT. That was from the n=37 slice and it is
contradicted here on n=215. The correct statement is **7:30–10:00 PT**,
and the 6:30–7:00 window is unjudgeable (n=5), not good.

### 3.5 The RSI × time interaction

| | RSI <45 | RSI 45–55 | RSI 55+ |
|---|---|---|---|
| open–7:30 | 55.3% / −1.43% | 72.7% / −0.35% | 46.2% / −1.53% |
| **7:30–10:00** | 44.1% / −1.36% | **81.0% / +1.68%** | 77.3% / +0.54% |
| 10:00+ | 50.0% / −0.72% | 78.6% / +1.46% | 46.7% / −1.86% |

Two readings. The mid-band wins in every time window, so RSI is the
primary effect. And the first hour degrades *even the good band* (+1.68%
at 7:30–10:00 falls to −0.35% before 7:30), so time is a real second
effect, not a proxy for RSI.

**Best cell in the dataset: RSI 45–55 bought 7:30–10:00 PT — n=21,
81.0% win, +1.68% avg, +$222.**

---

## 4. Kill the sub-$10 entry bonus

It is a scoring component that pays up to +15 points for the trades that
lose the most money.

| Sub-$10 adjustment | n | Win | Avg | P&L |
|---|---|---|---|---|
| none ($10+ stock) | 69 | **66.7%** | −0.09% | −$86 |
| **bonus +15** (cheapest) | **78** | **48.7%** | **−1.42%** | **−$364** |
| bonus +10 | 31 | 61.3% | +0.51% | +$144 |
| bonus +5 | 17 | 58.8% | −1.24% | −$61 |
| penalty (−5/−10) | 20 | 60.0% | −0.37% | −$3 |

*(regular session, n=215)*

The +15 bucket is the largest single money-losing group in the entire
dataset. Meanwhile the trades that get no adjustment at all — the $10+
stocks — have the best win rate of the three price tiers (66.2% across
all 270, avg −0.19%).

**Remove the positive branch entirely.** Keep the penalty branch. If a
price-tier term is wanted, make it monotonic in the direction the data
points: $10+ = +5, $5–10 = 0, $3–5 = −5, under $3 = −10.

This is the same shape as the defects in §6 of the phase-9 spec, one
level up: not a value that got dropped, but a **scoring term whose sign
is backwards**, quietly steering the engine toward its own worst
outcomes for two months.

---

## 5. The instrumentation that makes entry research possible

**Everything above is inference from a confounded outcome.** Roman's
actual question — does the stock go up right after I buy — has no column
in this database, and until it does, every entry conclusion will be
contaminated by when he chose to sell.

### Capture the post-entry path from the fill, independent of the sale

New columns on `trades_v2` **and** `portfolio` (so an open position
accumulates them too):

| Column | Meaning |
|---|---|
| `px_plus_30min` | price 30 minutes after `filled_at` |
| `px_plus_2h` | price 2 hours after `filled_at` |
| `px_at_entry_close` | close of the session the fill happened in |
| `px_plus_1_close` | next session's close |
| `px_plus_2_closes` | two sessions after |
| `mfe_pct_day0` | max favourable excursion, fill → entry-session close |
| `mae_pct_day0` | max adverse excursion, fill → entry-session close |
| `path_basis` | `fill` / `order` (legacy) / `not-measured` |

Rules, all of which this project has already paid for once:

- **Measured from `filled_at`, never `buy_date`.** A placement time is
  not an entry. Where `filled_at` is NULL, `path_basis` is
  `not-measured` and every column is NULL — with one exception, below.
- **The `order` basis (legacy rows only), added 2026-10-21.** None of the
  292 existing trades has `filled_at` (all are pre-db/027 legacy rows),
  so the strict rule above would backfill nothing. A legacy row
  (`order_type` NULL) placed in the REGULAR session gets
  `path_basis = 'order'` **only if `buy_price` falls inside the
  high–low range of the SIP minute bars around `buy_time`** — observed
  evidence of a fill near placement, not an assumption. The path is then
  anchored at `buy_price` and timed from that minute. Every other legacy
  row (not REGULAR, or `buy_price` not seen in those bars) is
  `not-measured`. The tolerance window around `buy_time` is fixed in
  code and stated in the column comment; it is not tuned per row.
- **Day-0 columns are NULL for any fill outside the regular session.**
  `px_plus_30min`, `px_plus_2h`, `px_at_entry_close`, `mfe_pct_day0` and
  `mae_pct_day0` are defined only for a fill (or `order`-basis
  placement) inside REGULAR hours. A pre-market, after-hours or
  overnight fill has no day 0: those columns stay NULL, while
  `px_plus_1_close` / `px_plus_2_closes` are still measured.
- **NULL is a finding.** Never 0, never the buy price. `??` not `||`.
  A horizon that falls outside market hours stays NULL rather than
  borrowing the nearest print.
- **SIP, not IEX**, for the same reason the intraday panel uses SIP: an
  excursion computed from one venue is the excursion of a fraction of
  the volume.
- **Backfill is retrievable.** Minute bars are available on demand for
  every past fill — this is the move that let `position_bars` be deleted.
  For history, "existing fill timestamps" means the `order` basis above
  (no row has `filled_at` yet). The 24 Sunday rows are CLOSED-session
  placements, so they stay `not-measured` until Roman's broker export
  supplies real fills. The first 37 trades go through the same
  minute-bar check as every other legacy row; the broker export, when it
  arrives, upgrades rows from `order` to `fill` basis as a separate
  observed-data correction.

### What it buys

`mae_pct_day0` is the direct measurement of "it dropped right after I
bought." `mfe_pct_day0` measures "it went up and I had a chance." The
pair separates three cases the current data cannot distinguish: an entry
that never worked, an entry that worked and was held too long, and an
entry that worked and was exited well. Only the first is an entry
problem, and right now all three look identical in the report.

**Do not promote any of §1–§4 from a filter into a score weight until
this exists.** With it, the RSI finding can be re-tested against a
dependent variable Roman's own exits cannot contaminate — and so can the
next twenty ideas, at no extra cost.

### Store EDGE's full signal object at buy (added 2026-10-22; at least as valuable as the path columns, arguably first)

Warrior stores its full signal object on every position
(`signal_snapshot`). **EDGE stores nothing: `signal_snapshot` is NULL on
all 292 EDGE trades** (`trades_v2` at `de95a93`). So no EDGE trade can
be re-scored for anything bar-derived, any momentum or
relative-strength change, or the up-days term. That's true now and
retrospectively, because the inputs were never kept: only point buckets
were stored for momentum and relative strength, and the up-days and
relative-strength values are written off before 2026-10-21 (§7.5). 245
of 292 can be *partially* re-scored, and only because
`entry_vs_signal_price_pct` happens to let the signal price be
recovered.

The path columns above give a clean **dependent** variable; this gives
the **inputs** to test against it. Without both, every future entry
question needs a fresh two-month wait for data. The fix is to write the
EDGE signal object (score inputs, components, and the bars it was scored
on, about 14.5 KB) into `signal_snapshot` at buy, as Warrior does. It is
also what makes 4(c)'s re-scored delta fully version-independent (§7.6
step 2). Until it exists, the same-version-only delta is the fallback.

### Store exit factors as a stable id plus display text (added 2026-10-22)

`full_ure_factors_at_sale` stores each factor by its **display text**
("RSI in sweet spot at 58", "Quiet accumulation at 0.7x"). So every
copy edit splits the factor-accuracy report. That has happened twice:
the volume labels on 2026-10-21, the RSI labels on 2026-10-22. The
display text is being used as an analysis key. Factors should be stored
as `{id, text, points}` with a stable `id` (`rsi_band_55_65`,
`volume_band_low`), so a wording change stays a wording change. It's the
same shape as a label that doesn't record its threshold (§7.7): a stored
value whose meaning depends on something that changes independently.

---

## 6. What to ship, and in what order

> **Superseded 2026-10-21 by §7.6.** The list below is the original
> plan, kept for the record. Build from §7.6.

1. **§3's four exclusions, as a hard gate on buyable signals.** They are
   time-and-place facts, not predictions; each is independently
   supported; and together they reject **11 of the 12 worst trades in
   the book while keeping the single best one** (AIXI, +$130, RSI 47.7,
   Tuesday 09:05).
2. **§2's RSI re-scoring** and **§4's sub-$10 removal.** Both correct
   terms whose current sign is backwards.
3. **§5's path capture.** Then re-test everything above against it.

### Honest limits on the gate

- **It keeps 48 of 270 trades — 18%.** Roughly 0.8 entries a trading day
  instead of 4.5. The P&L figure of **+$397 against the actual −$684** is
  what those 48 trades did *as Roman actually traded them*; it is not a
  prediction, and it is only achievable by genuinely skipping the other
  222.
- n=48 is a small book. Expect the win rate to come in below 81%.
- Realized P&L still blends entry and exit. §5 is what fixes that, and
  until it lands these are the best numbers available, not good ones.
- The band must not be re-tuned on this data. It was chosen from a
  plateau and confirmed out of sample; narrowing it further to squeeze
  the backtest is exactly the mistake §0 warns about.

---

## 7. Corrections (2026-10-21, after re-checking against raw rows)

Every number in §1, §3 and §3.4 reproduces exactly from `trades_v2`. What
follows corrects what those numbers were taken to mean. Where this
section and §0–§6 disagree, this section wins.

### 7.1 §0(b) is wrong

§0(b) says exit behaviour is noise, not selection, in any measure taken
over all 270 trades. It is not, because **the exit rules read the same
features the entry analysis groups by** — the peak-risk and
RSI-suspension exit logic reads RSI, and stops and targets come from
ATR and price tier. Realized P&L by RSI band therefore partly measures
the exit rules' response to RSI. Every realized-P&L-by-RSI number in §1
inherits this, **including the four robustness tests in §1, which tested
the wrong dependent variable carefully.** Two further problems: dollar
P&L is weighted by position size, which Roman chooses; and rows are not
independent decisions (§7.5).

**The exit-free dependent variable already exists:** `signal_log`'s
`ret_30m` / `ret_close` / `ret_1d` / `ret_3d`, measured from
`reference_price` at `first_shown_at`, for every EDGE signal shown or
below threshold, taken or not. Neither Roman's exits nor his selection
can touch them. Limits: they measure the signal, not his fill; 18 dates
and 83 symbols as of 2026-10-21; most first sightings are ~12:00 PT.

### 7.2 §1's headline is overstated

On `signal_log`, day-adjusted (each row minus that date's mean over all
EDGE signals), RSI 45–58 minus the rest:

| Horizon | Excess | Dates band won |
|---|---|---|
| 30 min | −0.04 pts | 9 of 18 |
| same-day close | −0.04 pts | 9 of 18 |
| +1 day | +0.58 pts | 9 of 17 |
| +3 days | +1.23 pts | 11 of 15 |

- **No RSI band predicts the immediate move.** Roman's literal question
  ("does it go up right after I buy") has the answer *nothing in §1
  predicts it*.
- **The defensible claim is the floor: don't buy deeply oversold.** RSI
  below 42 trails the day mean by 0.6–0.8 pts at +1d and +3d. The effect
  is 1–3 day drift, not an immediate-move edge.
- **Not a band, and not 45–58.** The 58 ceiling is one position: SNXX,
  2026-10-05 11:04, recorded as two rows (−$76.00, −$76.50); bands ending
  at 58 and 59 select identical trades, ending at 60 loses $157, all of
  it SNXX. 45–58 is the top P&L cell in the grid, sitting against a
  one-position cliff. On exit-free data RSI 58–65 is the *best* +1d
  bucket (+1.02 pts). §1's four tests were also run on 45–55, not 45–58.
- **The floor becomes a score weight only after** a proper re-run on
  `signal_log` — day-adjusted, day-clustered, distinct dates reported
  alongside n (§7.5).

### 7.3 §2 and §4: neutralise two terms only

Ship only the removal of two terms that pay points for outcomes that
lose money, each supported by both datasets:

- sub-$10 bonus +5 / +10 / +15 → **0** (penalty branch unchanged).
  Exit-free: the +15 tier trails the day mean by 0.4–0.6 pts at +1d/+3d.
- RSI < 35: +10 → **0**.

**RSI 55–65 stays at +20.** §2 wanted to cut it on realized P&L, which
§7.1 shows is contaminated by exit rules reading RSI; the uncontaminated
measure rates 58–65 among the better bands. Cutting a term because a
confounded measure disliked it, against the clean measure, is the same
mistake in the other direction. None of §2's new weights (+25 band, −10
for 35–42, −5 for 65–75) and none of §4's monotonic price ladder ships.

**Withdrawn display copy (2026-10-21).** The RSI copy (step 1c) and all
five volume-band notes in the score breakdown: "Healthy volume — best
win-rate zone" is false on Roman's data (1.0–1.3× was 59.1% / −1.24%;
0.5–1.0× was the best band at 63.2%); "Quiet accumulation — strong
historical performer" points the right way by accident, which makes it
more dangerous, not less (a claim that is accidentally true is still one
nobody tested); "late entry risk", "moderate signal" and "insufficient
liquidity signal" are the same kind of claim in quieter words. All replaced
by factual band descriptions. The exit engine's volume labels lost their
claims too ("Quiet accumulation", "Healthy volume", "Volume fading"). They
now state the fact and keep the weight beside it ("Volume 0.7× — band
0.5–1.0× (low)", +10): the claim goes, but the fact and the weight both stay
visible, because a neutral label next to an unexplained number explains less
than either. The weights are step 4's. Guarded by
`tests/score-components.test.js` (withdrawn phrases).

**Confound on §3.4 (and §3.5's time effect): the candidate pool changes
with the clock.** The scan's pre-filter (`runScreener`, copied by
`scripts/log-signals-edge.mjs`) keeps $1–$20 symbols with ≥100k shares
traded *so far today*, which is cumulative volume. So the pool is a
function of time of day. A 07:28 PT logger scan removed 228 of 239
symbols (Actions run 39617114090). An early scan offers only the names
with unusual early volume; a mid-morning scan offers most of the
universe. Roman's trades came from that same scan, so "7:00–7:15 is the
worst entry window" may not be about time at all. It may mean "stocks with
unusual volume in the first 45 minutes are bad", a different claim with a
different fix, and **the two can't be separated in the current data**,
because the population changes with the clock. The same applies to §3.5's
"the first hour degrades even the good band". **The RSI finding is not
affected:** RSI is measured within whatever pool was offered, and §3.5's
45–55 band wins in every time window (72.7% / 81.0% / 78.6%). Pre-filter
rejections are now to be logged (§7.6 step 1e), which makes the pool's
composition measurable per scan.

**Retracted finding: relative-strength buckets.** The 2026-10-21 analysis
reported relative-strength buckets (relstr 15: n=153, 59.5% win; quoted as
reported, not re-derived here). They were computed from the stored
`rel_strength_pts`, which is written off in §7.5: for EDGE trades it holds
the stock modal's recompute, not the value the score used. The table is
unusable and is retracted, not quietly dropped. **Not load-bearing:**
nothing in §1 or §7.2–7.4 depends on it. RSI, volume ratio, momentum and
volume-spike points were not in the mutated set.

### 7.4 §3: what survives

- **§3.2 AFTER_HOURS: kept, and the strongest of the four.** 28 trades
  over 8 dates, −$98, −$43 without its worst day, 5 of 8 dates negative.
  It is the only rule of the original four whose support survives
  date-clustering. (It was briefly left out of §7.6 by omission, not
  judgement.)
- **§3.1 CLOSED orders: rule kept, statistics withdrawn.** All 24 trades
  were placed on one evening (Sunday 2026-09-27). That is n=1 decision,
  not 24 observations. The rule stands on reasoning alone: a limit order
  placed blind to the open is choosing a price with no information.
- **PRE_MARKET: open and logged.** Roman has zero pre-market entries in
  the whole book, so there is nothing to judge it on. "No evidence"
  must collapse into neither "allowed because untested" nor "blocked
  because untested": it stays open, and entries there are counted
  separately so it becomes judgeable — the same three-state discipline
  as a NULL value, applied to a rule.
- **§3.3 Friday: dropped.** Inside the full gate, adding it cut P&L from
  +$421 to +$407 while raising the win rate (80% → 86%). A rule that
  makes the book look tidier and the money smaller is not a rule, and
  its standalone number is suspect for the batch-correlation reason in
  §7.5.
- **§3.4 first hour: 7:00–7:30 PT only, the weakest rule in the gate.**
  6:30–7:00 has 3 trades once CLOSED/AH/Friday are removed (all wins,
  +$8); excluding it changes the gated set by one trade (+$0.40). A rule
  over a window that can't be judged has no support, so 6:30–7:00 stays
  buyable and is logged until it can be judged. Even the 7:00–7:30
  support is modest: in a same-day comparison (days with buys both at
  7:00–7:30 and after 7:30) early entries did worse on 6 of 11 days; the
  real support is the four big batch days (9/28, 9/29, 9/30, 10/02),
  each 1.5–2.7 pts worse early. Standalone it removes 49 trades over 12
  days, −$177, −$113 without its worst day.

### 7.5 Sample size is trading days, not trades

Roman buys in batches (17 trades on 2026-10-02). The effective n is
distinct trading days.

**The nine duplicate pairs are not lots — they are one position recorded
as two sales** (GPGI, HTZ, VISN, RR, TDAY, GO, CXM, SOUN, SNXX; checked
2026-10-21). Each pair has identical buy fields (shares, price, time,
score, RSI) but two different sales, and the nightly table backups in
`data/backups/portfolio.json` show **exactly one portfolio row** for each
position before its first sale (e.g. SNXX: row 778, 50 sh, in the 10/06,
10/07 and 10/08 backups; SOUN: row 724, 100 sh — two 100-share sales of a
100-share position is impossible). For the 10/01 batch the mechanism is
visible: six positions sold 13:23–13:26 PT reappeared as new portfolio
rows (ids 530–536) created within one second at 20:31:18–19Z, five
minutes later, and were "sold" again 10/02 07:13–07:15 PT. That is the
sold-position resurrection race (first fixed 2026-08-19 with a
session-only guard, `state.deletedPositionIds`): a background
`savePositionToSupabase` upsert from a session that still holds the sold
position re-inserts it. So nine rows are corrupt: they inflate n by nine
and double-count P&L. **Fixed 2026-10-21 at the cause, not the guard:**
only the two add forms insert portfolio rows; every other save is
update-only, and an update matching no row is classified (MISSING /
UNWRITABLE / UNKNOWN by a follow-up select) and shown in the banner. Only a
confirmed MISSING stops the session saving the position
(`tests/position-save-update-only.test.js`). The nine existing rows are not
touched by the fix and stay unresolved below.

**Written off: `cons_up_days`, `cons_up_pts`, `rel_strength_pts` on EDGE
trades recorded before 2026-10-21's modal fix.** Until then,
`openStockModal` wrote its own recompute of these fields (from its own bar
fetch, at the time the modal was opened) onto the live `state.signals`
entry. `finalizeAddPortfolio` stored them from that same object, and the
EDGE add button is inside the modal. So the stored values are the modal's,
not the ones the score was summed from. You can't tell row by row which is
which, and the components need not add up to `signal_score`. **These columns
are not analysable, full stop** — not "treat with caution". Measured
where it could be: 6 EDGE trades on 2 dates match a same-day `signal_log`
snapshot, and 1 differs (STUB 2026-09-18, rel-strength 15 stored vs 5
scored). That shows the divergence exists, not how big it is. Every other
stored component (RSI, volume, momentum, MA, vol-build, mean-reversion
points) was outside the mutated set and is unaffected. Same for the exit
engine: until the fix, its exhaustion factor ("≥4 consecutive up days",
−20) read the mutated `consUpDays`, so a sell recommendation could depend on
whether a modal had been opened. Recorded `fullUreFactorsAtSale` and
`unified_recommendation_at_sale` carry that dependence and can't be
corrected after the fact.

**Which sale of each pair is real is unresolved** — it needs Roman's
broker export (on his list). Until then every P&L figure that depends on
them is run both ways. Book total: −$684.33 as recorded; **−$682.93
keeping each first sale, −$644.23 keeping each second sale.** SNXX is one
position, −$76.00 or −$76.50, not −$152.50; the §7.2 point that the 58
ceiling rests on one position stands (it is one position, not two rows of
evidence). **From
now on every finding reports both n and distinct dates, and uses a
day-clustered comparison (within-day, or day-adjusted with per-date
win counts), not a pooled one.** This applies to `signal_log` too, where
every signal on a date shares that day's market move.

**`signal_log` covers 19 of the 29 trading days from 2026-09-11 to
2026-10-21** (`data/backups/signal_log.json`, distinct EDGE
`signal_date`, backup `de95a93`; through 2026-10-20 it was 18 of 28). Any
day-clustered analysis on it has **n = 19 dates, not
29**. The missing 10 are missing because GitHub cron delivery dropped or
delayed the logger, not because nothing happened, so they are unobserved
days, not quiet ones.

### 7.6 Build order (replaces §6)

1. **Hard gate on buyable signals (advice only — §7.7):** no orders
   placed AFTER_HOURS; no orders placed while the market is CLOSED; no
   entries 7:00–7:30 PT. Time-and-place rules, no prediction. Evaluated
   at view time, not scan time. EDGE only. 6:30–7:00 and PRE_MARKET are
   open and logged. Recording stays open behind a confirm; whether a
   trade was placed inside a gate window is derived on read from
   `buy_date`/`buy_time`, not stored. The DAY-suppression button
   (disabled "+ Add to Portfolio" after 10:00 PT) is fixed the same way.
1b. **Recording, everywhere:** "✓ In Portfolio" and "Order pending" get
   the same confirm-and-record treatment. One position per ticker was
   never intended.
1c. **`scoreComponents` refactor** (§7.7's duplication rule): one pure
   function in `core/edge-scoring.js` that `scoreStock`, the breakdown
   display and `rsi_pts` all read; `deriveRsiPts` and the display copy
   deleted. Proven score-identical on generated inputs before anything
   else changes. The display's evaluative RSI copy ("Sweet spot —
   historically best win rate", "Oversold — potential bounce setup")
   becomes factual band descriptions: we no longer know enough to
   editorialise.
1d. **Code version on every recorded row** (`db/028_code_version.sql`,
   applied and verified 2026-10-22). One `code_version` jsonb,
   `{app, scoring, scoring_hash}`, on `portfolio`, `trades_v2`,
   `signal_log` and `scan_runs`, written once at record time:
   - **`app`:** the `?v=` stamp of the `app.js` actually running. A stale
     tab reports its own old stamp, which closes the order-date proxy's
     hole (§7.5).
   - **`scoring`:** `SCORING_VERSION`, an **integer**. It's orderable, so
     it's what queries join and filter on.
   - **`scoring_hash`:** a hex hash of the formula's source, which the test
     pins to `SCORING_VERSION`. It's tamper-evident: the integer answers
     "which version", the hash answers "is that really the code". (The
     first draft's CHECK required `scoring` to be a number while the text
     said it was a hash. Both are kept, because they answer different
     questions.)

   **Write-once is a trigger, not a comment:** an UPDATE that changes any
   of these columns is rejected, NULL → value included, so nothing can be
   backfilled. **Grants:** the repo shows column-level INSERT only on
   `workflow_runs` (db/023), but the live database isn't the repo, so the
   new columns are granted to anon explicitly (additive). The
   verification checks the result with `has_column_privilege`. The
   real-write proof is the post-deploy re-select of the first real rows,
   not a synthetic anon row: anon can't delete, so a test row would stay
   in the analysis tables. Both migration files parse with libpg_query (the
   Postgres parser), PL/pgSQL body included, with negative controls; they
   haven't been run against a database.

   Neither is a hand-maintained constant. That's the failure the existing
   `signal_log.build_version` shows: it's filled from app.js's `VERSION`,
   which says `v2.18.0` on all 588 EDGE rows from 2026-09-16 to 10-20,
   across 17 commits to the scoring code. It identifies nothing after
   2026-09-15.

   **Two columns on `trades_v2`:** `code_version` (the buy's, copied from
   the position) and **`sale_code_version`** (the code that ran the
   sale, which produced the recommendation and factors at sale). Filing
   sale-time fields under the buy's version would put a wrong label on a
   value.

   **Order: db/028 is applied before step 2**, and before any code that
   writes it (a missing column breaks the add-position insert). Step 2's
   rows then carry a real version from the start. Separating them by
   bumping `VERSION` would work exactly once, because it's the first bump
   in 17 commits, and it must not become the pattern.
1e. **Log the pre-filter's rejections, not scored rows** (`db/029`,
   DRAFT). Per scan: symbol, price, cumulative volume, and which test
   failed (price < $1, price > $20, volume < min). No bars, no news, no
   score. The pre-filter already holds every one of those values when it
   rejects, so it costs **zero extra requests** and a few hundred bytes a
   symbol. It makes the filter's own selectivity measurable; today 228
   symbols a scan leave no trace, and a missing row can't be told from a
   true negative. Whether the rejects would have been good trades needs
   forward returns, fetched later for a sample of days, off the scan
   path.

   **Stored on `scan_runs`** (one jsonb array per scan), not as a fourth
   `signal_log` tier: `signal_log`'s unique key (date, symbol, engine,
   tier) would keep only the *first* rejection per symbol per day and drop
   the per-scan picture this exists for. Every `signal_log` reader also
   assumes a scored snapshot.

   **This overturns the logger's "three tiers only, not a fourth
   'filtered' tier" decision**, explicitly, in the logger's header: that
   decision was made before the censoring cost was understood, and it
   said the universe/evaluated count gap was where the fact lived. A count
   can't say which symbols, at what price or volume, or which test they
   failed.

   The "split the display and logging constant" instruction is
   **dropped**: `signal_log` already logs SHOWN and BELOW_THRESHOLD with
   full snapshots, so there was nothing to split.
2. **Neutralise the two backwards terms in §7.3 AND re-derive the BUY
   thresholds in the same change** (§7.7), so buyable signals per day
   stay near today's ~5–6 (106 over 19 dates, one per date and symbol;
   `node scripts/derive-step2-thresholds.mjs`). The intent is to change
   which signals rank highest, not to turn the tap off. Shipped with both
   score histograms, the old and new lines, and buyable count and
   price-tier mix per day under each. Nothing else moves. The exit
   engine's score cutoffs move with the thresholds in the same change, as
   functions of them, not literals (STRONG, (STRONG+SOFT)/2, SOFT,
   0.6×SOFT), and the residual is measured on the positions actually
   held during the `signal_log` window: how far each one's score moves,
   and how many change recommendation bucket. That ties the cutoffs to the
   thresholds and calibrates nothing, so step 2.5 doesn't block it. The
   score movement is clean, because it's the entry score, which the
   render-written values don't touch. The bucket count runs through the
   exit engine, whose inputs are render-dependent until step 2.5. **Both
   are reported, the bucket count is marked noisy, and it is not a
   decision input.**

   **Derived (`node scripts/derive-step2-thresholds.mjs`, 2026-10-21).**
   Data pinned to backup `de95a93` (signal_log through 2026-10-21). 666
   signals (one per date and symbol) over 19 dates. The old formula, read
   from git, reproduces all 676 stored scores exactly.

   | Line | Old count at old line | New line | New count |
   |---|---|---|---|
   | SOFT | ≥73: 106 | **65** | 98 (≥60: 114, ≥70: 73) |
   | WATCH | ≥29: 534 | **20** | 492 (≥15: 585, ≥25: 447) |
   | STRONG | ≥116: 0 | **110, by decision** | 0, not derivable |

   - **WATCH 20 is the nearest available line, not an equal-count
     match.** It undershoots the old count by 8% (492 vs 534), where 15
     overshoots by 10% (585). Scores move in steps of 5, so nothing lands
     closer. Leaving the line at 29 under the new formula would show 412,
     23% quieter.
   - **STRONG has no derivation.** No logged signal ever reached 116, and
     under the new formula none reaches 110. The tier has never fired in
     19 dates under either formula, so 110 is untested display logic, not
     a calibrated boundary. Revisit it as copy: if STRONG never shows,
     SOFT BUY carries every real recommendation while reading as a hedge.
   - **What Roman sees each morning changes more than the buy line
     does:** 60 signals now shown as WATCH drop below the line, and 20
     SOFT drop to WATCH. Going the other way, 18 rise into WATCH and 12
     WATCH rise to SOFT. That's the intended direction.
   - **Buyable price mix** (19 dates): $1–3 goes 24 → 21, $4–9 goes
     47 → 34, $10–20 goes 35 → 43, moving away from the cheap end as
     intended.

   **4(b): what step 2 does to the exit engine's absolute-score tier
   factor, measured and accepted (2026-10-22)**
   (`node scripts/measure-step2-residual.mjs`; trades_v2 at `de95a93`,
   236 EDGE trades held in the window, 464 end-of-day position-days
   rebuilt from each ticker's own bars, no news or macro for either
   formula):
   - **Score movement:** 74% of held position-days move. 22.4% move by
     −25, 9.3% by −20, 14.9% by −15, 19.2% by −10, 8.4% by −5, and 25.9%
     are unchanged. 181 of 236 trades have at least one moved day.
   - **Tier-factor bucket changes:** 160 of 464 position-days (34.5%), on
     111 trades. **123 move weaker, 37 stronger.**

   **This is the formula correction reaching the exit engine, not drift.**
   After step 2 the tier factor is internally consistent: a v2 live
   score against cutoffs that are expressions of v2's thresholds. The
   change is composition-dependent: the formula takes up to 25 points
   off cheap and oversold names and none off a $12 stock at RSI 50, so no
   choice of threshold removes it. The §7.7 threshold rule is satisfied,
   not violated: the cutoffs are re-derived in the same change. The
   direction is the intended one: positions now believed to be worse buys
   get weaker hold signals.

   **The tier factor itself is unvalidated:** it has never been tested
   against anything. Step 2 changes its output on about a third of held
   position-days in the direction the formula change implies. That's step
   5's problem, and it arrives there with this measurement already taken.

   **Found while building:** the exit engine's "Score dropped / improved"
   delta compares the stored buy score with the score now. Across a
   formula change only one side moves, because the buy score is stored, so
   every position held across the deploy would show a drop its stock never
   made. That contradicts 4(c)'s "roughly invariant because both sides
   move", which holds only when both scores come from one version. The
   built code compares only same-version scores and shows the factor as
   not evaluated otherwise.

   **Re-sequenced (Roman, 2026-10-22).** The threshold refactor ships
   *now*, with the version writer, at **scoring version 1**, where it
   changes no score and no label (full output identical to the
   pre-refactor commit on every logged snapshot and 10,000 generated
   inputs). **Step 2 is held as the smallest possible diff:** two terms in
   `scoreComponents`, `SCORING_VERSION` 1 → 2 with its hash, one row
   (`2: { watch: 20, soft: 65, strong: 110 }`) in the threshold table, and
   the test's stated delta and decided lines. When it ships, the measured
   effect is the formula change and nothing else. Shipped 2026-10-22, after
   4(b) was re-read as the intended correction (below).

   **4(c) starting point, audited: re-score the buy instead of comparing
   a stored number with a live one.** Then both sides of the delta come
   from one version, by construction. What an EDGE trade stores (292
   trades, `trades_v2` at `de95a93`):
   - **Stored, usable:** `rsi_at_buy`, `volume_ratio_at_buy`,
     `ma_pct_at_buy` (gives price vs MA20), `vol_build_pts` and
     `mean_reversion_pts` (give the two booleans), `catalyst_setup`, and
     `macro_condition` / `macro_adjustment_pts`. The signal price comes
     from `entry_vs_signal_price_pct`, on 245 of 292 only; `buy_price` is
     the order price, and the sub-$10 test uses the signal price.
   - **Missing or unusable:**
     - **`cons_up_days` and `rel_strength_pts`:** written off before the
       2026-10-21 modal fix (§7.5).
     - **Raw `todayChange` and `rsVsSPY`:** only their point buckets are
       stored.
     - **The bars:** `signal_snapshot` is NULL for every EDGE trade; only
       Warrior stores one.

   So the re-score works for a formula change that **re-prices inputs
   already stored**. Step 2 is such a change (RSI, signal price, volume
   ratio), for the 245 trades with a recorded signal price. It **can't**
   re-score a change to the momentum or relative-strength buckets, the
   up-days term, or any setup detected from bars. **That is a
   §5-shaped gap, recorded as one, not worked around:** EDGE should
   store its full signal object at buy (`signal_snapshot`, as Warrior
   already does, about 14.5 KB with bars). Then every future formula can
   re-score every future buy. Until it does, the same-version-only delta
   (built in 1d) is the fallback: not evaluated, with the reason.

   **4(c): the version-translation design was NOT built (2026-10-22).**
   It proposed evaluating held positions in their buy's scoring version
   through a declared version-to-version delta. It was stopped for three
   reasons:
   1. **The residual it targeted is the intended correction** (above).
      Only the delta factor had a real mismatch (a stored v1 score
      against a live v2 score), and the same-version-only guard already
      ships for that.
   2. **A declared delta is a second copy of the formula.** Step 2's delta
      isn't a scalar: it's −25 for a cheap oversold name and 0 for a $12
      stock at RSI 50, so the declaration must encode composition, which
      is the duplicate-logic rule. If cross-version evaluation is ever
      genuinely needed, the answer is a versioned scorer,
      `scoreStock(inputs, version)`, which can't drift because it *is*
      the old formula. Not a delta table.
   3. **It would preserve behaviour nobody has validated.** Both exit
      models were rejected on evidence, three exit inputs are
      render-dependent until step 2.5, and the tier factor has never been
      tested. Building machinery to hold an unvalidated factor
      numerically still is the opposite of this project's most reliable
      move: when a value is unreliable, stop needing it.

   **4(c)'s real question stays open, as step 5's:** should the exit
   engine read the absolute entry score at all, or only the delta (score
   at buy versus now)? That's a redesign behind the §5 re-test and step
   2.5, not something to answer with code now. The §5 signal-object
   item is what would let a stored buy be re-scored by a versioned
   scorer when that question is taken up.

   **Shipped with step 2: `state.ownedScores` is versioned.** It was
   `{score, label}`, persisted in localStorage across deploys, with no
   version: a stored value that silently mixed formulas. Entries now
   carry `scoringVersion`, and every reader goes through
   `currentOwnedScore()`. An unversioned or other-version entry is not
   evaluated, with the reason shown on the card and in the exit engine,
   never used as a number. It heals itself at the next scan, which
   refreshes every owned ticker.

   **Decided before building (Roman, 2026-10-21):**
   - **All three lines are re-derived:** STRONG, SOFT and the WATCH/display
     line (`BASE_SCORE_THRESHOLD`, 29 today). The same histogram method is
     used for all three, on `signal_log`'s SHOWN and BELOW_THRESHOLD rows.
     This is not a lower bound: the logger logs every scored symbol (§7.6
     step 1e), so the rows scoring 20–29 are in the data. A quieter WATCH
     list caused by an unrelated term correction is the drift §7.7 exists
     to stop.
   - **`ELEVATED_SCORE_THRESHOLD` becomes the expression `SOFT`.** It was
     designed as the same line (both were 50 on the 0–100 scale, which
     the stale comment above it still says), and leaving it at 73 while
     SOFT moves would make the adverse-conditions line stricter than
     anyone decided. The stale comment is deleted.
   - **The exit midpoint is floor((STRONG+SOFT)/2).** Floor keeps today's
     convention (94 = floor(94.5)). Under 110/65 that's 87, not 88, and
     the two are **behaviourally identical**: every score is a multiple of
     5 before and after step 2 (all terms and macro adjustments are; all
     676 logged EDGE scores at `de95a93` are), so the next reachable score above
     either is 90. Settled once, with the reason, so it isn't reopened.
   - **The exit's top cutoff becomes `>=`**, not `>`. Today a score of
     exactly 116 is labelled STRONG BUY and also denied the top exit
     weight: two answers to one question from two copies of a threshold.
     This is a **deliberate behaviour change**. On the logged data it
     can't occur: under the new formula no signal scores 110 or more (the
     two 110s in the data are old-formula scores; `node scripts/derive-step2-thresholds.mjs`). It's
     changed as a rule, not because the data needs it. Both read from the
     one `scoreLabel()`.
   - **`signal_label` is computed from the buy's scoring version**, not
     at sale from the current thresholds (`writeTradeToSupabase` did the
     latter, so a position bought under 73 and sold after step 2 would be
     labelled under 65). Keyed on db/028's `scoring` version through the
     dated threshold table. It's the same shape as `holdSpan`'s basis
     problem: a stored value whose meaning depended on the rule in force
     when it was read.
2.5. **Exit-engine inputs stop depending on when the app was open**
   (§7.7). Design only; not built. The shape is the one this project has
   used before: when an accumulated value is unreliable, stop needing it.
   Bars are retrievable on demand (phase-9 §2.0, the reason
   `position_bars` was deleted). That deletion assumed the app would
   derive a position's path instead, but the derivation was built only
   for the display panel. The three exit-engine inputs phase-9 §1.4 named
   were never moved off the render, and §1.4 still says "Fixed by §2".

   | Today (render-written) | Becomes (derived on demand) | Extra requests |
   |---|---|---|
   | `peakPrice`: max price seen at a render | **hold high**: max of (buy-day minute highs after the fill instant, or the order time when unfilled; the `order` basis rule) ∪ (daily highs for complete sessions in between) ∪ (today's minute highs) ∪ (the live price now, a real observation) | Daily bars (180d) and today's SIP minute bars are already fetched per render for every holding. New: one buy-day minute-bar request per position held past its buy day. Past days never change, so it's cached for the session. N positions → N requests on the first render, 0 after. |
   | `momentumProtectionActivated`: sticky flag set if a render saw ≥ +20% | **derived**: hold high ≥ buy × 1.20. Sticky for free, because the hold high is monotonic over the hold. | none beyond the hold high |
   | `prevRSI`: RSI at the previous render | **RSI from the daily closes ending at the previous completed session**, day over day. The factor is **renamed "RSI declining"**: it no longer claims "from peak", because a name that asserts more than the code computes is the volume-copy defect. The hold-high RSI is **stored as a measured column**, so the peak version can be tested later on data rather than chosen on intuition. | none (same daily bars) |

   **When bars are unavailable: NULL and not-evaluated, never the last
   rendered price.** A failed or partial fetch makes the hold high NULL,
   never the max of whatever arrived (phase-9 §2.0.2: a truncated series
   has a truncated high). With the hold high NULL, momentum protection is
   NOT EVALUATED. The exit engine branches on it (trailing stop and RSI
   suspension apply only in protection), so it can't silently pick a
   branch. **Decided: only the dependent rules are not evaluated**; the
   rest still evaluate. The recommendation states what it couldn't see,
   using the Portfolio Summary pattern: "computed from 7 of 9 factors —
   momentum protection not evaluated (no bars for 2026-10-14)". A factor
   is never silently omitted and never given a neutral value. A
   whole-recommendation CANNOT EVALUATE on one missing input would make
   the app useless on any data hiccup, and Roman would decide without
   it, which is the route-around failure the recording gate exists to
   prevent. A split during the hold (bars are
   `adjustment=all`; `buy_price` is not) is also NOT EVALUATED, using the
   same split-in-hold check `scripts/replay-floor-grid.mjs` applies. The
   IEX fallback is labelled as in phase-9 §2.0.1, because it can
   understate the high.

   **Decided (Roman, 2026-10-21):**
   - **(i) Regular session only.** The peak feeds the trailing stop and
     the pullback factors, which all ask "could Roman have sold near that
     price". An extended-hours print on a thin book isn't a price he
     could have realised, and letting one set the high manufactures a
     pullback that never happened. This is the SIP-over-IEX argument
     again. An extended-hours high may be computed separately for
     research, but it never enters a decision.
   - **(ii) Day over day, renamed**, with the hold-high RSI stored. The
     hold-wide peak was rejected because it latches, which is what made
     momentum protection unmeasurable, and because the −30 weight has
     never been validated: its definition shouldn't be picked on
     intuition.
   - **(iii) Only the dependent rules are not evaluated**, with the count
     and the reason shown.

   **Also follows, scoped with it:** the render stops writing
   `peakPrice` / `momentumProtectionActivated` / `rsiSuspendedAtGainPct`,
   so the three `backgroundSavePosition` calls in `renderPortfolioTab`
   go away. That's the surface the resurrection race used. At sale,
   `peak_price` and `momentum_protection` get the derived values. The
   recorder fields with the same dependence (`ownedPeakRSI` →
   `peakRsiDuringHold`, `rsiSuspendedAtGainPct`, `liveTarget` →
   `targetDriftPct`) derive from the same bars at sale time. Each fix
   removes a line from the ratchet test.

   **Already in the record:** stored `peak_price` and `momentum_protection`
   on every trade so far are render-dependent. phase-9 §1.4 and the
   report's WINNER EXIT TIMING caveat name it as an *analysis* limit. Both
   miss that the same value has been a live input to exit decisions,
   which is worse than no caveat, because it makes the problem look
   understood. "Trades where Momentum Protection activated: 0" was never
   evidence about the market. The feature could only fire if a render
   happened while a position was up 20%.
3. **Report-gap fix** (Appendix): ENTRY TIMING prints all four session
   values, every weekday present in the data, and a not-recorded bucket,
   with counts that sum to the total — both copies in `app.js`.
4. **§5 path capture**, with the `order` basis and the day-0 NULL rule.
   As part of this step, answer: does the 1–3 day drift edge appear at
   all in Roman's realized multi-day holds, or is it erased because the
   positions he holds for days are the ones that failed on day 0? Check
   against `signal_log` rows matched to a trade. If the drift is real
   but unreachable by his actual behaviour, that is the headline.
5. **Exit-engine re-derivation** (its cutoffs, its weights, and the delta
   redesign in §7.7). **Blocked on two preconditions:** the §5 re-test
   (step 4) **and step 2.5.** Re-deriving cutoffs on top of three
   render-dependent inputs would be calibrating against browsing habits.
   **Until step 2.5 ships, the exit engine has no validated inputs**:
   momentum-protection mode, the trailing-stop exit, and the −30 "RSI
   declining from peak" factor are functions of when the app was open.
   **Also arriving here, already measured:** the absolute-score tier
   factor ("Current score N — support/weak signal") is unvalidated, and
   step 2 changed its output on 34.5% of held position-days (123 weaker,
   37 stronger; `node scripts/measure-step2-residual.mjs`, step 2 §4(b)).
   With it comes 4(c)'s open question: should the exit engine read the
   absolute entry score at all, or only the delta?

Then re-run §7.2 properly on `signal_log`. If the oversold floor survives,
it becomes a score weight. Nothing else does yet.

### 7.7 Two rules this project keeps paying for

**A gate on advice must never be a gate on recording.** A gate that
prevents recording a trade Roman actually placed deletes data precisely
for the trades the gate exists to study: it makes its own effect
unmeasurable, and it fails silently — a missing row looks like a trade
that never happened, and nothing downstream can tell the difference.
That is the defect family's worst form: not a fabricated value, not a
dropped one, but an absence indistinguishable from a true negative.

Found live on 2026-10-21: the DAY-trade suppression (Change 11) disabled
the only EDGE buy-recording button ("+ Add to Portfolio" in the signal
modal) from 10:00 PT onward for DAY-classified signals. Consequences:

- **DAY-classified buys after 10:00 PT are censored before 2026-10-21.**
  Any analysis of them is over an unknown denominator, and the size of
  the hole cannot be measured, because the swallowed trades left no row.
  The report's "Exit Today: 19 trades | 53% win" is such a number:
  **censored-before-2026-10-21**, kept, not deleted.
- This is why §7.5 matters beyond small samples: a small sample
  announces itself; a missing-row mechanism does not.

**When a change requires editing the same logic in two places, the
change is to delete one of them.** Duplicated logic that must move
together has been found by accident, while changing something else,
every time: three copies of the hold-window table, two copies of the
ENTRY TIMING report section (`app.js` ~7319 and ~8132), and two copies of
the scoring tiers (`core/edge-scoring.js` and the score-breakdown display
in `app.js`). A display that disagrees with the score it claims to
explain is worse than no breakdown: it is a justification for a decision
that wasn't made that way.

**A scoring change that moves a threshold's meaning must re-derive the
threshold in the same change.** 73 and 116 were calibrated against a
score distribution that included every term. Removing up to 25 points
from the cheap and oversold end doesn't make the label boundary stricter
on purpose — it drifts, and a boundary that moves because an unrelated
term was deleted is not a decision anyone made. Otherwise the effect being
measured is the drift, not the change. (Step 2 without a re-derived
threshold would have halved the buyable set: 53 of 106 buyable signals
over 19 dates drop to WATCH, leaving 53; `node scripts/derive-step2-thresholds.mjs`.)

**A refactor is proven by two results, and both are required.** 1c
(`scoreComponents`) is the pattern: (1) zero differences in full
`scoreStock` output between the new code and the last pre-refactor commit
(`1c39926`, read from git), on every EDGE snapshot in the committed
`signal_log` backup as it stood at 1c's commit (664 × 6 macro conditions =
3,984; the test reads the current backup, so the count grows nightly) and on 10,000
generated inputs (`tests/score-components.test.js`); and (2) a mutation
showing the test can see a one-point change. For 1c, MA +10→+11 and RSI
35–55 +15→+14 each failed both equivalence tests on the first
differing input (checked 2026-10-21, then reverted). **The mutation half is
the part that makes the zero mean anything:** a comparison that cannot fail
also reports zero differences.

**A test that compares two readers of the same function is a wiring test,
not a value test.** The breakdown-equals-formula test in the same file
passed under both mutations: once display and score read one function, a
wrong tier value moves both sides together and that test cannot see it. It
detects only a wiring break (the display stops calling `scoreComponents`).
It looks like coverage of the tier values and is none. Only the comparison
against an independent reference (here, the old commit) covers values.

**A number that cannot be reproduced on demand does not go in a spec.**
Either the command that produces it is named next to it, or it comes out.
Found 2026-10-21 on this paragraph: the first draft of the 1c proof gave
"24,056 inputs". Claude reported that figure from an earlier session's run,
then could not reproduce it from the committed test, which runs 3,984 +
10,000 (`node tests/score-components.test.js` prints the snapshot count).
The figure went from a scratch run into Roman's review and back into the
spec in two turns, because it was precise and precision reads as
verification. Two failures: reporting a figure that wasn't re-derived, and
accepting one without asking where it came from. A stale figure in a spec
is a value nobody observed, and it spreads faster than code does.

**Extended 2026-10-21: a figure from an ad-hoc run is not quotable.** It
goes into a script with a named command first, or it stays in the
conversation. The rule applies to Claude's scratch output and to Roman's
analysis equally.

**And the command must pin its input, not just its code.** Corrected
2026-10-22, and the correction is the more important half. On 10-21 this
passage listed four figures as non-reproducible. Three of them were right:
- **"534 / 412"** for the WATCH line,
- **"106 over 19 dates"**,
- **"53 of 106 drop to WATCH"**.

All three reproduce exactly on the 2026-10-22 nightly backup (`de95a93`,
`signal_log` through 10-21). Claude had run the derivation against a
local copy one day staler (through 10-20), without fetching, got
529 / 407 and 105 over 18 dates, and read the difference as
non-reproducibility. That was Claude's error, not Roman's. Roman's
"I never once asked which command" was a fair question to ask, but his
figures were correct.

The structural defect underneath: `data/backups/signal_log.json` is
overwritten nightly, so "the command beside the number" gives a
different number the next day. The derivation now reads its data from a
pinned git revision and prints it (`DATA_REV`, default `de95a93`). The
equivalence test's snapshot count has the same property and is described
as "as of 1c's commit" for that reason. The rest of the record:
- **"24,056 inputs"** is still unreproduced on any backup, and was
  correctly withdrawn.
- **"2 rows in the 110 bin"** is true of the *old* formula. The new
  formula's 110 bin is empty, so the inference "after step 2 a score of
  exactly 110 would hit the inconsistency" doesn't hold on this data.
  The `>=` change is a rule, not a data fix.

**A failed reproduction is itself a claim, and it has to pin the same
inputs.** A figure that doesn't reproduce against *different* data isn't
an unreproducible figure. It's two different measurements, and the
mismatch says nothing about the original. Here the reproducibility rule was
used to delete three correct numbers: Claude's "doesn't reproduce" was run
against a staler copy, and Roman accepted the retraction without asking
which data either side had used. Both a figure and a failure to reproduce
it name their command **and the revision of the data it read**; a
comparison between runs is valid only when the two match.

By the same rule, **the entry-timing tables in §1 and §3 are not
quotable.** They came from throwaway Python in a scratchpad on 2026-10-21
(Appendix), not a committed command. The RSI finding survives only
because it was independently re-derived from `signal_log`, and that
re-derivation isn't a committed script yet either. Until each table has
a command, it is a lead, not a finding.

**A versionless module is safe only while nothing it depends on changes
its contract.** `engines/warrior/index.js` was loaded by a versionless
`import()` while `core/store.js`'s add path went from upsert to
insert-only. A cached old index.js would have called the now update-only
`savePositionToSupabase` to create a position: the add is refused with a
false "closed in another session" alert and the trade is never recorded.
Fixed in the same change (the import carries `?v=`, guarded by
`tests/warrior-degradation.test.js`). The sweep, 2026-10-21: every classic
`<script>` in `index.html` is versioned, except the two pinned CDN
libraries. The only versionless loads left are the Warrior engine's own
imports (`gate.js`, `replay.js`, `setups.js`), and of those only `gate.js`
calls into `core/` (`persist()`, contract unchanged). No remaining code
calls `savePositionToSupabase` to create a row; its only callers are the
fill confirmation and `backgroundSavePosition`, both updates of a row that
must exist. The sub-imports are not versioned. Doing it means one version
across all three files, or `gate.js` loads as two module instances
(index.js and replay.js would import it by different URLs). **They are not
"safe because `persist()`'s contract is unchanged":** that is the
reasoning that failed on index.js. **Trip-wire:** any change to a `core/`
contract reachable from `gate.js`, `replay.js` or `setups.js` (today:
`persist()` and the `state` keys it writes) must, in the same change,
either version all three sub-imports to one shared version or state here
why not. It's a condition checked at a known moment, not an open item
nobody is watching.

**Displaying something must never write to state that a decision reads.**
A view may compute fresh values; it may not store them where the scorer,
the exit engine, or the recorder will find them. Two independent instances
so far, each found by accident while changing something adjacent:

- The −6% floor read `currentPrice` on render. It evaluated only when the
  portfolio rendered, on the live in-progress price, so every look could
  catch an intraday dip: the shipped mechanism was the any-breach case,
  −$167.66 against −$69.88 for doing nothing, $97.78 worse, on the 33
  split-checked trades (`node scripts/replay-floor-grid.mjs`, −6% `any`
  row, re-run 2026-10-21; phase-9 §0.3.1–0.3.2). The trigger was render
  time. (Paraphrased: §0.3.1 has no sentence of the form
  "the more closely he watched, the worse it performed", though that is
  what its numbers say.)
- `openStockModal` wrote its recompute of `consUpDays` / `consUpPts` /
  `spyChange` / `rsVsSPY` / `relStrengthPts` (and, via `_modalStock = stock`,
  `livePrice` / `liveRsi` / `priceFetchFailed`) onto the live
  `state.signals` entry. The trigger was observation: opening a modal
  changed the exit engine's exhaustion factor on a held position, the
  components stored on the next trade (§7.5), and the card breakdown.
  **Fixed 2026-10-21:** `_modalStock` is a copy, a real signal's breakdown
  reads the signal, and only the unshared fallback takes fresh values.

**Deliberate sweep, 2026-10-21.** Covered every assignment to a non-local
object inside display-path functions (render / build / show / open /
display / toggle / report / card / modal / format, in `app.js`, `core/`,
`engines/`, `shell/`), plus every writer of each decision-read field it
found, plus argument mutation in all `calc*` / decision functions. The
only other writes (outside UI toggles, settings and local counters) are
all in `renderPortfolioTab`, and all have this shape. **Open, not fixed
here:**

- `p.peakPrice` / `peakPriceDate`: the only writer is the render, so the
  peak is the max of prices *seen while the Portfolio tab was rendered*.
  Read by the exit engine's momentum-protection pullback, by
  `trailingStopTriggered` on the sale, and stored as `peak_price`.
- `p.momentumProtectionActivated`: set only if a render happens while
  price ≥ +20%. It switches the exit engine's mode and is sticky.
- `p.prevRSI` ← `state.ownedPrevRSI`: the RSI at the *previous render*.
  `calcPeakRiskScore`'s "RSI declining from peak" (−30) fires on the
  difference, so whether it fires depends on when he last looked.
- `state.ownedPeakRSI` (max over renders → `peakRsiDuringHold` on the
  sale), `p.rsiSuspendedAtGainPct` (first render at RSI ≥ 72),
  `p.liveTarget` (last render → `targetDriftPct` on the sale): recorder
  fields with the same dependence.
- `state.portfolioPrices` / `portfolioPriceFetchFailed`: the last
  rendered price feeds the nav badge's sell-warning count.

`peakPrice`, `momentumProtectionActivated` and `prevRSI` are the serious
ones. All three feed the exit engine, so momentum-protection mode, the
trailing-stop exit and a −30 factor depend on when Roman had the app open.
The −6% floor was not one bad mechanism; it was a symptom of this
architecture, and these are the same shape in three more places, with
bigger weights. Fix shape and sequencing: step 2.5 (§7.6), which blocks
the exit-engine re-derivation (step 5).

**A known defect that can't be fixed yet gets a ratchet: a list that can
only shrink.** The render-time writes above are pinned exactly in
`tests/view-no-decision-writes.test.js`. A new one fails the test, a
fixed one must be removed from the list, and nothing can be added
quietly. It turns "known, open" from a sentence in a spec into a check
that runs. Use it whenever a defect is found in more places than one
change can fix.

**A fix believed done is not a fix shipped.** A spec may not record
something as fixed without naming the call sites the fix covers. "Fixed
by §X" is a claim about every consumer of the value, and it must be
checked against them, especially when §X works by deleting the old
mechanism, because the deletion removes the evidence that anything was
left behind. Found 2026-10-21:
- Phase-9 §1.4 named the decision risk of the render-written
  `peakPrice` and said "Fixed by §2".
- §2.0 then deleted `position_bars`, on sound reasoning, and built the
  on-demand replacement for the display panel only.
- The three exit-engine inputs never moved. The document asserted a fix
  that didn't exist for five weeks, and the deletion removed the thing
  that would have made the gap visible.

The defect family again, applied to a remediation rather than a value.
(Roman wrote §1.4, §2.0 and the word "Fixed", and has said so.)

The same day turned up a smaller instance of the duplicate rule in
`scripts/`. Three copies of the split check existed (`lib/sell-timing.mjs`,
`replay-floor-grid.mjs`, `replay-floor-with-recovery.mjs`), and the
recovery script's guarded only its counterfactual, so a split-adjusted
hold still set its trigger. Now there is one, `detectSplitInWindow` in
`scripts/lib/sell-timing.mjs`. The grid's output is byte-identical
before and after, and disabling the shared check changes both scripts'
results (mutation-checked).

**Make a value impossible to forget, not easier to remember.**
`build_version` existed, its write existed, and its value was wrong for
a month (`v2.18.0` across 17 commits to the scoring code) because it
depended on a human bumping a constant. The fix reads `app` from the
running `app.js`'s own `?v=` stamp and pins `scoring` to a hash of the
formula's source (db/028), so there is no step left to forget. It's the
same move as `reportNoopDecision` (2026-10-09). That replaced a pair of
calls each script had to remember to make with one call at the decision,
so a missing decision is recorded as NULL ("not determined") instead of
a default. A checklist item, a comment saying "remember to bump", or a
review step is the remember-harder version, and it fails the same way.

**Any label derived from a threshold must record which threshold
produced it, or it is only valid until the threshold moves.** Found
2026-10-21: `trades_v2.signal_label` was computed at sale from the
thresholds in force at the sale, not those that judged the buy. Labels
are computed from the version recorded with the score (db/028) through
a dated threshold table, never from whatever constant is current.

**Trip-wire: the write-once trigger (db/028, the project's first
trigger).** It fires on paths nobody is thinking about. **Any new or
changed write path to `portfolio`, `trades_v2`, `signal_log` or
`scan_runs` must be checked against it in the same change**: does the
path issue an UPDATE (including an upsert that resolves to one), and if
so, can the row it sends carry a different `code_version` /
`sale_code_version` from the stored one, NULL included? Checked
2026-10-22 against the paths that exist:
- **Loggers:** they write `signal_log` with
  `resolution=ignore-duplicates` (ON CONFLICT DO NOTHING), so no update,
  so no trigger.
- **`scan_runs`:** insert-only; nothing updates it.
- **The outcome filler and the split audit:** they PATCH named columns
  only, so the version is unchanged and the trigger passes.
- **`backgroundSavePosition` and the fill confirmation:** they send
  `mapPositionToSupabaseRow`'s whole row. **This is the dangerous one.**
  The mapper's newer fields (db/024, db/027; 9 in `core/store.js`) use
  `position.x ?? null`, and a new field written that way, as in a
  `code_version: position.codeVersion ?? null` line would null a
  populated column on every peak-price save, and the trigger would reject
  every one immediately after deploy. (A bare `undefined` would be
  dropped by `JSON.stringify`, not sent as null. The risk is the
  convention, not the serialiser.) Rule for the code step: `code_version`
  is written **only** by `insertPositionToSupabase`, never by the shared
  mapper. That's tested by a real round trip against the live table:
  insert a position with a version, run a background save through the
  real mapper, re-select, and assert that the update succeeded and the
  version is unchanged. Then delete the row, which anon can do on
  `portfolio`.

It's the same form as the Warrior sub-import trip-wire: a condition
checked at a known moment, not an open item nobody is watching.

**A fix that splits one source of truth into two must say which readers
get which, and check every reader.** Found 2026-10-21 on the modal fix
itself: the approved design gave the AI prompt the modal's fresh values
and the card the scored ones. The prompt's own exit recommendation then
used a different exhaustion input from the one displayed above it, which
is the display-versus-truth problem 1c eliminated, reintroduced one step
later by the fix's own instruction. Fixed the same day: the prompt
follows the breakdown's rule (fresh values only when there's no real
signal). What the sweep
cannot see: writes made through a helper called from a render path under a
non-display name, and anything outside these four directories.

**Open design question: the exit engine should not read the absolute
entry score.** From the 2026-10-21 review (point 4(c)): the entry score answers "is
now a good time to buy"; a held position asks "is the thesis intact",
whose honest form is the *delta*, score at purchase versus score now
("Score dropped from 80 → 50" already appears as a SELL NOW factor). That
delta is roughly invariant to formula changes because both sides move. A
redesign, not a step; it needs §5's re-test behind it.

---

## Appendix — provenance

**Not quotable under §7.7 (2026-10-21):** the parse and grouping below
were ad-hoc scratchpad Python, not a committed script, so every table they
produced (§1, §3) is a lead until a named command regenerates it.

Derived by parsing all 292 trade blocks out of
`edge-report-2026-10-21.txt` (the FULL TRADE HISTORY section) into a
flat table, then grouping. Parse was validated against the report's own
summary: 149 WIN / 121 LOSS / 22 unverified = 292, total P&L −$684.33,
all matching. Session counts from the parse: REGULAR 235, AFTER_HOURS 33,
CLOSED 24 — note the report's own ENTRY TIMING section shows only
"Pre-market 0 / Regular 215" and silently omits the 55 non-regular
entries, which is why §3.1 and §3.2 do not appear anywhere in the
generated report. **That reporting gap is worth fixing too: the section
should show all four session values, with counts, or it hides the worst
bucket in the dataset.**
