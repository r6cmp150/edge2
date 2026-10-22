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
2. **Neutralise the two backwards terms in §7.3 AND re-derive the BUY
   thresholds in the same change** (§7.7), so buyable signals per day
   stay near today's ~5–6 (106 over 19 dates). The intent is to change
   which signals rank highest, not to turn the tap off. Shipped with both
   score histograms, the old and new lines, and buyable count and
   price-tier mix per day under each. Nothing else moves.
3. **Report-gap fix** (Appendix): ENTRY TIMING prints all four session
   values, every weekday present in the data, and a not-recorded bucket,
   with counts that sum to the total — both copies in `app.js`.
4. **§5 path capture**, with the `order` basis and the day-0 NULL rule.
   As part of this step, answer: does the 1–3 day drift edge appear at
   all in Roman's realized multi-day holds, or is it erased because the
   positions he holds for days are the ones that failed on day 0? Check
   against `signal_log` rows matched to a trade. If the drift is real
   but unreachable by his actual behaviour, that is the headline.

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
over 19 dates drop to WATCH.)

**A refactor is proven by two results, and both are required.** 1c
(`scoreComponents`) is the pattern: (1) zero differences in full
`scoreStock` output between the new code and the last pre-refactor commit
(`1c39926`, read from git), on every EDGE snapshot in the committed
`signal_log` backup (664 × 6 macro conditions = 3,984) and on 10,000
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
must exist. Versioning the sub-imports is open and not done here: it has
to be one version across all three files, or `gate.js` loads as two
module instances (index.js and replay.js would import it by different
URLs).

---

## Appendix — provenance

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
