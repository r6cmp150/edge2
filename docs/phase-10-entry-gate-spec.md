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

> **First out-of-sample look (pinned 2026-11-01, `node
> scripts/report-forward-test.mjs --rev 0775407`): not confirmed.** In the
> first 64 forward trades (10-27 and 10-28), RSI 45–55 was n=19, 63% win,
> +0.48%: worse than this history on both measures, and the weakest of the
> three middle bands in that sample (35–45: 74%, +1.17%; 55–65: 83%,
> +1.43%). n=19 on two up-days for small caps neither refutes nor confirms
> it, but this is the project's only entry finding, and its first test
> outside the data it was found in did not reproduce it (§7.6, "THE FIRST
> FORWARD-TEST TRADES").

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

> **Day-of-week, retraction with all four reasons (2026-10-27).** The
> weekday table above can't support a rule, for four independent reasons.
> Three make the sample thin or contaminated: **batch concentration** (the
> effective n is trading days, not trades; §7.5), the **dead-stock and
> stale-bar trades** in the book (17 written off; §7.6 1e½), and **the
> in-gate result** (adding the Friday rule cut P&L while tidying the win
> rate; §7.6, "§3.3 Friday: dropped"). The fourth is a different kind:
> **the labels themselves could be wrong.** `buyDayOfWeek` and
> `sellDayOfWeek` were read from the day the add or sale was *recorded*,
> not the order or sale date (fixed 2026-10-27, §7.7). **Measured on the
> existing data, the fourth has not yet bitten:** 0 of 292 sales and 0 of
> the 268 datable buys were recorded on a different day from the event, so
> every checkable weekday label is right. 24 buys (August to early
> September, before the portfolio backups) can't be dated. It's recorded
> because it would have bitten silently the first time Roman backdated an
> add, not because it changed this table.

### 3.4 No entries in the first hour (6:30–7:30 PT)

> **The stored buy times are real fill times, so the 07:00–07:29 result is
> not about typing (verified 2026-10-27, `trades_v2` at `b4620bc`, the 270
> rows without `sell_price_unverified`, which reproduce the bucket exactly:
> n=70, −$377, 14 days.
> **Two counts, defined so the documents agree:** Roman's timing analysis
> counts **252** = 292 − 22 `sell_price_unverified` (= 270 resolved) − 18
> rows belonging to the 9 resurrected duplicate pairs, dropped because
> which sale of each pair is real is unresolved (§7.5, broker-export
> question 2). The audit below counts the **270**. That 270 reproduces
> the 07:00–07:29 bucket exactly, which shows none of the 18 duplicate
> rows sat in it, so the two populations agree there.
> Commands: `node scripts/audit-recording-lag.cjs`,
> `node scripts/audit-buy-times-vs-tape.mjs` (`SHIFT=60` etc. for the
> placebo), `node scripts/audit-after-hours-buys.mjs`).** `buy_time`, `sell_time` and `buy_session` are
> read from the clock at *recording*, so the risk was that the table
> measured when Roman typed rather than when he bought. Two tests:
> - **Recorded on a different day?** Never, where it can be checked.
>   0 of 268 datable buys (dated by the portfolio backups' position ids,
>   which are the add's `Date.now()`, or bounded by a same-day sale) and
>   0 of 292 sales. `created_at` is a real recording stamp (its PT time
>   equals `sell_time` to the minute on 286 of 292 rows), so the sale
>   check isn't circular. 24 buys can't be dated; 2 are in the bucket
>   (BTDR 08-17 07:12, PGEN 08-26 07:26). **The audit has a hard floor of
>   2026-09, by construction.** The 24 are trades held overnight before the
>   portfolio backups began, so no backup ever holds their add. That gap
>   closes going forward (every later position appears in a nightly
>   backup, and since db/033 `trades_v2.position_id` carries the add's
>   `Date.now()` directly) but never backward. **A re-run in six months
>   that still shows 24 unknowns is this floor, not a new problem;** only
>   a count above 24 is new.
> - **Typed later the same day?** Measured against the full-market tape:
>   in the bucket, **68 of 70 buy prices traded within ±10 min of the
>   stored buy time** (other buckets 94–100%). **A placebo shows the test
>   has power:** shifting every buy time by ±1h or ±2h drops the bucket to
>   10–36%. The two outside are BMEA and AQST on 09-25 (−$48). Without
>   them the bucket is **−$329 over 14 days**. Of its 70 buys, 49 share a
>   minute with another buy (up to five, e.g. 09-30 07:08 RIVN, COMP,
>   AUR, COUR and OPEN), and their prices trade at that minute too: basket
>   orders placed together, not a later batch of typing.
> - **`buy_session`:** REGULAR checks out on 209 of 215. CLOSED (24, the
>   Sunday orders) is labelled by date and correct. AFTER_HOURS: 16 of 31
>   verified and 1 outside; **14 are ambiguous.** Each is priced at or near
>   the closing print and stamped 30 min to 4h after the close, in a thin
>   evening tape (1–34 after-hours minutes). Each is either a closing fill
>   typed in later (really REGULAR) or an after-hours fill at the closing
>   price, and the data can't tell which. At most 14 rows could move, against
>   215 REGULAR (6%), so excluding AFTER_HOURS stands. **NEOG 08-19 @12.30
>   never traded at that price at any time that day:** a recorded buy with
>   no market support, now question 4 on the broker-export list (§7.5).
> - **What remains unmeasured:** within ±10 min, a stored time can't move
>   a trade across a 30-min bucket by more than its edges, so the finding
>   is safe at bucket width, not to the minute.

> **Not a finding (2026-10-22): shipped, and its evidence is currently
> unfalsifiable.** The time-of-day effect below has two independent
> confounds (§7.3). (1) **Pool size:** the pre-filter tests volume *so far
> today*, so an early scan offers only a handful of symbols. (2) **Venue
> artifact:** that volume is IEX-only, a median 6.3% of the market
> (3.7–27.7%), so the early pool is selected partly on each stock's IEX
> share. The symbols an early entry would be judged against left no trace
> until rejection logging began (§7.6 step 1e, 2026-10-22). Cite this
> rule as a precaution in force, never as evidence that early entries are
> bad.
>
> **Update 2026-10-27.** Confounds (1) and (2) are **gone from new data**:
> the step 1f gate selects on the 20-session full-market average, so the
> pool no longer depends on the clock or the venue. Friday 10-23's 06:48
> and 07:22 scans passed the same 80 symbols. The 215 trades above still
> carry both. **A third confound, independent of the gate, remains in
> every early scan: early-scan bars.** At the open, a stock that hasn't
> traded yet has no bar for today, so early scans score some symbols on
> yesterday's data. EMAT was scored at 06:48 on 10-23 from 10-22's bar.
> That's within the one-day allowance (step 1e½), so it isn't flagged
> stale, but it means the first hour's scores rest on a different mix of
> data than the rest of the day's. The extreme case is already on record:
> scans in the first two minutes after the open, where the snapshot still
> holds yesterday's bar, account for 21 of step 2's 106 "buyable"
> (§7.6 1f, "First live days"). Any time-of-day test must separate
> signals scored on today's bar from those scored on yesterday's
> (`signal_log.bars_as_of` against `signal_date` makes that a column
> comparison).

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
81.0% win, +1.68% avg, +$222.** *(Its band was not confirmed in the first
forward trades: §1, "First out-of-sample look".)*

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

**DESIGN (2026-10-27, for review; migration draft `db/033`, not
applied).** One write at buy, but **not on the position row.**
- **Why not `portfolio.signal_snapshot` / `trades_v2.signal_snapshot`,
  which already exist and are already carried buy → sale.** Size. A
  median EDGE snapshot is **13.7 KB (max 15.2 KB), 91% of it the 126
  bars**; the median `trades_v2` row is 2.8 KB, and the whole table is
  0.82 MB (backup `b4620bc`). Four app reads take `trades_v2` with
  `select('*')` (Sold, the report, two exports). At the observed 11.2
  trades a day, the column would add about 150 KB a day to each of them,
  about 38 MB after a year: the Sold tab on a phone getting about 45×
  heavier to carry data no screen shows. The update path is a second cost
  of the same choice: `signal_snapshot` is in the shared row mapper, so
  every peak-price save would resend 14 KB.
- **Instead, a table of its own:** `signal_snapshot_at_buy`, one row per
  position, keyed by `position_id`. Columns: `position_id` (PK),
  `engine_source`, `captured_at`, `code_version` (the position's own
  value), `bars_as_of`, `snapshot` jsonb, `absent_reason` text.
- **The key had to be added to `trades_v2` (found 2026-10-27, before
  anything was applied).** The draft assumed `portfolio` and `trades_v2`
  already shared `position_id`. **They don't: `trades_v2` has no such
  column.** The portfolio row is deleted at the sale, so as first drafted
  the snapshot could never have been joined to its trade: write-only. So
  db/033 adds `trades_v2.position_id`, written at sale from the
  position's id.
  - **Existing rows stay NULL, never guessed.** Matching on ticker and
    buy date is exactly the match the nine resurrected pairs (one
    position, two sales) make ambiguous.
  - **It's UNIQUE on the non-NULL values.** One position sells once
    (there are no partial sales), so "one position recorded as two sales"
    becomes impossible at the database, not just prevented in the client.
  - **PAYOFF (2026-10-27): the same index is what makes a sale retry
    safe.** It went in as a join key and a structural block on the
    resurrection race. The sale-write fix (`e57769c`) needed something
    else: a failed write after the portfolio row is deleted has to be
    retried, and a write that *looked* failed (a timeout) may have landed.
    Without the index, a retry of that write would record the sale twice.
    With it, the retry comes back "already recorded" and nothing is
    duplicated. Recorded because the usual experience runs the other way:
    a constraint added for one reason turns out to forbid something
    needed later. This one turned out to enable it.
  - **What this design saves, and what it doesn't.** The snapshot itself
    never needs copying at sale, so a copy step that could silently drop
    a 14 KB value is gone. The *key* still has to be written at sale, but
    it's one short value, and its absence is checkable: a post-db/033
    trade with NULL `position_id` is a defect a query finds.
- **Three states, all distinct:**
  - a row with `snapshot` set: the signal Roman acted on;
  - a row with `snapshot` NULL and `absent_reason` (`no_signal`: an Own
    Decision buy, or a second lot of a ticker no longer in the scan):
    known to have had no signal;
  - **no row:** not captured (before this ships, or the write failed).
  A CHECK makes the first two exclusive. Never `{}`, never a guessed
  signal.
- **Write-once by privilege, not trigger:** anon gets INSERT and SELECT
  only, with no UPDATE or DELETE grant, so nothing in the app can rewrite
  what was decided on.
- **What's stored:** a deep copy (JSON round trip) of the `state.signals`
  entry at the moment of the click, i.e. exactly what was on screen:
  the full `scoreStock` output with its bars, `thresholdAtBuy`,
  `buildVersion`, `barsAsOf` and `barsAgeTradingDays`. That's the same
  shape as `signal_log.signal_snapshot`, so the existing re-scoring tools
  read both. A pending order captures at placement (the decision), and a
  later fill never overwrites it.
- **The observer rule:** written after the position insert succeeds. A
  failed snapshot write is logged and never fails, delays or blocks the
  add. It leaves "no row", which is honestly "not captured".
- **The test that matters:** a captured snapshot, re-scored with the
  formula at its row's `code_version.scoring_hash`, reproduces its own
  stored score. That's the property that makes it worth storing, checked
  the same way `derive-step2-thresholds.mjs` re-scores logged snapshots.
- **No backfill.** Only **6 of the 253** EDGE trades since 09-11 have a
  logged signal for the same date and symbol, and that's the logger's
  scan, not the one Roman saw. History stays at the partial re-score
  above. **Collection starts the day it ships**, which is why it goes
  first.
- **Warrior is unchanged for now:** it keeps `portfolio.signal_snapshot`,
  so the two engines differ here, and this records that they do. **They
  converge, on a condition: whichever of the two is touched next moves to
  the shared shape** (`signal_snapshot_at_buy`). A Warrior change to its
  snapshot moves it to the table; an EDGE change that would add to the
  position row goes to the table instead. Neither grows its own copy
  further.
- **Order:** db/033 applied and verified, then the code (one insert in
  `finalizeAddPortfolio`, plus its test), then the path columns, then
  the oversold floor re-tested against them.
- **IT NEVER WROTE A ROW: found 2026-10-28, db/034.** Every insert was
  refused with 42501, "new row violates row-level security policy".
  Supabase enables RLS on tables created in its SQL editor, and db/033 gave
  the table GRANTs but no RLS policy. **db/033's verification checked
  `has_table_privilege`, which RLS doesn't consult, so it passed while every
  write failed.** All 72 positions bought on 10-27 and 10-28 have no
  snapshot, and those already sold can't be recaptured. The failures went
  unseen because a failed snapshot write only reached the console, by
  design (never block the add). Two changes:
  - db/034 adds insert and select policies for anon. Its verification does
    a real insert *as anon* inside a rolled-back transaction, and a probe
    over HTTP must answer 23514 (the CHECK), not 42501 (RLS).
  - Snapshot write outcomes are now counted, with the last error, under
    Settings → App Info, as three states: saved with a signal, recorded
    with no signal on purpose (`absent_reason 'no_signal'`), and failed.
    **The first version had two, and why is worth keeping:** a
    `no_signal` row counted as "saved" because both were "not a failure".
    That's the two-state collapse this project keeps meeting (NULL, `''`
    and 0), one level up from a value: a *classification* with three real
    outcomes squeezed into two, because only one of them was interesting
    at the time. Fixed 2026-10-29, before any `no_signal` row existed.

  **Rule: verify a write path by writing, not by reading privileges.** A
  privilege check, an RLS policy and a CHECK are three independent gates,
  and only an actual insert (rolled back, or one that a constraint must
  refuse) tests all three. The specific trap, and the rule for every new
  table, is in §7.7: a table created in Supabase's SQL editor has RLS on
  and no policy, and a privilege check can't see it.
- **BUILT (2026-10-27).** `captureSignalSnapshot` copies the on-screen
  signal before the add's first await. `recordSignalSnapshotAtBuy` writes
  the row after the position insert succeeds, isn't awaited, and resolves
  false on failure, never throwing. The sale writes `position_id`.
  **Sufficiency is proven, not assumed** (`tests/signal-snapshot-at-buy.test.js`):
  - 60 snapshots captured from live-shaped inputs (last trade ≠ daily
    close) re-score exactly under the formula their hash names, across 17
    distinct scores.
  - 40 of 40 v1 snapshots from the pinned backup find their own formula in
    git (`38a1ceb`, the newest commit carrying it) and reproduce under it;
    31 of them would differ under today's formula.
  - An unknown hash is reported, never replaced by the current formula.
  - The reconstruction is one shared function
    (`scripts/lib/rescore-snapshot.mjs`), also used by
    `derive-step2-thresholds.mjs` (its output is byte-identical after the
    switch).
  - 9 mutations, all caught.
- **Finding: the score is reproducible, `risk` is not.** News no longer
  affects the score. It feeds only `risk`, through `hasRecentNegNews`,
  which compares the headline's age with `Date.now()`. Re-scoring a
  snapshot later reproduces its score, but not its risk: a headline 2h
  old at the buy reads as days old at the re-run. So `riskAtBuy` is a
  clock-dependent value, and any analysis of risk must use the stored
  value, never a recomputed one. Not fixed here (it's in the scoring
  file, under the pinned hash).
- **Pre-existing, noted:** a failed `trades_v2` write is only
  `console.error`'d (`writeTradeToSupabase`); Roman isn't told. With the
  unique `position_id`, a duplicate sale of one position now fails that
  way, which is the intended outcome. A legitimate failure is just as
  silent, as it was before.

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

- ~~**No RSI band predicts the immediate move.** Roman's literal question
  ("does it go up right after I buy") has the answer *nothing in §1
  predicts it*.~~

  **WITHDRAWN 2026-11-02: the generalisation was an absence of data
  reported as a null result.** The rows it was computed on (`signal_log`,
  EDGE, signal_date ≤ 10-21: 676 rows, 19 dates) are **68% scanned in the
  12:00 PT hour**, the last hour before the 13:00 close; 11 of the 19
  dates are noon-only; 06:00–09:59 PT totals 209 rows on at most 6 dates
  (`node scripts/audit-signal-log-hour-coverage.mjs --rev d6e277d --asof
  2026-10-21`; `created_at` is within 0.1 min of `scan_runs.started_at`
  for all 58 EDGE scans). The logger runs on GitHub's scheduler, which
  delivers hours late, so its rows sit wherever the queue landed them.
  - **WITHDRAWN:** "no RSI band predicts the immediate move."
  - **RETAINED, narrowly, and pinned in this sentence:** at 80f52fb (EDGE, signal_date
    ≤ 10-21, 664 rows, 18 dates), among signals scanned in the final hour of the
    session, RSI band did not predict the subsequent move: −0.04 pts at 30 minutes and
    at the close. Still −0.04 for both at d6e277d (676 rows, 19 dates). The table's
    later horizons are as of 80f52fb and have moved as outcomes filled in: +3d is
    +1.23, 11 of 15 dates, there and +1.59, 14 of 18, at d6e277d.
  - **UNMEASURED, and stated as unmeasured:** the 07:00–09:00 PT window,
    where Roman actually buys. Not "no effect". Unmeasured.
  - **The horizons are not independent.** From a noon scan, "+30 min"
    lands at about 12:30–13:00 PT and the same-day close at 13:00, so the
    −0.04 / −0.04 above is nearly one measurement reported twice, not two
    horizons agreeing. The +1 and +3 day figures carry the same skew:
    every horizon is measured from the scan.
  - **What this suspends:** "scoring doesn't predict the immediate move"
    can't justify anything about morning entry selection. Reasoning that
    leaned on it is suspended, not merely qualified.
  - **Not exposed:** the entry-timing work (§3.4, the 07:00–07:29
    window) is computed from `trades_v2` buy times, not logger rows; its
    stated basis and its three scripts (`audit-recording-lag.cjs`,
    `audit-buy-times-vs-tape.mjs`, `audit-after-hours-buys.mjs`) never
    read `signal_log`.
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

**A second, independent piece of evidence (pinned 2026-11-01, `node
scripts/report-forward-test.mjs --rev 0775407`):** in the first 64 forward
trades, RSI 55–65 was n=18, 83% win, +1.43%, against 54% and −1.41% in the
exit-contaminated history. That is consistent with the exit-free
signal_log measure that kept the band at +20, and it comes from a
different source (forward trades, not the log). Small, and one market: it
supports leaving the weight alone, nothing more.

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

**And the volume test reads ONE VENUE (found 2026-10-22).** The
pre-filter's "≥100k shares so far today" uses a snapshot fetched with
`feed:'iex'`. On 2026-10-21's full-day bars IEX carried a median 6.3% of
consolidated volume (range 3.7–27.7%, 15 symbols; `node
scripts/probe-iex-vs-sip-volume.mjs`). So the threshold is about 1.6M
consolidated shares at the median, and its strictness varies sevenfold
between stocks by venue share: ALOY, TDAY and GPGI traded over 1M shares
and were filtered out. The pool is therefore a function of the clock
**and** of each stock's IEX share. Not fixed: recent SIP data is
embargoed 15 minutes on this subscription, so changing the feed is a
decision for Roman, not a patch. Step 1e logs the tested value as
`iex_volume`.

**Measured before deciding (2026-10-22, `node
scripts/measure-prefilter-feed.mjs`; 239 symbols, 7 dates 2026-10-13 to
10-21, medians, rebuilt from 1-minute bars).** The proposal is full-market
(SIP) cumulative volume, lagged 15 minutes, as a lower bound, with price
unchanged. Pass counts:

| PT | live (IEX ≥100k) | proposal (SIP, T−15m) | SIP at T (reference) |
|---|---|---|---|
| 06:35 | 2 | **0** | 32 |
| 06:40 | 3 | **0** | 43 |
| 06:45 | 3 | 18 | 48 |
| 07:00 | 6 | 48 | 60 |
| 07:28 | 12 | 74 | 83 |
| 07:30 | 13 | 76 | 84 |
| 08:00 | 17 | 94 | 100 |
| 10:00 | 31 | 123 | 124 |
| 12:00 | 42 | 135 | 136 |

- **The switch is a different app.** Around 07:30 the candidate pool goes
  from about 12 symbols to about 75, and from about 31 to 123 by 10:00.
  Roman should see these numbers before it changes under him.
- **The lower bound bites hard in the first 15 minutes.** A 15-minute
  lag reaches back before the open, so from 06:30 to 06:44 the proposal
  passes **nothing**, worse than IEX's 2–3. By 07:00 it excludes 14
  names that real volume would pass, 6 by 08:00, and 1–2 from 10:00. That
  is exactly the window §3.4 flags, so the proposal as stated would
  empty it rather than measure it.
- **Calibration:** the rebuilt live rule matches 15 of 16 real logged
  scans to within 1–3 symbols (consistently a little stricter, mean −2.5).
  The 16th, 2026-10-16 at 06:30 (56 logged, 14 rebuilt), was taken within
  the first minute, while the live snapshot still held **yesterday's**
  daily bar, so at the open the live filter passes yesterday's liquid
  names. That's another clock artifact in the live rule, and minute bars
  can't reproduce it.
- **Not decided.** The existing filter stays, with rejections now logged.

**The real problem: today's cumulative volume is the wrong variable for
a liquidity gate (Roman, 2026-10-22).** At 06:35 there have been five
minutes of trading, and no feed, lagged or not, can say from that whether
a stock is liquid. The variable is undefined early in the session by
construction, which is why every version of the filter is a function of
the clock. (The 10-16 06:30 scan, still on yesterday's full-day bar, was
accidentally doing the right thing for one minute.) So the filter's two
jobs are split:
- **Liquidity gate:** *trailing* average volume, which is
  clock-independent, venue-independent (SIP, completed days only, no
  embargo) and defined at 06:30 as well as at 12:00.
- **Unusual activity today:** this belongs in the score (the volume
  terms), not in a pre-filter deciding what the engine may look at.

If the pool stops depending on elapsed volume, it stops being a function
of the clock, and §3.4 becomes testable instead of unfalsifiable.

**Measured (`node scripts/measure-prefilter-trailing.mjs`; SIP daily bars;
22 evaluation dates 2026-09-22 to 10-21, each on its prior 20 sessions;
$1–$20 on the prior close; 4 symbols lack 20 sessions and are not
evaluable).** The "keeps" column is the share of the 84 symbols the live
filter ever let through (EDGE `signal_log` at `de95a93`):

| floor | passes (min / median / max of 239) | median day-to-day change | keeps |
|---|---|---|---|
| 100k shares | 154 / 164 / 170 | 4 symbols | 83 (99%) |
| 250k shares | 137 / 143 / 146 | 2 | 83 (99%) |
| 500k shares | 115 / 119 / 122 | 2 | 82 (98%) |
| 1M shares | 84 / 88 / 91 | 2 | 76 (90%) |
| 2M shares | 50 / 58 / 59 | 1 | 50 (60%) |
| $1M a day | 141 / 147 / 150 | 1 | 81 (96%) |
| $5M a day | 91 / 95 / 99 | 1 | 72 (86%) |

- **The stability test passes:** 1–4 symbols move per day at any floor,
  and the count is identical at every scan time by construction.
- **Intent:** "100,000 shares" as a 20-day consolidated average passes
  about 164 symbols, all day. The live filter's *effective* strictness
  (about 1.6M consolidated, §7.3 above) corresponds to roughly a 1M floor,
  about 88 symbols. Close to the set it has actually let through (84
  distinct over 19 dates), but stable all day instead of 2 at 06:35 and
  42 at noon.
- **Cost:** SIP daily bars for 239 symbols are 3 requests, fetched once
  per day (completed sessions don't change intraday). Scoring a bigger
  pool costs more bars and news requests per scan, to be measured with
  the number.
- **Number not chosen:** it's to be set from the logged rows under the
  new variable, once that's built.

**Scans now record their trigger (db/030, 2026-10-22).** A hand-dispatched
scan was indistinguishable in `scan_runs` and `signal_log` from a
scheduled one; the only trace was in `workflow_runs`. `scan_runs.trigger_type`
holds `schedule` / `workflow_dispatch` / `local`, so a dispatched scan is
excludable by construction. This is the general form of the FORCED_TEST
lesson, without a third session value. Earlier rows stay NULL; the two
known dispatched scans are named in db/030.

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

> **ROMAN: one broker export answers four open questions.** One export
> of every fill (symbol, side, quantity, price, date, time) since
> 2026-08-01. Until it arrives, **all four stay written off, not
> guessed**:
> 1. **The 24 Sunday (CLOSED-session) orders:** when did each fill, and at
>    what price? They stay `not-measured` (§5) until the export says.
> 2. **The nine resurrected pairs** (GPGI, HTZ, VISN, RR, TDAY, GO, CXM,
>    SOUN, SNXX): one position recorded as two sales. Which sale of each
>    pair is real? The book reads −$682.93 keeping each first sale, or
>    −$644.23 keeping each second (below).
> 3. **The 17 dead-stock trades** (AREN ×3, TWO ×3, HLX ×3, GBTG ×2, BRR
>    ×2, ATAI, CCRN, DOMO, LC): recorded after each stock had stopped
>    trading, at its last close, sold back at the same price. Did any of
>    them execute at all? (§7.6 step 1e½.)
> 4. **NEOG, bought 2026-08-19 at $12.30 (25 shares, recorded 14:12 PT,
>    AFTER_HOURS):** a recorded buy with no market support (added
>    2026-10-27). Same family as question 3, one row instead of seventeen.
>    **Not a date error (2026-11-02):** $12.30 is outside NEOG's full-day
>    SIP range on 08-19 and on each of the five trading days before it
>    (`SIDE=buy scripts/audit-sell-dates-vs-tape.mjs`, the only buy of 405
>    to fail), so moving the date can't explain it. That strengthens
>    "the limit price was entered, not the fill": ask whether it filled,
>    and at what.
>    NEOG never traded at $12.30 at any time that day; the day's high was
>    $12.255, 4.5¢ below it. Three explanations were checked and ruled out:
>    - **not an off-by-one date:** 08-18 ranged 11.49–11.895 and 08-20
>      ranged 11.725–12.18;
>    - **not a transposition:** none of that day's other buys (RR, ABR, AMC,
>      ALT) traded near $12.30;
>    - **not a split artifact:** raw and adjusted bars are identical.
>    The pattern, a price just above the day's ceiling, reads like a limit
>    price entered in place of the fill, which only the export can settle.
>    The sale side is supported ($11.75 traded on 09-03 at 06:41). Until
>    then the row's −$13.75 P&L rests on a buy price nobody observed.

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
   entries 7:00–7:30 PT (**a precaution, not a finding:** its evidence
   is confounded by pool size and the IEX venue artifact, see §3.4). Time-and-place rules, no prediction. Evaluated
   at view time, not scan time. EDGE only. 6:30–7:00 and PRE_MARKET are
   open and logged. Recording stays open, with no confirm: inside a gate
   window the footer is the ordinary "+ Add to Portfolio" (the confirm
   that once stood here was removed 2026-10-27, §7.7); whether a
   trade was placed inside a gate window is derived on read from
   `buy_date`/`buy_time`, not stored. The DAY-suppression button
   (disabled "+ Add to Portfolio" after 10:00 PT) is fixed the same way.
   - **PRE-COMMITTED (2026-10-28): when the 07:00–07:30 gate is
     reconsidered.** **When 30 or more forward trades (`code_version`
     set) have been placed inside 07:00–07:30 PT, across at least 8
     distinct trading days, the window is re-derived against the
     historical 70** (§3.4's bucket: `trades_v2` at `b4620bc`, the 270
     rows without `sell_price_unverified`). Before that, it stands.
     - **Why day-clustered:** trades bought on the same morning share
       that morning's market, so a cluster of them is one observation,
       not many. The first forward trades inside the window all came
       from a single morning (10-28); that is one data point, however
       it turned out.
     - **Why written down now:** the gate is advice, Roman overrides it,
       and overrides that win are memorable. Without a criterion fixed
       in advance, the decision gets made by whichever anecdote is most
       recent. An override that wins doesn't count toward reversing the
       gate; only meeting the criterion does.
     - **The count:** `node scripts/report-forward-test.mjs --rev
       <backup>` prints the trades inside the window and their distinct
       days, with the criterion and whether it's met.
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
1e½. **Stale price history is marked and not buyable** (db/031, built
   2026-10-22, ahead of the gate so the gate's effect can be measured on
   clean signals). 32 of 676 logged EDGE signals (4.7%, backup `de95a93`)
   were scored on daily histories more than one trading day old, nine of
   them SHOWN. Those nine are one stock, **PSKY, shown as a SOFT BUY
   (score 80) on 8 days from 10-09 to 10-20 on bars ending 10-05**
   (corrected 2026-10-22: "09-15" was read off the first PSKY row, a
   09-15 signal on that day's own, current bar, and was wrong). PSKY's
   full-market history stops on 10-05 and Alpaca no longer lists it; it
   was still SHOWN on 10-21 and 10-22. It was **never traded**: no row in
   `trades_v2` or `portfolio`. A third stale symbol, CCO (history stops
   10-14), was stale on 5 signals through 10-22.
   **AREN had stopped trading:** its last session on either feed was
   2026-08-28 (16.9M shares, a final day), and Alpaca no longer lists the
   asset. Its IEX snapshot's "today" bar stayed frozen on that day's 131k
   shares, so it passed the "≥100k today" pre-filter on every scan for six
   weeks and was scored on that frozen history. **The three AREN rows in
   `trades_v2` (bought 09-29, 10-02 and 10-05, 950 shares at $1.10) cannot
   be executions.** They're distinct rows (not the resurrection race),
   with the buy price equal to the last close and `sell_price_unverified`
   set (the sale price was filled in from the buy price, so P&L is exactly
   $0.00). **Written off from every analysis, pending Roman's broker
   export**, the same treatment as the §7.5 duplicates. Two consequences:
   - **Any `pnl > 0` analysis counts them as losses.** The app's report
     excludes unverified sales (db/026); an ad-hoc analysis that doesn't
     filter `sell_price_unverified` includes three fabricated zeros.
   - **Their stored entry inputs are August's:** RSI 17.42, volume ratio
     9.53 and MA distance −12.50% are identical on all three buy dates,
     because they come from one frozen history. So they sit in the RSI < 35
     bucket (the term step 2 neutralised) as three losses that were never
     trades.

   Nothing marked any of it.

   **It isn't just AREN: 17 of the 22 unverified sales are trades on stocks
   that had already stopped trading (found 2026-10-22).** Each unverified
   trade (db/026) was classified by the stock's last full-market (SIP)
   session against its buy date:
   - **Dead at buy (17):** AREN ×3, TWO ×3, HLX ×3, GBTG ×2, BRR ×2, ATAI,
     CCRN, DOMO, LC. Each has the buy price equal to the stock's last
     close and the sale price filled in from the buy price ($0.00). These
     **cannot be executions**. They're positions recorded on dead stocks,
     most likely from stale signals. That's 17 of 292 rows (5.8%) in
     `trades_v2`, **written off pending Roman's broker export**, alongside
     the §7.5 duplicates.
   - **Died during the hold (1):** ATAI bought 2026-09-11, its last
     session. A real trade with an unknown exit.
   - **Traded through the sale (4):** PLUG, ARRY, JPC, and CCO bought
     10-01. Real trades whose sale quote was missing.

   The 2026-10-21 appendix parse kept the 22 unverified out of its
   win/loss counts (149 / 121 / 22), so its win rates exclude them. Any
   analysis that counts `n` from `trades_v2`, or tests `pnl > 0`
   without filtering `sell_price_unverified`, includes 17 trades that
   didn't happen. **TWO** (Two Harbors, last session 2026-08-24, inactive)
   was held in the app across those dates with nothing looking at it,
   which is the held-position gap in step 1f.

   **The universe needs a liveness pass.** `STOCK_UNIVERSES.OTHER` is a
   committed static list that has never been pruned: 14 of its 239 symbols
   are dead, so the engine has been scoring delisted stocks all along. The
   per-scan asset check (1f) is a mitigation; pruning the list is the fix.
   - **Recorded:** each signal carries `barsAsOf` (newest bar date) and
     `barsAgeTradingDays`, stamped by the code that calls the scorer, not
     inside `scoreStock` (whose source is the pinned formula hash). It is
     stored on `signal_log.bars_as_of` (backfilled exactly from each row's
     own stored bars) and carried buy → sale as `bars_as_of_at_buy`.
   - **The rule:** older than one trading day (today's partial bar or
     yesterday's is current) means not buyable, saying "Scored on price
     history from <date> (N trading days old)". It's advice only;
     recording stays open. Trading days come from the holiday-aware
     `tradingDaysBetween`; `businessDaysBetween` counts weekdays and
     would flag every signal on the day after a holiday.
1f. **Liquidity gate on trailing volume (BUILT 2026-10-22, floor 1M; see "As built" at the end of this step).**
   It replaces the volume half of the EDGE pre-filter, which today means
   "IEX volume so far today ≥ 100k" (§7.3), in **both** `app.js`
   `runScreener` and `scripts/log-signals-edge.mjs`, through one shared
   function (they're two copies of one rule today).
   - **Rule:** price $1–$20 (live price, unchanged), and the **average
     consolidated (SIP) share volume over the last 20 completed sessions**
     ≥ FLOOR. Shares or dollars, and the FLOOR, are set later from
     measurement.
   - **Data:** SIP daily bars ending **yesterday** (completed sessions only:
     no partial day, no embargo), `adjustment=all`. Fetched once per day
     for the universe (239 symbols, about 3 requests) and cached for the
     day. The live price comes from the snapshot already fetched.
   - **Reuse, not a copy:** `core/universe.js` `_getSip30DayAvgVolume`
     (Warrior's relative-volume baseline) already fetches SIP daily bars and
     caches an average daily. The bar fetch becomes one shared helper with
     a `completedOnly` option; Warrior's call keeps its current semantics
     exactly (an equivalence test). **Finding:** that function
     has no end date, so during market hours its 30-day average includes
     today's partial session, which makes Warrior's baseline mildly
     clock-dependent. **Fixed with the gate (Roman, 2026-10-22):** the
     shared fetch's completed-sessions-only option is the fix for both;
     the equivalence test shows the request and arithmetic are unchanged
     apart from dropping today's bar.
   - **Only listed, tradable assets, in TWO places (2026-10-22).** 14 of the 239
     universe symbols are dead: AREN, CCO, EEX, GETY, HCWC, KORE, ORGN,
     PSKY, SBEV and WALD are not on Alpaca's active list, and DRCT, FLZH,
     GDC and XXII are active but not tradable. The gate excludes them
     using the asset list `core/universe.js` already fetches and caches
     daily for Warrior (`_getAssetIndex`), with no second fetch. They're
     logged as `asset_inactive` / `asset_not_tradable`. A dead stock
     whose IEX bar froze on a heavy final day otherwise passes forever
     (AREN, PSKY, CCO).
     **And over open positions:** the same listed/tradable test runs on
     every held position, **surfaced on the position card** ("Two Harbors
     is no longer listed — this position cannot be sold at a market
     price"), never silently. The universe check stops a buy of a dead
     stock; the position check says that one already owned has died. TWO
     is that second case: held across six weeks with nothing in the app
     looking at it.
   - **Recency is part of the rule (found via AREN, 2026-10-22):** the 20
     sessions must end at the **previous trading day**. A stock that
     stopped trading keeps a heavy trailing average indefinitely (AREN's
     last 20 sessions all predate 08-28). Without this, the gate would
     pass a dead stock exactly as the IEX-today filter did.
   - **Not evaluable:** fewer than 20 completed sessions, or a failed
     fetch, means the symbol is **rejected and logged** as
     `no_volume_history` / `volume_history_unavailable`, never passed on a
     guess. If the whole daily fetch fails, the scan still runs (the
     observer must not break the observed): it falls back to the current
     IEX-today rule, and that scan records which rule it used.
     Recording the rule needs `scan_runs.prefilter_rule` (db/032, applied:
     `trailing_sip_avg` / `iex_today_fallback`, with parameters).
   - **Rejection logging** carries over: `failed` gains
     `avg_volume_below_min` and the row gains `avg_volume_20d`.
   - **Unusual activity today stays in the score** (the volume-ratio and
     volume-spike terms). The gate no longer decides on it.
   - **What it changes:** the pool stops being a function of the clock, so
     §3.4 becomes testable. Scans score more symbols (about 88–164 instead
     of 2–42), which costs more bars and news requests per scan; that is
     measured with the number.
   - **Sequence (Roman):** this design, then the buyable-count-per-day
     measurement under the new universe, then the number.
   - **As built (2026-10-22, held for review).** `core/universe.js`:
     `runEdgePrefilter` (both fetches, the rule, candidates and
     rejections), `edgePrefilterFailures` (the one predicate),
     `getEdgeLiquidity` (20 completed SIP sessions over a 45-calendar-day
     window, cached per PT day), `getAssetListing` (from the one 24h asset
     list) and `_fetchSipDailyBars` (shared with Warrior's
     `_getSip30DayAvgVolume`). Called by `app.js` `runScreener` and
     `scripts/log-signals-edge.mjs` alike; the logger writes
     `prefilter_rule`. Differences from the design above:
     - **Recency comes from the tape, not the calendar.** The 20 sessions
       must reach the newest completed session any universe symbol has,
       recorded as `requires_through`, with the HOLIDAYS-based
       `previousTradingDay` beside it as a cross-check (a warning when
       they differ). Reason: **`core/clock.js` HOLIDAYS ends at
       2026-12-25.** With a calendar rule, the first 2027 holiday
       (01-01) would make every symbol "stale" the next trading day and
       empty the pool. That table needs its 2027 dates; it's a separate
       item, and this rule no longer depends on it.
     - **Rejection names:** `asset_inactive`, `asset_not_tradable`,
       `no_volume_history` (fewer than 20 sessions, or a session without
       a volume), `volume_history_unavailable` (that symbol's fetch
       failed), `avg_volume_below_min`, `volume_history_stale`, plus the
       existing price tests and `no_snapshot`. Rows gain
       `avg_volume_20d` (SIP) and `volume_history_through`.
     - **Failure handling:** no daily bars at all → the old IEX-today rule
       (`iex_today_fallback`, with `reason`); some symbols lost →
       those are rejected, and the rule carries
       `volume_history_failed_symbols`; no asset list → the listing test
       is skipped and the rule says `requires_listed_tradable: false`
       with `asset_check_unavailable`. The app's scan line says so too.
       `settings.minVolume` is now only the fallback's threshold
       (relabelled in Settings).
     - **Held positions:** one list-based lookup over every holding, a
       banner on the card when a holding isn't listed or isn't tradable,
       and the intraday line reads INACTIVE. The per-ticker
       `/v2/assets/{ticker}` check stays only as the fallback: it 404s
       on a removed symbol (AREN), which it couldn't tell from a
       connection failure, so it never flagged one.
     - **A dead holding's price: three states, recorded as such.** Until
       2026-10-22 it was an *undiscovered* instance of the "number nobody
       computed" family (instance twelve's shape: the Portfolio Summary
       showing +$0.00 beside cards marked unavailable). TWO's card showed
       "Now" at its last trade, with P&L and a recommendation computed from
       that frozen close. At `587fe33` it became a *known* instance **left
       in**: the banner said the price wasn't live while the number beside
       it still read as one. That's a different and worse thing, because
       Roman reads the number, not the banner. **Fixed next**, with no new
       logic: a holding that isn't listed or isn't tradable sets the
       existing `priceUnavailable` flag, so P&L reads unavailable, the
       summary names it rather than summing it, the recommendation is
       CANNOT EVALUATE, Mark as sold isn't pre-filled, and the banner says
       why. **Same family, fixed 2026-10-23, before Warrior's first live
       use:** a Warrior holding's card asked `evaluateExit(p, { price:
       currentPrice })` on the buy-price fallback or a dead stock's last
       trade, without consulting `priceUnavailable`. Passing null wouldn't
       do, because `evaluateExit` answers a missing price with HOLDING,
       which is still a verdict. So with the flag set, the shell doesn't ask
       the engine and shows CANNOT EVALUATE, in the same style as EDGE's.
       The nav badge's own engine call was already safe through the flag:
       the card drops the cached price, and the badge skips a holding
       without one.
     - **The calendar is guarded, not noted (2026-10-22).** HOLIDAYS ended
       at 2026-12-25, and it feeds `classifySession`, `getMarketStatus`,
       `tradingDaysBetween` (the stale-bars age) and every trading-day
       walk, so on 2027-01-01 the app would have treated a closed market as
       open. 2027's closures and early close were added from Alpaca's
       `/v2/calendar`, which also showed that **2025-01-09** (the national
       day of mourning for President Carter) was never in the table.
       `tests/calendar-horizon.test.js` now fails whenever HOLIDAYS'
       last date is less than 90 days ahead, or EARLY_CLOSES stops short of
       HOLIDAYS' last year.
       **The table was never complete, not just short.** A horizon guard
       catches the end but not a hole in the middle, and 2025-01-09 was a
       hole for almost two years. **`node scripts/check-market-calendar.mjs`**
       (committed 2026-10-26) diffs HOLIDAYS and EARLY_CLOSES against
       Alpaca's `/v2/calendar` for every year each table covers, and exits
       1 on any difference. Run it whenever the horizon guard fires, so
       that adding next year also verifies the years already there. (A
       test can't call Alpaca, which is why it's a script.) It was first
       run by hand on 2026-10-23 and its output went into the table as
       data. Until it was committed, that was four years of entries backed
       by a command nobody could re-run, the same "run once and discarded"
       shape this section exists to stop. Result on 2026-10-26: HOLIDAYS
       matches for 2024–2027 and EARLY_CLOSES for 2026–2027. 2024–2025's six
       early closes are absent by decision (no stored data predates 2026)
       and print as NOTEs, not errors. Checked against three mutations
       (a missing holiday, an extra one, a wrong early-close value), all
       caught. The guard's failure message names the command.
     - **No list is "unknown", whatever form it takes.** An absent cache,
       a malformed one (whatever localStorage hands back), a `/v2/assets`
       response that isn't a list, and a short list all end as "listing
       unknown", recorded on the rule. None becomes an empty set, which
       would mark every symbol delisted, and none is kept as the cache.
       Before this, a fresh-looking cache whose `assets` wasn't an array
       raised a TypeError that `runEdgePrefilter` rethrows as a programmer
       error, which would have stopped the scan.
     - **The fallback's volume control is read-only** in Settings, with
       the reason. It was relabelled but still clickable, a control that
       changes nothing on almost every scan.
     - **Add confirm:** the same lookup; a not-listed or not-tradable
       ticker gets a warning with "Add anyway", beside the after-hours
       warning, and never blocks.
     - **First live days (10-23 and 10-26, five scheduled scans, all
       `trailing_sip_avg`, none on the fallback).** Pool 80, 80, 79, 79,
       79. **Buyable (SOFT+ ≥65): 0 and 0.** The top stored score on
       either day was 55. SHOWN per (date, symbol): 27 on 10-23 (price
       mix $1–3/$4–9/$10–20 = 2/14/11) and 42 on 10-26 (7/17/18), all in
       the WATCH band. Same counting as step 2's derivation: one per date
       and symbol, highest stored score. signal_log keeps one row per
       (date, symbol, tier), so a symbol that rises after its first SHOWN
       row isn't re-recorded and per-day counts are lower bounds. The
       106 baseline was counted the same way, so the comparison is
       like-for-like. What this does and doesn't say:
       - **Step 2's target was a third artifacts.** "106 over 19 dates"
         (5.6/day) reproduces exactly at `de95a93`, but 14 of the 106 are
         dead stocks (PSKY on every date from 10-09) and 21 are
         open-minute scans scoring on yesterday's bar (10-16 alone gave
         20). **Real: 71, or 3.7/day.** So the lines were derived to hold
         a rate a third of which never existed.
       - **The drop predates the gate.** Real buyable per date was 2–12
         from 09-11 to 10-09, then 2, 2, 0, 3, 1, 0, 0, 0 from 10-12 to
         10-21, and 1 on 10-22 (NWL 65, the old pool's last day). 0 and 0
         continue that, they don't break it.
       - **The floor isn't the cause.** The 1M 20-session floor, applied
         to each of the 71 real buyable signals as of its own date, keeps
         70 (99%), the same rate as the WATCH band (98%) and below it
         (100%).
       - **The projection tool was broken past 10-21, now FIXED
         (2026-10-27).** Re-run on the gate days, `measure-gate-buyable.mjs`
         first reproduced only 36% of these scans' stored scores (mean
         |diff| 11.1 points), against 91% on the window it was built on.
         The cause wasn't fitting: **both daily fetches ended at a
         hardcoded `end: '2026-10-21'`**. Run for 10-23, the rebuild had no
         10-22 bar, so SPY's change spanned two days (−1.64% rebuilt
         against −0.44% stored), every history was one bar short (125
         against 126), and RSI and up-days missed a day. Fixed: the history
         ends at the last date measured (SIP at its previous trading day,
         which the plan allows), and the tool **refuses to run** if SPY's
         history doesn't reach each date's previous trading day. A second
         gap, between the tool and the gate: its trailing pool tested the
         average but not recency, so it passed PSKY (dead) in every slot.
         It now applies the gate's recency rule. It still can't apply the
         listed/tradable test, because that flag has no history. **After
         the fix: 93% exact on the gate days (mean |diff| 0.7), and 90% on
         the original window (1.0).**
       - **Corrected projection at 1M:** **2 on 10-23 (CLF, HUN) and 4 on
         10-26 (HUN, ANGX, GOGO, TROX).** All of them at 10:00 or 12:00
         except HUN at 07:00 on 10-26. The floor-decision window
         (10-13..10-21) becomes **4 a day, 36 in total** (was 5 and 43:
         PSKY was in every slot). The decision rested on continuity, so
         it stands; the 5/day it cited is now 4.
       - **So the stored zeros are mostly the scan schedule, not the
         market.** No EDGE scan ran after 07:22 on Friday or after 09:06
         on Monday: the delayed and dropped crons already on record. The
         projected buyable signals fall in the hours no scan covered.
         Where scans did run, stored and projected agree (CLF 55, TROX 55
         and HUN 45 stored, all below 65). **Stored signal_log rows can't
         measure buyable per day while scans don't cover the day.**
       - **Not concluded:** whether the lines are too high. That's
         pre-committed below, not left to judgement.

     - **THE BOTTLENECK HAS MOVED: scan coverage, not scoring or the gate
       (2026-10-27).** On 10-23 and 10-26 signals qualified at 10:00 and
       12:00, and nothing scanned then. The GitHub cron delay that db/023
       was built to measure has gone from a measurement nuisance to the
       binding constraint on the app's usefulness. **First evidence from
       `workflow_runs`** (198 rows, 10-09 to 10-26, scheduled deliveries
       only; each delivery matched to the latest unused declared instant
       before it):

       | workflow (declared UTC) | due | delivered | dropped | delay min / median / max | lands (PT) |
       |---|---|---|---|---|---|
       | Log EDGE signals (6 crons, 07:30–09:40Z) | 66 | 66 | 0 | 271 / ~320 / 590 min | 05:40–07:37 normally; to 09:37 on slow days |
       | Capture movers (13:45–15:00Z) | 44 | 44 | 0 | 215 / ~255 / 487 min | 10:41–13:27 |
       | Fill outcomes (20:30, 21:30, 23:00Z) | 33 | 32 | 1 | 111 / ~155 / 342 min | 15:58–18:19 |
       | Backup tables (06:00Z) | 17 | 17 | 0 | 229 / 283 / 461 min | 02:54–04:41 |
       | Build float table (Sun 08:00Z) | 3 | 3 | 0 | 257 / 291 / 389 min | 05:16–07:29 |
       | Log Warrior signals (every 15 min, 13–20Z) | 384 | 25 | 359 | 2 / 12 / 160 min | scattered |

       - **EDGE's scheduled scans cover roughly 06:30–07:37 PT:** the
         first hour, which §3.4 rules out for entries. They miss the
         07:30–11:00 window the data supports. Deliveries before the open
         are the 40 no-ops (the scan gate skips them). Nothing is
         dropped; it's all *late*, and the lateness shrinks later in the
         UTC day (about 5.3h at 07:30–09:40Z, 4.2h at 13:45–15:00Z, 2–3h
         in the evening). That pattern is the evidence for re-aiming; the
         workflow's own header asked for exactly this check after a week.
       - **DST, 2026-11-01 (dated, inside the 10-day count):** ET and PT
         both fall back, so the same UTC deliveries land an hour earlier
         in PT wall clock, about 04:40–06:37 PST, nearly all before the
         open. **From Monday 11-02, almost no scheduled EDGE scan lands
         in market hours unless the crons move.** The header already says
         to shift every entry +1h at that point; with this data, the shift
         should be a re-aim at the 07:30–11:00 window instead.
       - Warrior's 25 of 384 is a different shape (a frequent cron, almost
         all dropped); the slot matching is approximate for it.
       - **RE-AIMED 2026-10-27** (arithmetic in each workflow's header).
         Model: Tue–Fri median delay per declared cron, least squares over
         the ten crons declared 07:30–15:00Z: `delay = 412.7 − 11.19 ×
         declared_hour` minutes, with a spread around each median of −26 /
         +132 min (p10/p90). Mondays ran +113 min later (only 3 Mondays,
         so not special-cased). The declared times are solved from target
         landings in PST:
         - **EDGE:** 8 slots, 10:35, 11:15, 11:50, 12:25, 13:05, 13:40,
           14:15 and 14:55Z, landing 07:30 to 11:00 PST every 30 min.
         - **Warrior:** cut from 32 a day to 9. Seven modelled slots
           (09:20, 09:40, 10:04, 10:15, 10:30, 10:55 and 11:10Z) land
           06:30 to 08:00 PST every 15 min; 10:04 is off the round hour,
           the most contended minute. Two **Monday-insurance** slots at
           07:32 and 08:20Z are declared at the old EDGE slots' *measured*
           times, not the model. On the three late Mondays those landed
           about 06:55 and 07:40 PT; on other days they land before the
           open and no-op. A +113-min Monday would otherwise put every
           Warrior slot past 08:00, on Roman's strongest day and the day he
           starts Warrior.
         - **We expect this schedule to be wrong, and a week of
           `workflow_runs` will correct it.** Five of EDGE's eight and five
           of Warrior's modelled seven sit in 09:40–13:45Z, where nothing
           has ever been declared. That's a line drawn between two islands
           of data, not interpolation inside a sampled region. Its first
           job is to be falsified, not defended.
         - **The islands are different workflows, a confound that can't be
           ruled out.** All six early points are the EDGE logger and all
           four late ones are the movers capture. Re-fit on EDGE's own six
           points, the line is 412.6 − 11.20 × h (declared times move by
           at most a minute), and it predicts the movers island within 6
           min. That's consistent with an hour effect, but a workflow
           offset that happens to match it would look the same. The
           movers' own four points (75 min of declared range) give a
           steeper −17.4/h, which would put the early slots about 35 min
           earlier.
         - **Oversampling is intentional.** With −26/+132 min around each
           median, EDGE's eight slots spread across roughly 07:00–13:00 PST,
           with three to five expected inside 07:30–11:00. Nothing reads a
           slot as a scan time: `declared_cron` is used only by the
           instrumentation, and scans are timed by `scan_runs.started_at`
           and `signal_log.first_shown_at`. A landing before 07:30 is
           harmless, because the entry gate blocks buying, not scanning.
         - **The spacing question, answered:** two deliveries 40 min apart
           both scan. But deliveries *bunch*: EDGE slots declared 25 min
           apart landed a median ~14 min apart (4–56), and 23 of 66 were
           skipped as within 30 min of a scan that did run. Those cost scan
           count, not 30-minute coverage. What would have silently halved
           coverage is the *new* Warrior schedule, whose 15-min slots meet
           the shared 30-min rule. So spacing is now per engine: EDGE 30,
           Warrior 15 (`scan-gate.mjs` `SPACING_MIN_BY_ENGINE`).
         - **Report after one week, per slot, Mondays broken out first:**
           delivered against declared, and landing time, for every slot. For Warrior, if cutting
           density raises the delivered *rate*, that contradicts the
           "fire often, need many chances" premise its schedule was built
           on (2026-09-11). It gets stated as a finding, so the same
           mistake isn't available the next time something looks
           unreliable.
       - **The browser's scan is the only thing covering 10:00–12:00, and
         it writes nothing.** When Roman opens the app at 10:30, the scan
         he sees runs `runEdgePrefilter` and scores the same way, but
         leaves no `scan_runs` or `signal_log` row. **So his experience may
         be fine while the logged record shows zeros, and nothing stored
         can tell the two apart.** That's the browser-path blindness noted
         below, now with a cost attached: the stored record and the app
         can disagree about whether anything was buyable, and the stored
         record is what every analysis reads. Reported, not fixed here.

     - **THE FIRST FORWARD-TEST TRADES (2026-10-27 and 10-28). Read their
       results with all of the following in view.** These are the first
       trades recorded with `code_version` (all 64 sold on those two days,
       plus the 8 still open), so they are the first forward test of step
       2's scoring, the entry gate and the 1M liquidity gate together.
       - **They have NO signal snapshot.** Every write to
         `signal_snapshot_at_buy` from 10-27 to 10-28 was refused by
         row-level security (db/034). All 72 positions lack one, and the
         sold ones can't be recaptured. Their entry inputs are only the
         stored per-position fields (§5), not a re-scorable snapshot.
       - **Size and turnover changed, and not by the same factor.** Per
         trade, positions are about **1.5x** the historical size (median
         cost $572 against $371 over the 292 earlier trades; mean $617
         against $408). The **~9x** is capital deployed at once against the
         $1,500 configured budget ($13,788 on the morning of 10-28). The
         larger change is turnover: 64 round trips in two days, $32,145
         bought on 10-28 alone. The historical expectancy (**−$2.53** per
         trade over the 270 verified rows; an earlier −$2.34 came from a
         stale dataset and is withdrawn) was measured at the old size and
         pace. Per-trade results
         scale with the 1.5x; daily and book-level results with the
         turnover. They aren't comparable to the history without saying
         which.
       - **The report:** `node scripts/report-forward-test.mjs --rev
         0775407` (the 10-29 backup; the 10-28 one, e582d87, holds only
         14 of the 64). **Pinned 2026-11-01. No figure changed between
         the live read of 2026-10-29 02:43Z, which was quoted to Roman as
         provisional, and the backup:** every count, rate, total, window,
         band and gap is identical, and only the order of tied rows in
         two listings differs. So the live read was safe to reason from;
         that is a finding about this read, not a licence for the next
         one. Caveats that travel with the figures: two trading days, both up days
         for small caps (IWM +1.15% and +0.40% close to close, SIP bars, pinned in
         the report; an ad-hoc IEX fetch first gave +1.17% for 10-27);
         the two-current-scores defect and the double-fire window were
         both live (fixed 2026-10-28); and 60 of 64 resolved the same day,
         against 86 of 270 in the baseline, so a comparison of the whole
         books is mostly a comparison of holding periods.
       - **THE +$352 IS HOLDING PERIOD, NOT SCORING.** The forward book
         made +$351.70 over 64 trades (71.9% win, +$5.50 a trade) against
         the baseline's −$684.33 over 270 (55.2%, −$2.53), and none of that
         difference is evidence for step 2. **On same-day trades the
         forward book is slightly worse than the history:** 73.3% win
         against 79.1%, with the same average return (+1.02% against
         +0.94%). **[DEFINITION, 2026-11-02:** 79.1% of 86 is CALENDAR
         same-day (buy_date = sell_date). The app's hold function
         (holdSpan, 0 closes) puts 107 of the 270 in that bucket at 71.0%:
         the 21 extra are Sunday orders sold Monday, 8 of them winners.
         Which definition the forward book's 73.3% used is not recorded, so
         "slightly worse than the history" is unconfirmed until both are
         computed one way (`scripts/rederive-hold-length-finding.mjs`).**]** The whole difference is composition: 60 of the 64
         forward trades (94%) resolved the same day, against 86 of 270
         (32%) in the baseline, whose loss is carried by its 184 overnight
         holds (−$1,025.60). The smaller average loss (−2.00% against
         −4.58%) is the same effect: a same-day loser has no time to grow.
         **Roman changed his behaviour in the direction his own n=292 data
         already pointed, and that is what the money came from.** Holding
         period is his decision, not the scorer's.
       - **What it says about the shipped rules** (each recorded where the
         rule is, too): RSI 45–55, the project's only entry finding, was
         **not confirmed** (n=19, 63% win, +0.48%, against 72.7% and
         +0.86%; §1). RSI 55–65 did well (n=18, 83%, +1.43%, against 54%
         and −1.41%), a second, independent piece of evidence for leaving
         it at +20 (§7.3). Oversold buys (RSI <35) fell from 72 of 270
         (27%) to 6 of 64 (9%): the one place step 2's mechanism shows
         directly, and the band scores 0 rather than being excluded, so
         some still come through.
       - **Double-fire: settled, not suspected.** The double-tap window
         was live (fixed 2026-10-28), so every repeat ticker-day was
         checked. A double fire's signature is two lots seconds apart (by
         `position_id`, the add's `Date.now()`) with identical share
         counts, because one form produced both. Twelve ticker-days have
         more than one lot; the closest pair is GCTK on 10-28, 31.8 minutes
         apart, ×400 then ×250. That is a deliberate second lot, and none
         match the signature. The detector was mutation-checked: a planted
         copy of a lot 4 s later at the same size is reported. Don't
         re-open this without a pair that matches the signature.

     - **PRE-COMMITTED (Roman, 2026-10-27): when the lines get
       re-derived.** If **real buyable averages under 1 a day over 10
       consecutive trading days, the lines are re-derived**, using
       `node scripts/derive-step2-thresholds.mjs --exclude-artifacts` on
       the then-current backup.
       - **Real** means the time-correct artifact rule: not scored on a
         history more than one trading day old (dead or halted), and not
         scored on yesterday's bar in the first two minutes after the
         open.
       - ~~Day one is 2026-10-27; day ten is 2026-11-09.~~ **RESTARTED
         (2026-10-27):** the crons are re-aimed on 2026-10-27 (pushed
         after Roman's review; EDGE 07:30–11:00 PST, Warrior 06:30–08:00
         PST, see below). A re-aim mid-count changes the yardstick
         underneath it, and measuring a schedule change as a market
         change is the error made with Friday's zeros. So the count
         starts over from the **first full day on the new schedule**. The
         schedule is aimed at PST, and 10-28..10-30 run it on PDT (an hour
         later in PT), which isn't its steady state. **Day one is Monday
         2026-11-02; day ten is 2026-11-13** (no market holidays in
         between; 11-11 is a trading day). The count is evaluated after
         the 11-13 close, and then on every later day over the trailing
         ten. Any later re-aim restarts it the same way, with its date
         written here.
       - **The yardstick (APPROVED, Roman, 2026-10-27):** the per-day count
         from `measure-gate-buyable.mjs` at the 1M floor: distinct symbols
         buyable at any of **07:30, 09:00, 10:00, 11:00 and 12:00 PT**,
         fixed clock times set in the script, so counts are comparable from
         day to day rather than depending on when a cron landed. Counted
         one per date and symbol, the same way as the 106. A window counts
         only if that run's validation is at least 90% exact; otherwise
         the count isn't usable and the rule says so rather than counting
         it. Stored signal_log rows are reported beside it as a lower
         bound, not the measure: stored rows alone read cron gaps as a
         quiet market, which is the error made on 10-27.
       - **Either way:** under 1 a day means re-derive, and at or over 1
         means the lines stand. Not tuned to the outcome after the fact.
     - **The fallback path is unexercised, and stays that way until a real
       failure exercises it.** Detection and handling are proven by the
       mocked tests (`tests/edge-liquidity-gate.test.js`), but no live
       scan has had the daily-bar or asset fetch fail. A failure is not
       manufactured to test it. Same standing, and the same rule, as
       `audit-signal-log-splits --write` (phase-9 spec §3.9.4): detection
       proven, the correction path structurally unexercised, nothing
       fabricated.
     - **The zero state is said plainly (2026-10-27).** When nothing
       clears the buy line, the Signals tab says so: "42 signals · best
       score 55 · buy line 65 — nothing qualifies in this scan. Scanned
       09:06; tap Refresh for a fresh scan." If the scan is more than an
       hour old, it says that too. When nothing even shows, it gives the
       scored count, the best score and the display line, with the same
       scan time. **It states what the last scan saw and when, and never
       why.** The first wording added "the market is quiet", and it was
       false. The fixed tool showed qualifying signals at 10:00 and 12:00
       on both days, after the last scan, and a confident wrong
       explanation that Roman can't check is worse than silence. The old
       empty-state copy ("Market is quiet right now") went with it; a test
       fails if the claim returns. The reason for the zero state is behavioural, not statistical. An
       empty list can't be told apart from a broken app, and Roman,
       seeing that for days, either stops opening it or buys outside it,
       and a trade outside the app is invisible to every measurement
       here. Every SHOWN signal counts, owned ones included, so it never
       claims nothing qualified when the one that did is already held.
       The line is the version's own, never a literal. After a reload,
       the "nothing showing" case gives no numbers, because the full
       results are session-only.
     - **The browser's side of the gate is unobservable in stored data,
       by design.** Browser scans write no scan_runs row (a row per
       browser scan would bury the logger's). Its only guarantees are
       that it calls the same `runEdgePrefilter`, and the tests over that
       function. What it CAN do is say what it ran: since 2026-10-27 the
       scan line always names the rule from the rule object's own
       parameters, e.g. "pool: 20-session avg volume ≥ 1,000,000 through
       10-23 · $1–$20 · listed & tradable", followed by any degradation.
     - **The tradable flag is a point-in-time fact, not a property.** GDC
       read not tradable at 10-23 06:48, tradable at 07:22, and not
       tradable again on all three 10-26 scans. XXII moved from not
       tradable to tradable after the dry run. Each scan records the
       flag as Alpaca reported it at that moment, so different scans
       disagreeing is expected; **don't "fix" it** by caching or
       smoothing the flag across scans.
     - **First real run (dry run, 2026-10-22 23:5x PT, live Alpaca):**
       82 of 239 pass (the measurement estimated about 89 at 1M); all 14
       dead symbols are rejected. Recency alone catches CCO, GETY, HCWC,
       PSKY and WALD; the asset check catches all 14, including DRCT,
       FLZH, GDC and XXII, which still traded through 10-21 but which
       Alpaca won't trade. Tests: `tests/edge-liquidity-gate.test.js`,
       `tests/prefilter-rejections.test.js` and
       `tests/rvol-fetchers.test.js`, with 19 mutations, all caught.
     - **A short asset list is "unknown", not "everything delisted".**
       Absence from the list is the evidence for `asset_inactive`, so a
       response under 1,000 assets that didn't error (Alpaca returns
       about 14,400) is treated as a failed list, and the listing test is
       skipped and recorded. It's not allowed to empty the pool or put a
       delisted banner on every holding.

   **Buyable per day, measured (2026-10-22, `node
   scripts/measure-gate-buyable.mjs`).** Every universe symbol is re-scored
   with the v2 formula at 07:00, 07:30, 10:00 and 12:00 PT on 7 dates
   (10-13 to 10-21), from rebuilt live inputs. **Validated first:**
   re-scoring 130 real logged signals with the formula they ran reproduces
   118 exactly (91%, mean difference 0.9 points). Scans in the first two
   minutes after the open are scored apart (10 of 56 exact), because there
   the live snapshot still held yesterday's bar.

   | pool | buyable per day (median) | over 7 days | pool size at 07:30 |
   |---|---|---|---|
   | live (IEX today ≥100k) | 3 | 29 | 16 |
   | trailing ≥100k | 11 | 84 | 157 |
   | trailing ≥250k | 9 | 72 | 139 |
   | trailing ≥500k | 7 | 55 | 117 |
   | trailing ≥1M | 5 | 43 | 89 |
   | trailing ≥2M | 3 | 30 | 58 |

   - **The score is the binding constraint, not the pool.** A tenfold
     larger pool at 07:30 yields about 1→3 buyable per scan.
   - *(Corrected 2026-10-27: this table came from the tool before two
     fixes. Its histories stopped at 10-21, and its trailing pool skipped
     the recency rule, so it passed PSKY. Re-run fixed: **1M = 4/day, 36
     over 7 days**, with 90% validation. The real step-2 target is 4.0/day,
     not 5.6; see step 2's correction.)*
   - **Step 2's intent was about 5–6 buyable a day** (106 over 19 logged
     dates). The **1M trailing floor** (5/day here) holds that rate. 500k
     (7/day) loosens it, and 100k (11/day) roughly triples it.
   - **The early window stops being empty:** at 07:00, live has a pool of 9;
     every trailing floor has 58–157 symbols scored, which is what makes
     §3.4 testable.
   - **DECIDED (Roman, 2026-10-22): FLOOR = 1,000,000 shares, the
     20-completed-session full-market (SIP) average.** It's chosen for
     continuity, not for the buyable rate. 2M matches the live rate more
     exactly (3/day against 3/day), but it keeps only **60%** of the
     symbols the live filter has ever let through; 1M keeps **90%**.
     Excluding 40% of the names Roman has actually traded would be a
     different universe disguised as a continuity choice. 1M also matches
     the historical pool directly (about 88 against 84 distinct), and
     5/day sits inside step 2's 5–6 target.
   - **Why not wider:** the score is the limiting factor, and it barely
     discriminates outcomes (the report: 54% win at 29–72 against 56% at
     73–115). A bigger pool buys higher-scoring candidates whose higher
     scores don't predict better outcomes. With a $1,500 budget and about
     five slots, 11 buyable a day is more than Roman can act on, and his
     2+ day holds are where $828 went. More choices he can't take are a
     cost, not an option.
   - **Liquidity isn't the binding constraint at his size either:** $300
     of a $5 stock is 60 shares, so almost anything above a 100k daily
     average is plenty. **So this floor doesn't protect against
     illiquidity; it's a pool-size dial**, set for continuity until
     something says otherwise.
   - **Condition for revisiting it (so it isn't 1M by inertia): if the
     score ever discriminates outcomes, widen the pool.** That's a §5
     question, the same re-test the RSI floor is waiting on.
   - Whatever is built, the rejection log then shows it working on real
     scans.
   - **Found while validating:** 30 of 676 logged snapshots (4.4%) were
     scored on IEX bar histories 4+ weekdays stale (AREN: 09-15 to 10-14,
     scored on bars ending 08-28), with nothing marking it. That's the
     defect family: a score on data no one would call current. Not fixed;
     `scoreStock` should mark or refuse a stale history.
   - **SCORED ON ONE VENUE, ADMITTED ON ALL OF THEM (found 2026-11-01).**
     The 1M gate reads SIP (`core/universe.js`), but the bars and snapshot
     that reach `scoreStock` come from `core/market-data.js`, which
     hardcodes `feed:'iex'` (`fetchSnapshots`, `fetchMultiBars`), in the
     browser scan and in the logger, which loads the same file. Measured on
     every buy with a snapshot: `node scripts/measure-iex-vs-sip-scoring.mjs
     --rev d6e277d` (88 buys, 10-29 and 10-30; the real `scoreStock` on
     each feed at the same minute, macro overlay as at the buy; the IEX
     rebuild reproduces 80 of 88 stored scores, the rest drift between
     scan and buy).
     - **Three defects, not one.** (a) **The live snapshot's dailyBar from
       a previous session** (APUS, BIAF, IPDN on 10-30): Alpaca's dailyBar
       is "the most recent daily bar", so a stock with no IEX trade yet
       today is scored on yesterday's, shown as today's: +6.4%, +4.6% and
       +5.6% when SIP had them at −7.8%, −2.0% and −7.6%, and all three
       bought. AREN's frozen-snapshot mechanism, in the live path.
       STALE_BARS (db/031) let it through: the marker watched the right
       bar (history and dailyBar agree on the date in all 88; they come
       from two requests seconds apart and can disagree, 9 of 88 by a few
       hundred shares), but it allows age 1 at any hour, and never asked
       whether the scan was taken in a session. The offline
       `--exclude-artifacts` rule (step 2) has the same hole: it treats
       age 1 as an artifact only in the first two minutes after the open.
       (b) **A scan from a previous session shown as current** (DNUT,
       NRGV at 07:18 on 10-29: a 10-28 scan still on screen, shown at 85;
       that morning's data scored 55 and 50, both under the line; both
       bought). `barsAgeTradingDays` is measured against the scan's own
       date, so a scan reads as current forever; the only age warning was
       the tab banner ("Stale data — refresh now"), which names no date
       and doesn't touch buyability. The card's strip that morning was
       the 7:00–7:30 gate, not the age. (c) **The feed itself**, below.
     - **(a) and (b) FIXED 2026-11-01, advice only, as every gate:**
       `core/entry-gate.js` STALE_DAILY_BAR (a dailyBar older than the
       scan's date, on a scan taken during or after that day's session)
       and PRIOR_SESSION (a scan from before the most recent regular open;
       pre-market, last evening's scan stays current until 06:30). Both
       read one stamp both scans apply (`core/clock.js scanFreshness`:
       `scannedAt`, `scanSession`, `dailyBarAsOf`,
       `dailyBarAgeTradingDays`), three states like `bars_as_of`
       (unknown is not judged). Signals stored before it get `scannedAt`
       from `lastScanTime`, which is set in the same statement. On the 88
       bought, exactly five would have been not buyable: APUS, BIAF,
       IPDN, DNUT, NRGV (`tests/prior-session-daily-bar.test.js`, on
       d6e277d). No feed change, no re-derivation: neither changes a
       score, only whether a stale one is offered.
     - **(c) What IEX does to each input** (IEX minus SIP, same minute):
       price-derived terms track in the median and not in the tail
       (price 0.0% median, 7.7% max; RSI 0.2 points, 14.5 max; today's
       change 0.2 points, 14.2 max; RSI points differ on 0 rows, MA points
       on 1, momentum points on 9). The tail is the stocks barely traded
       on IEX, whose "last price" is hours old. **Volume points are the
       mover: they differ on 25 of 88, IEX higher on 19.** Score
       identical on 49 of 88, 90th-percentile difference 20, IEX higher
       29 / lower 10; **label differs on 15 of 88; buyable on IEX only 11,
       on SIP only 3.** The error leans toward false buys.
     - **A ratio of two same-venue quantities is unbiased on average and
       arbitrary per row, and a bucketed score turns per-row noise into
       category errors.** The volume ratio is IEX-today / IEX-10-day
       average, so the venue cancels only if IEX's share of today equals
       its share of the averaged days. It does in the median (6.7% both,
       ratio of shares 1.05) and not per row (0.64 to 1.58, 10th to 90th
       percentile); the volume points are steps at 0.5×, 1×, 2× and 3×,
       so the per-row spread crosses edges. The reviewer's expectation
       ("volume ratio may partly cancel") was half right in the way that
       matters least.
     - **The 1M gate is a mean, and a mean admits spiky stocks.** APUS:
       20-session SIP mean 5.37M, 50k traded on 10-29 (200 shares in 3
       trades on IEX). IPDN: 3.63M mean, 20k on 10-29. "Cleared 1M" does
       not mean it trades on a typical day. Recorded, not changed.
     - **The IWM correction is the same root cause, small.** The
       forward-test caveat first quoted IWM +1.17% for 10-27 from an
       ad-hoc IEX fetch; SIP says +1.15%. The error was small because IWM
       is about as liquid as anything traded, and that is exactly why it
       can't be used to reassure anyone about the stocks that aren't.
     - **15-minute-delayed SIP against live IEX** (the Basic plan serves
       SIP only for data at least 15 minutes old; Warrior's gap scan
       already uses it). Both measured against live SIP at the minute,
       split by the stock's 10-session IEX share:

       | IEX share | n | price off, median (IEX / delayed) | labels wrong (IEX / delayed) | buy decision wrong (IEX / delayed) |
       |---|---|---|---|---|
       | all | 88 | 0.0% / 0.4% | 15 / 11 | 14 / 11 |
       | < 3% | 9 | 2.7% / 1.4% | 1 / 1 | 1 / 1 |
       | 3–8% | 61 | 0.0% / 0.3% | 11 / 6 | 10 / 6 |
       | ≥ 8% | 18 | 0.0% / 0.5% | 3 / 4 | 3 / 4 |

       **Delayed SIP is better on labels overall, and not strictly better.**
       On price, live IEX is closer to the truth everywhere except the
       thinnest band, where delayed SIP halves the error (90th percentile
       7.7% to 3.4%). On labels it wins in the middle band, ties in the
       thinnest (n=9), and loses slightly where IEX's share is high. 11 of
       88 labels are still wrong with it: the delay costs about as much
       as the venue did. Not decided; the shape worth measuring next is
       mixed (SIP history and delayed SIP volume, live price), since
       volume is where the venue error lives and price is where the delay
       error lives.
     - **(c) is a project, not a fix, and it carries the re-derivation in
       the same change:** step 2's thresholds and the 10-day buyable
       pre-commitment were set on IEX scores (signal_log is IEX too), so
       a feed change moves the score distribution under them. The change
       states what the distribution does, re-derives the lines, and
       restarts the 10-day count. Not started until (a) and (b) shipped.
     - **Snapshots now record the setting that produced them.** The
       macro overlay is the one setting `scoreStock` reads; Roman runs
       with it off, the snapshot didn't say so, and
       `scripts/lib/rescore-snapshot.mjs` assumed it on: 44 of 88 of his
       buy snapshots re-scored to their stored score, 88 of 88 with it
       off. Both scans now stamp `scoreSettings.disableMacroOverlay` (on
       the signal, outside `scoreStock`, so `scoring_hash` is unchanged),
       and the helper reads it when present.
2. **Neutralise the two backwards terms in §7.3 AND re-derive the BUY
   thresholds in the same change** (§7.7), so buyable signals per day
   stay near today's ~5–6 (106 over 19 dates, one per date and symbol;
   `node scripts/derive-step2-thresholds.mjs`). The intent is to change
   which signals rank highest, not to turn the tap off.

   > **CORRECTION (2026-10-27): a third of the calibration target wasn't
   > real, and the line survives it.** "106 over 19 dates" reproduces
   > exactly on the pinned backup (`de95a93`), but 30 of the 106 were not
   > real signals when scored. Some were histories more than a trading day
   > stale (dead or halted stocks, PSKY from 10-09). The rest were scored on
   > yesterday's bar in the first two minutes after the open (10-16 alone
   > gave 20). So 65 was derived to preserve a count that was partly
   > fabricated. That it still preserved the real rate was an
   > *inference*, and is now a *measurement*. With both sides cleaned
   > (`node scripts/derive-step2-thresholds.mjs --exclude-artifacts`: 32
   > stale and 53 open-minute rows dropped), **76 real old-formula
   > buyable (4.0/day) map to 74 at 65 under the new formula, so the
   > equal-count line is still 65** (60 gives 86, 70 gives 60). WATCH stays
   > 20 (457 → 417). The artifacts were a similar share of both sides (30 of
   > 106 old, 24 of 98 new), which is why the inflated count gave the same
   > line. **The honest target is 4.0 a day, not 5.6.** (An earlier
   > figure of 71 / 3.7 a day used a fixed list of 14 dead symbols, which
   > wrongly dropped their signals from before they died.)

   Shipped with both
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

   **Two facts about that zero, both true (2026-11-05).** The stored
   "activated: 0" was never evidence about the market, because the field
   was render-dependent: that stays true, and the paragraph above stands.
   Separately, SIP bars now independently confirm zero: none of 464 sold
   trades reached +20% in the regular session during its hold, even on
   the upper bound that runs to the recorded sale time. That second fact
   is new, and it is evidence about the market. A reader who sees only the
   second should not conclude the first was wrong: the first is about what
   the field could know, the second about what happened.
   (`scripts/audit-render-sampled-inputs.mjs`, trades_v2 at `164099a`.)

   **Mark filled writes a value that then looks like a measurement.**
   Of the 24 trades whose stored peak is above the bar-derived
   regular-session high, 22 are because Mark filled sets `peakPrice` to
   the fill price (`app.js`, `peakPrice: fillPrice`) and the stock never
   traded above it after the fill. The stored peak is then the buy price,
   by construction, read later as "the highest it went". That is the
   §7.7 family again: an action writing a value a reader takes for an
   observation. (Of the other two: one high came in extended hours, which
   decision (i) excludes; CBRG 2026-09-27 is unexplained.)

   **Measured 2026-11-05, and parked behind db/039 and Roman's SQL.**
   Step 2.5 was measured before being built, against the approval's own
   question (which labels change, and in which direction):
   - **Current positions: 0 of 11 change label.** 9 of 11 were below their
     stop, where the hard floor returns before any step 2.5 input is read;
     on the other two, neither momentum protection nor "RSI declining"
     comes out differently. (Portfolio at `164099a`, market data
     2026-11-05 19:55Z; `scripts/audit-step25-current.mjs`.)
   - **History: no EDGE label can change through the peak.** In EDGE the
     peak is read only inside momentum protection, which activates on 0
     of 464 either way. Derived peaks are higher, but by little: within
     0.5% on 266, higher by more than 0.5% on 174, lower on 24; median
     +0.35%, p90 +1.69%. Peak RSI during hold is not a verdict input; the
     derived value is lower (median -3.6 points on 179 multi-day holds),
     which moves the WINNER EXIT TIMING ">70" count from 4 to 2.
   - **What can still change a label:** `prevRSI` day over day, only
     between HOLD STRONG and LOCK IN PROFITS (composite >= 30, in profit),
     and any future position that reaches +20%. The render's `prevRSI` was
     never stored, so that one channel is unmeasured on history.

   So step 2.5 was **measured at zero label changes: it fixes the record
   rather than the recommendation.** That does not justify two to three
   sessions ahead of db/039, which tests whether the app's central premise
   works at all. It still has to happen: a view writing values a decision
   reads is a live defect, and removing those writes closes the surface
   the resurrection race used. But it is not urgent.

   **Does he give back his biggest gains? Measured 2026-11-05; the +20%
   threshold is NOT decided.** Momentum protection is only worth having
   if he does. Its trigger sits outside the distribution it is meant to
   act on: regular-session peak gain per trade, from SIP bars, has median
   +1.53%, p90 +4.20%, p99 +8.90%, maximum +15.67%, and 0 of 501 at +20%
   (upper bound, through the recorded sale; the lower bound, multi-day
   holds before the sale day, tops out at +5.17%). For scale, the average
   win: $9.75 on a $492 position over the 283 winners in this population,
   and $10.98 on $563 in the v2 era, which is seven days; both about 2%.
   Median realized winner +1.48%.

   | Peak at or above | n | Median peak | Median realized | Median captured | Captured under half | Ended at a loss | Peak on the sale day |
   |---|---|---|---|---|---|---|---|
   | +3% | 101 | 4.20% | 2.81% | 71% | 28 | 6 | 97 |
   | +5% | 32 | 6.23% | 4.66% | 75% | 8 | 1 | 30 |
   | +10% | 5 | 12.50% | 11.39% | 84% | 0 | 0 | 5 |

   Per trade at the top, because at n=5 one trade is the whole figure:
   CPNG captured 99% (peak +15.7%, sold +15.5%), NCLH 84%, XXI 84%, AIXI
   67%, NNBR 97% (its peak is in the minute of the recording, so the bound
   may include a price after he sold). On his biggest gains he keeps most
   of the peak, and they peak on the day he sells: the pop comes and he
   sells into it. That points at removing the mechanism rather than
   retuning it, and it is the reviewer's and Roman's decision, not made
   here. The give-back that does exist is in the middle band (28 of 101
   peaks of +3% or more kept under half), an exit question far below +20%.
   Upper bounds throughout: the sale's fill time isn't stored, so a peak
   can include minutes after he sold. (`scripts/audit-peak-gain.mjs`,
   trades_v2 at `164099a`, bars fetched 2026-11-05.)
   **Exit rules, replayed (2026-11-06): none clears the +$2.25-a-trade bar.** A replay, not a recommendation
   (`scripts/audit-exit-rules.mjs`, trades_v2 at `164099a`, the 501-trade population sold on 37 trading days,
   SIP minute bars, regular session). Against what he actually got:

   | Rule | Changes | Better / worse | Total | Per trade | Without its best contributor | Days better / worse |
   |---|---|---|---|---|---|---|
   | Trailing stop, arms at +3%, gives back 1 pt | 85 | 37 / 46 | -$106.98 | -$0.21 | -$0.31 (KDK +$46.94 out) | 12 / 11 |
   | Trailing stop, arms at +5%, gives back 1 pt | 29 | 18 / 11 | +$44.51 | +$0.09 | +$0.04 (BBAI +$23.08 out) | 10 / 3 |
   | Fixed exit at +3% | 101 | 58 / 42 | +$7.24 | +$0.01 | -$0.12 (FFAI +$68.00 out) | 15 / 8 |

   The tight rules win on small trades that went +3% and then lost (KDK, FRGT, EMAT, FFAI) and give it back on the
   runners: AIXI (bought 10-06, sold 10-07 for +$130, the book's largest gain) is closed near +3% on 10-06 by both
   +3% rules, -$105 and -$101, nearly all of each rule's day; CPNG -$42 to -$58. The leakage at +3% is real, but a
   rule tight enough to catch it cuts the runners that make his money. LIMITS, in the same breath: the peak runs to
   the recorded sale time, which is at or after the fill, so a rule can exit after he had sold; and the sample is
   days, not trades (37 days, and 10 to 23 of them changed by a rule). So no exit change has evidence behind it yet.
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

**Corrected 2026-10-27, from live use: the fix for that over-reached.**
Inside the entry gate, the modal footer was relabelled "+ Record a trade
already placed", behind a browser `confirm()` ("The advice is not to buy
now. Record a trade you've already placed for QSI?"). That gated the
*action* in a second way: the relabel presumed a past trade, so there was
no ordinary add any more, and a blocking browser dialog was the heaviest
interruption the page had, spent on a suggestion. The card's warning strip
and the modal's banner ARE the advice, and Roman likes them; everything
past them was the app arguing with him. Now:
- **Inside a gate window:** the strip and the banner are unchanged, and the
  footer is the ordinary "+ Add to Portfolio", which opens the form
  directly.
- **A second lot** (already held, or an order pending) opens the form
  directly, with the reason shown in it.
- **After-hours / pre-market entry advice** (§4.1) is a note in the add
  form, no longer a confirm.

**The principle: confirm when the app knows a FACT that contradicts the
action; never confirm when it merely ADVISES against it.** A dead asset is
a fact: Alpaca says it can't be traded, so "are you sure this filled?"
checks reality. That's the one confirm left on the add path
(`confirmAddPortfolio`), and "Add anyway" always proceeds. The hour of day
is an opinion drawn from 70 trades, and an opinion doesn't get a modal;
holding a position already is a fact, but it doesn't contradict buying
more. **No browser `confirm()` anywhere in the app:** it blocks the page,
renders as "<host> says", and on mobile is indistinguishable from a scam
prompt. The listing confirm is the app's own in-page overlay
(`showConfirm`). `tests/entry-gate.test.js` pins all of it, including a
scan of every file for a browser `confirm(`.

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

**A table created in Supabase's SQL editor has RLS enabled and no policy.
Grants alone never suffice, and a privilege check cannot see the
difference.** (Added 2026-10-28.) `has_table_privilege` answers from
GRANTs; row-level security is a separate gate it never consults, and with
RLS on and no policy every row is refused (42501), whatever was granted.
**The instance: db/033** (`signal_snapshot_at_buy`). Its verification
checked `has_table_privilege` for anon, passed, and was signed off, while
every insert from 10-27 to 10-28 was refused, so all 72 positions bought
in the first forward test have no snapshot (§5, "IT NEVER WROTE A ROW").
This project already held the general rule: "status codes prove nothing,
always re-select" (db/023), and a real round-trip for db/028. It was
applied to new columns on existing tables, whose policies already
covered them, and dropped for a new table, the one case where it decides
the outcome. The generic rule didn't catch it for either reviewer; this
one would have. **So every migration that creates a table** states its
RLS posture in the same file (enabled, with the policies each role
needs), and its verification is an actual write as the role that will
write (`set local role anon` inside a rolled-back transaction), plus,
after it's applied, a probe over HTTP that a constraint must refuse
(expect the constraint's code, e.g. 23514, never 42501). db/034 is the
first migration written this way.

**A MECHANISM THAT FAILS MUST LEAVE BEHIND THE EVIDENCE NEEDED TO EXPLAIN IT (2026-11-04).**
The next failure should be diagnosable from its own log, without a re-run. Three instances, all
found the hard way: the harness kept only test names; the runner kept no assertion messages, so
the 11-03 queue-pacing failure is still unexplained; and `fill-outcomes` failed on 11-03 and 11-05
without logging whether Pass 2 had seen the rows it named, so that diagnosis is an inference.
**ANY SCHEDULED JOB LOGS THE COUNTS ITS ASSERTIONS DEPEND ON:** the candidate count, how many rows
each pass saw, how many transitions it made, and whether any read came back at a page limit.
`tests/job-counts.test.js` holds this for what the scheduled jobs read today.

**EVERY MUTATION REPORT STATES THAT ITS BASELINE PASSED (2026-11-04),** as a required line. A
fourth instance of the same family: a set of 9 "kills" on 11-04 ran against a test that was already
failing, and a failing test kills everything. `scripts/lib/mutants.cjs` runs the baseline first,
prints it before any mutant, and stops if it fails, so a report without that line is visibly wrong.

**ANY TEST THAT MUTATES GLOBAL STATE (console, Date, fetch, timers, env) RESTORES IT, AND THE APPARATUS
DETECTS LEAKAGE RATHER THAN TRUSTING DISCIPLINE (2026-11-04).** The fifth instance, twice over: a stub
that swapped `console.error` hid FAIL output, and a muted `console.log` swallowed a PASS line while the
file still passed. All five are one failure: the apparatus losing the thing it was built to report.
`_lib.run` now runs a file's tests one at a time, fails a test that leaves a global changed and names
it, puts it back for the next test, and prints results through streams no test can swap. The runner
fails a file as LOST if its result lines don't add up to the count it declared. On first run this found
7 files leaving a stub in place (5 `fetch`, 2 console), none of them the queue tests; they now declare
it with `restoring`. `tests/global-state-leaks.test.js` holds it, through the real runner.

**ANY TEST RUN WHOSE RESULT MAY BE REPORTED RECORDS THE TREE IT RAN AGAINST (2026-11-04):** the commit,
or dirty plus a hash of the changes. The sixth instance, and a different kind: the other five lost
evidence after the fact, and this one never had it. The queue-pacing failure ran on a working tree
and nothing recorded its state, which is part of why it can never be explained. The runner prints it
as its first line, before any test can change what it says, and the mutation harness opens with it.
`tests/tree-record.test.js` holds it.

**IF A BUILD DEPARTS FROM AN APPROVED SCOPE, THE REPORT THAT DELIVERS IT SAYS SO (2026-11-05),** in the same
message, naming what changed and why: a line in the delivery, like a declared test change. A silent substitution
only surfaces once data has accumulated behind it. On 11-04 the fill time went into `sell_time` against the 11-03
scope, and no report said so. It was caught with 0 sales behind it, which was luck. The repo spec being canonical
is the structural fix: that scope lived in a session and a project neither reader could see.

**ANY FIGURE FOR ROMAN GOES THROUGH ITS SOURCE DOCUMENT'S OWN METHOD BEFORE IT REACHES HIM (2026-11-05). This binds the reviewer as well as the implementer.**
The checks: the stated exclusions; distinct days, not n; the figure without its best trade; the share from its largest day; and the paired same-day
comparison where the claim is about hours. A figure that hasn't been through them is said to be unchecked and is held, whoever handed it over. The common
factor in five errors in two days was reaching the conclusion first and looking for the check afterwards: a 79.1% with its definition unstated, §7.2 with its
coverage unchecked, "the second time" conflating two measurements, a fifth percentile read as a proportion, and a cell quoted without the method its own
document prescribes. `scripts/audit-first-hour-cell.mjs` prints all of these for the time cells.

**A PUSH IS DECLARED DONE BY A SCRIPT'S OUTPUT, NOT BY A PERSON REMEMBERING (2026-11-05).** Tests on main went red at cae6644 and stayed red for six pushes, each
reported from a local runner on the exact tree. Roman got a failure email for each, in the same week he was told not to get used to ignoring them. This script had
been specified that morning and never built, and nobody checked the checker existed. **`node scripts/check-push.mjs <sha>`** fails if the Tests run for that exact
commit is missing, failed or still going.
- **The deeper fix is the environment.** `workflow-instrumentation` deleted a GITHUB_ENV that only CI sets, so "green locally" never meant "green in CI", for any test.
  `scripts/run-tests.mjs` now sets CI's variables and TZ=UTC unless told otherwise (`--local-env`), so the two diverge only for reasons chosen. What still differs is the
  operating system and the Node version, and it prints them. Those aren't reproduced, so `check-push` is still what declares a push done.
- **The leak detector did its job.** It failed in the environment where the leak mattered, and the test was wrong. Do not weaken it for being noisy.

**AN AUDIT COMPUTES WITH THE APP'S OWN FUNCTION, NOT A REIMPLEMENTATION OF IT (2026-11-05).** Load the
function (`core/indicators.js`'s `calcRSI`, not a copy of it), because the question an audit answers is what the app
computes. A reimplementation that agrees is luck. The instance: the step 2.5 audit first carried Wilder-smoothed RSI,
where the app averages the last 14 changes; it was replaced by the app's `calcRSI` before any figure left it, and the
median it reported happened to agree to the decimal. `tests/audit-render-sampled-inputs.test.js` holds it to the app's
function. Same audit, same day, the other catch: rate-limited (429) requests had become nulls and dropped 305 of 464
rows quietly. Rate limits are now waited out and any other failure stops the run; a row is never dropped without
being named.

**A CHECK CONSTRAINT MUST BE PROVABLY NON-NULL FOR EVERY INPUT, OR IT PASSES ON UNKNOWN (2026-11-05).** Postgres
accepts a row when a CHECK is TRUE *or NULL*. `jsonb_typeof(x -> 'key')` is NULL when the key is absent, and so is
`x ->> 'key' = '...'`, so a check written that way never required its key. The case: db/035 run 4 refused 3 of 4,
accepting `{"state":"PREDATES_SALE"}` with no `scanned_at`: `true AND NULL` is NULL, and NULL passes.
`{"state":"NOT_RECORDED"}` with no reason passed the same way, and so did `{}`. The same pattern was in db/028's
code_version checks on four tables and the sale stamp (`{}` accepted), and in db/032's prefilter_rule. **db/040
repairs all seven**, and the schema harness found two more in db/038 revision a before it was sent (a CAPTURED
verdict with nothing captured; a fill time with no source). Write every branch definite: `coalesce(jsonb_typeof(x ->
'key'), '') = 'string'`, `coalesce(x ->> 'state', '') = '...'`. Where NULL is intended, say so with `col is null or
...` rather than leaving it to the three-valued logic, so intent and accident read differently.
- **The broader point.** We have treated database constraints as the strongest guarantee available ("observe-only
  enforced in the database too", "the revision stamp cannot lag"). This is the first evidence that a constraint can be
  as hollow as a comment. A constraint is a claim until a behaviour run has tried to break it.
- **Count is not behaviour.** db/035 run 2 said `checks: 2` and passed, an hour before run 4 said 3 of 4. A
  verification that counts constraints in `pg_constraint` proves they exist, not that they refuse anything.
- **Nothing had executed the constraint.** The parse check passed and the local tests passed. Every migration now
  goes through the schema harness first (below), which runs it against the reconstructed live schema in real
  Postgres; that is the gap this closes. A standing test, `tests/definite-checks.test.js`, refuses the
  missing-key pattern in any new migration, but the harness is the authority: the test reads text, the harness runs
  the check.
- **UNDERSTANDING A DEFECT CLASS DOES NOT PREVENT WRITING A NEW INSTANCE OF IT. ONLY EXECUTING THE THING DOES.** The
  harness's first catch was in db/038 revision a, written the same day: `verdict_display_consistent` accepted a
  CAPTURED state with nothing captured, and `sell_filled_at_consistent` a fill time with no source. Both were the class
  that had just been diagnosed in db/035 and db/028, by the person who had just diagnosed it, and both were found before
  Roman saw the file only because it was run.
- **A VERIFICATION THAT REPORTS THE WRONG REASON WHEN IT FAILS IS BARELY BETTER THAN ONE THAT DOES NOT RUN.** The same run
  found revision a's run 2 fragile: a wrongly allowed probe wrote, the next probe then died on the write-once trigger, and
  the block failed with "is write-once" and no RESULT line, which points at the wrong constraint. Every probe now rolls
  itself back (it raises inside its own block after a write), so each failure is reported as itself.
- **THE STANDARD SHAPE FOR VERIFYING A CONSTRAINT: COPY A REAL ROW.** Insert a copy of an existing row with one column
  changed. A value the constraint refuses stops at its own error (23514 CHECK, 23502 NOT NULL); a value it accepts goes
  on to collide with the primary key it copied (23505), which proves it passed. Two distinguishable outcomes, nothing
  is ever written, and when the probe is wrong the error points toward a false FAIL rather than a silent write.
  db/040 run 2 and db/041 run 2 use it; every future constraint verification does.

**A MIGRATION GUARD IS THREE-STATE: IT PROCEEDS ONLY ON A DEFINITE FALSE. (2026-11-05)** The CHECK rule above,
applied to the code meant to stop a bad run. PL/pgSQL treats a NULL IF condition as false, so `if <cond> then raise`
proceeds when its condition couldn't be evaluated. Every guard in a migration not yet applied is written
`if (<cond>) is not false then`: true aborts, NULL aborts, only false proceeds. The same holds for a check in a
behaviour run that records into `wrong`. Retrofitted to db/037, db/038 (revision c), db/039 and db/041, 50 guards in
all; none can be NULL today, so no guard's meaning changed, and the form keeps a later edit from opening the hole. The
schema harness shows each db/038 guard fires on its own broken precondition and changes nothing, and that a NULL
condition goes straight through the old form and aborts the new one. `tests/three-state-guards.test.js` holds every
unapplied migration to it.

**MAIN IS DEPLOYABLE AT EVERY COMMIT (2026-11-06).** Pushing main deploys the app against the live database, so
main never holds code that writes a column the live schema lacks: PostgREST refuses the whole insert over one unknown
column, and the insert that fails is a buy or a sale. The order is fixed: the migration carved to main, Roman runs it, its
run 2 passes, and only then the app code that fills its columns, in a push of its own. Never both in one push, never the
app first. The case: a clearance to push the gated stack, whose history held app code writing db/038's columns, would
have broken every buy and sale; it was refused on what the tree showed, and db/037 was carved out instead.
- **Made impossible rather than remembered:** `tests/live-columns.test.js` enumerates every (table, column) the app,
  the scripts and the workflows write and checks it against `db/live-columns.json`, captured from the live database
  with the highest migration confirmed applied. A write site whose columns the walker can't see is NOT ENUMERABLE and
  fails. It fails only when code gets ahead of the live schema; a file left behind after a migration is harmless.
  Run against the gated stack, it names every db/038 column (c) and Verdict A would have written.
- **The push protocol:** every push request states, per commit, the (table, column) pairs its code writes and the
  migration that created each. Every clearance names the migrations that must already be live; a clearance without
  that list is void. A clearance is a claim, and a claim that contradicts what the tree shows loses.
- **A migration carved ahead of its app code is checked against the app as deployed:** every added column nullable or
  defaulted; every new CHECK TRUE on the NULLs the deployed app leaves (and says which); every new trigger's effect on
  the paths the deployed app takes; then the deployed app's real write shapes run after it in the schema harness.

**READING WHAT LANDED IS NOT REDUNDANT WITH THE HARNESS (2026-11-06).** A heredoc turned a trim into `/s+$/`, which ate
trailing letters, in the code that fixed truncation. Mutation testing did not find it: mutants are drawn from the code as
written, so a defect the editing mechanism itself introduces is in the baseline, not in the mutant set. Reading the
inserted code found it; the mutant existed only afterwards, once the test was made sensitive to it. After any edit made
by a script or a shell, read the lines that actually landed.

**AN ERROR IS NEVER TRUNCATED, ANYWHERE: NOT IN A TEST RUNNER, A LOG LINE OR A REPORT. TRUNCATION BELONGS IN DISPLAY, NEVER
IN CAPTURE (2026-11-06).** The sibling of the complete-baseline rule. Four times in one week truncation destroyed the
evidence needed to diagnose something real: an enumeration window that missed the sale insert's `.select('id')` 4,161
characters out (twice); a grants query filtered for readability; "..." runs in db/037's abort text as it was relayed; and
the test runner cutting the path off the one test that died in a parallel run. `scripts/run-tests.mjs` now prints, under
its one-line summaries, the complete output of every file that did not pass, as captured, and `--json` carries it;
`tests/run-tests-checker.test.js` holds it (5 mutants killed, among them a mistyped trim that ate trailing letters and
was itself written while fixing this).

**THE MUTATION HARNESS CANNOT LEAVE A MUTANT IN THE SOURCE (2026-11-05).** A run killed by `timeout`
mid-mutant skipped its restore and left a mutant in the spec; the baseline check and the runner caught it, which
is luck next to "cannot happen". `scripts/lib/mutants.cjs` now refuses a dirty tree (a leftover mutant shows as a
change, and the report names a commit), journals each mutant so a run killed outright restores on the next start
and stops, restores on SIGINT and SIGTERM (the tests run asynchronously, so the handler runs at once), and times
each mutant out. A timed-out mutant is reported apart from the kills, because a mutant that never finishes means
the mutated code has no termination guard of its own: a finding about the code. The instance: `barsWithRetry`'s
only termination is its attempt cap, and the mutant that removed it would retry forever; the test now pins exactly
eight tries. `tests/mutants-harness.test.js` has one test per guard.

**A failure that reports only to a channel nobody reads is a reminder with
extra steps.** (Added 2026-11-01.) Fill outcomes failed the first of its
three evening runs on five days running (10-26 to 10-30 PT; GitHub run
40423623086 first), and the only report was GitHub's email to Roman, who
mentioned it days later. Found by asking, not by looking.
- **What it actually was** (read from the run logs, not inferred from the
  email): every PATCH succeeded, then the verification re-select put every
  touched id in one URL (`?id=in.(…)`) and failed with `fetch failed`
  (UND_ERR_HEADERS_OVERFLOW). Measured: 371 ids answers, 400 doesn't. The
  first run of an evening touches the most rows (452 on 10-26, 597 on
  10-30) and crossed the line as the logger's volume grew; the later runs
  touch fewer and passed. Fixed by chunking (`scripts/lib/select-by-ids.mjs`,
  100 ids per request), in fill-outcomes and in the split audit, which had
  the same line.
- **What it cost: little, and that is a finding, not a relief.** The
  signal_log writes of each failing run had landed; its trades_v2
  sell-timing writes and the stale-unresolved assertion didn't run, but
  the next run an hour later did both (274/274, assertion passed), and
  found nothing left to write. No outcome column went stale. **What saved
  five sell-timing passes and five assertion runs was the job running
  three times an evening, and nobody designed that as redundancy:** the
  three crons exist to straddle the two DST closes and to retry a dropped
  delivery. With one run a day, every one of those five days would have
  lost both. It also only worked because the failure sat after the writes
  and the later runs touched fewer rows; a failure that hit every run
  would have had no cover at all.
  - **Does the cover survive the schedule change? Checked 2026-11-01:
    yes.** The re-aim (2026-10-27) moved the EDGE and Warrior loggers
    only; fill-outcomes keeps 20:30, 21:30 and 23:00 UTC on weekdays.
    Under EST the close is 21:00 UTC, so the 20:30 firing, if delivered on
    time, would stand down at the `/v2/clock` check (a no-op, not a
    failure), leaving two real runs. Measured on `workflow_runs`
    (10-13 to 10-30, 15 evenings): every delivery was 111 minutes late or
    more (median 199 / 181 / 139 for the three), there were no no-ops,
    and so all three ran after the close. **A second run after the first
    exists either way.** It is now something to keep, not an accident: a
    schedule change to fill-outcomes that leaves it one real run an
    evening removes the only thing that covered this failure, and must
    say so in the same change.
- **The diagnosis was wrong first, and the email is why.** The suspicion
  was the stale-unresolved assertion (10-09) firing on CCO, TDAY and GO
  for three weeks, because the email showed "3 annotations". The three
  annotations were a Node 20 deprecation warning, "Process completed with
  exit code 1", and an Ubuntu label notice; the three rows had resolved
  (`not-taken-confirmed`) and the assertion had passed on every run that
  reached it. **An email's summary says that something failed, not what
  failed. Read the log before naming the cause.**
  - **The sharper version, from the reviewer who made the guess:** the
    cause was inferred from a coincidence and from a mechanism the
    reviewer had built. Three annotations matching three rows already in
    mind, plus an assertion its designer was pleased with, produced a
    confident wrong answer in one step. **The author of a mechanism is
    the worst person to guess whether it fired**, because the mechanism
    is the first explanation that comes to mind and the one they most
    want to be right. Ask the log, not the designer.
- **The rule still stands, and it covers the assertion too.** The 10-09
  assertion replaced a human reminder because it "can't be forgotten". It
  can't be, but it can be ignored exactly as this failure was, because
  its only output is the same email. So every scheduled job's outcome is
  shown where Roman already looks: Settings → App Info, "Scheduled jobs",
  from `workflow_runs` (which recorded all five failures, matching GitHub
  run for run). Three outcomes per run: success, failure, and no outcome
  recorded (a run that started and never wrote `job_status`), plus a job
  with no run in 8 days. A failure is shown even when a later run
  succeeded; it's red when the latest run failed.

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

**A value computed against the current time cannot be reproduced later
(named 2026-10-27).** It must be stored at the moment it was true, and
any analysis must read the stored value rather than recompute it. The
signal snapshot (§5) makes this sharper, not safer: a snapshot holds a
value's *inputs*, so the value looks reproducible from them, and for
these it isn't. Recomputing one later answers a different question
("what would this say now?") under the stored value's name. Instances in
hand:
- **`riskAtBuy`** (and `risk` inside a snapshot): `scoreStock`'s
  `hasRecentNegNews` compares the headline's age with `Date.now()`
  (`core/edge-scoring.js`, the only clock read in the scoring code). A
  headline 2h old at the buy re-reads as days old at a re-run. The
  *score* doesn't read it, which is why the re-score property holds while
  this doesn't.
- **Bars age** (`barsAgeTradingDays`, db/031): trading days from the
  newest bar to the *scan* date. Stored at the scan; recomputed later
  against "today", every signal reads stale.
- **Session classification** (`buySession`): `classifySession(date,
  <now>)` at the click. It's a fact about the moment of the add, and has
  no meaning re-derived afterward.
- **Hold time:** `holdSpan(position, <today>)` on every card and in
  `calcUnifiedRecommendation`. Correct live; meaningless re-read later.
- **The −6% floor's render-time read** (above): the same defect in its
  most expensive form. It was a verdict recomputed against "now" every
  time the screen opened, so the more often Roman looked, the more dips
  it caught.

**Found by the sweep that named it** (every clock read in the scorer and
the buy and sale capture code):
- **`unified_recommendation_at_sale` (and its factors) mixed two
  clocks. FIXED 2026-10-27.** `computeUnifiedSaleFields` called
  `calcUnifiedRecommendation` with the *entered sale price*, but that
  function counted hold days as `holdSpan(position, ptDateStr(getPT()))`,
  i.e. the day the sale was *recorded*. A Friday sale recorded on Monday
  stored the verdict for Friday's price at Monday's hold count. The same
  read was inside `calcPeakRiskScore`, so `peak_risk_score_at_sale` had it
  too. Both now take an `asOfDate`; a sale passes its sale date, and a
  live card still counts to today (`tests/at-sale-hold-count.test.js`, 4
  mutations caught). **Rows before the fix can't be corrected:** an
  at-sale verdict or peak-risk score is exact only where `sell_date`
  equals the PT date of the row's `created_at`. That comparison says which
  to trust, and it's written at the field in `writeTradeToSupabase`.
- **Same defect, engine side, FIXED 2026-10-27, before Warrior's first
  live use:** Warrior's `evaluateExit` read `getPT()` for its two
  time-of-day rules (12:30 close discipline, the 08:00 momentum window), so
  a Warrior at-sale status judged time-of-day at the moment of
  *recording*. It now takes `liveData.at`, the instant to judge, and
  behaves three ways:
  - **Omitted** (a live card): now, as before.
  - **Recorded on the sale date:** the recording instant, the best known
    time.
  - **Recorded on a later day:** `null`, because the sale form takes a
    date but no time. The time rules aren't judged, the reasons say so,
    and with no price rule to stand on the result is **CANNOT_EVALUATE**,
    never HOLDING: a missing input answered with a verdict is the same
    mistake as HOLDING on a missing price. The engine import's cache stamp
    is bumped, so a cached old module can't keep ignoring `at`.
    `tests/warrior-exit-time.test.js`, 7 mutations caught.
- **Weekdays, FIXED in the same change:** `buyDayOfWeek` and
  `sellDayOfWeek` were read from the recording day's clock. A backdated
  add, or a sale recorded a day late, stored the wrong weekday, which is
  what §3.3's Friday analysis reads. They now come from the entered order
  and sale dates, which are exact.
- **CORRECTION to the "correct as stored" list below: four of its fields
  are wrong for late recordings. Reported, NOT fixed.** `buyTime`,
  `sellTime`, `buySession` and `minutesFromOpen` are read from the clock
  at *recording*. The forms take a date but no time, so for an add or sale
  recorded on a different day from the event, these store the recording
  moment under the event's name. It's the "a value that doesn't describe
  its own row" shape. The honest value there is NULL (not recorded), but
  NULLing changes what the order-basis check (§5) and the session splits
  see, so it gets its own review. Until then, any of the four is
  trustworthy only where the event date equals the PT date of the row's
  `created_at`. **Measured on the existing 292 (§3.4, 2026-10-27):** no
  sale and no datable buy was recorded on a different day, and the
  stored buy times match the tape (68 of 70 in the 07:00–07:29 bucket,
  with a placebo confirming the test's power). So the defect is latent in
  this data, except for 14 ambiguous AFTER_HOURS rows and 24 undatable
  buys.
- **Correct as stored, listed so nobody "recomputes" them:**
  `barsSinceSignal` (minutes from the last scan to the click),
  `minutesFromOpen`, `buyTime` / `buyDayOfWeek` / `sellTime` /
  `sellDayOfWeek`. These are the moment itself, captured at it, *when
  the add or sale is recorded on the day it happened* (corrected above:
  the weekdays now come from the entered dates; the times are wrong for
  late recordings). The
  snapshot carries no scan timestamp, so `barsSinceSignal` can't be
  re-derived from it; the stored column is the only record.
**The score's independence from the clock is a PROPERTY, pinned
(2026-10-27).** The news-age line in `scoreStock` is the only clock read in
the scoring code, and it feeds `risk` alone (`calcRiskScore`), never the
score. The point function (`scoreComponents`) and `core/indicators.js`
read no clock at all. That's *why* a snapshot re-scores exactly (§5), and
it's what would quietly break if a future scoring term ever read the
time: the snapshot would still look reproducible, and wouldn't be.
`tests/scorer-clock-free.test.js` fails on any new clock read in either
file, and on the clock-derived value reaching the score (3 mutations
caught). If a clock-dependent term is ever genuinely needed, the snapshot
must store its value, and that test changes in the same commit, on
purpose.

**A value that doesn't describe its own row (named 2026-10-27).** This is
a third shape, distinct from both rules above. It isn't a value computed
against the wrong clock; it's a value stored *on* a row that was never
computed *for* that row: a shared object, read as though it were
per-item. **Instance:** `state.macroContext` is fetched once per session
(`runScreener`: "fetched once per session, cached") and reused by every
later scan, so a snapshot's `macroCondition` (and the macro adjustment
inside its score) is the condition at the session's *first* scan, not
necessarily at the scan that produced it. The row says which macro
condition applied, and for a later scan that can be another scan's
answer. **Same family as the modal overwrite** (above): `openStockModal`
wrote its own recompute of `consUpDays` and friends onto the shared
`state.signals` entry, so a stored component described the modal's
moment, not the signal's. The test for this shape: for every per-row
field, ask whether it was computed for this row, at this row's moment,
or copied from something shared. **It's the most portable question in
§7.7: one question catches every instance found so far.** It catches
the modal mutation (`consUpDays` written from the modal's moment), the
session-wide `macroContext`, the render-written peak price (a display's
moment stored where decisions read it), the stale `build_version` (one
hand-kept constant stamped on every row, stuck at v2.18.0 since
2026-09-15), and the recording-time `buyTime` / `sellTime` above (the
recording's moment under the event's name). Not fixed: refreshing the macro context
per scan changes the score's inputs, a step-2-sized change.

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

**The update banner was the same failure (found 2026-10-22).** The
"New version available" banner fires only when `sw.js` changes, and
`sw.js` changed only when someone remembered to bump its cache name by
hand, which stopped at `edge2-cache-v2.16.0`. So no new worker was ever
installed, the banner fired for no deploy since, the old cache was never
discarded (every versioned file from every deploy since September piled
up in it), and every "reload the app" instruction that day, Roman's
included, rested on a mechanism that couldn't detect staleness. It
looked maintained because the code that used it existed: `build_version`'s
family. **Fixed:** `CACHE_NAME` is `edge2-<the app.js ?v= stamp>`, so
each deploy changes `sw.js`, installs a new worker, fires the banner and
drops the previous cache. The worker reads its precache list from
`index.html` at install instead of a hand list. There's no build step,
so `tests/sw-cache-name.test.js` fails whenever the pair disagree.
Verified in a real browser: a changed `sw.js` installed a new worker,
fired the banner, and deleted both the previous cache and a planted
`edge2-cache-v2.16.0`.

**Build staleness, stated plainly so nobody tries to "fix" it:** GitHub
Pages serves `index.html` (and everything else) with
`Cache-Control: max-age=600`, and Pages sets that, not us. A reload
within ten minutes of a deploy can get the cached `index.html`, which
points at the old `app.js`. That is almost certainly why some of
2026-10-22's reloads did nothing. It can't be changed from the repo. The
honest handling is the build check (Portfolio footer, Settings): it
fetches `index.html` with `cache: 'no-store'` and a one-off query, so it
bypasses that cache and reports **stale** correctly even when the page
itself is stale. Three states, never "latest" by default: **current**,
**stale** (both stamps, "close the app fully and reopen"), **unknown**
(with why: offline, an HTTP error, no tag, or a server copy older than
the page). After a stale result, the app asks the browser to re-fetch
`sw.js` immediately.

**Trip-wire: the loggers read `app.js` and core files by text and by
name.** An incidental dependency there stops a whole day's logging the
moment someone edits an unrelated line: the loggers refused to run if
`const VERSION = '…'` was missing, a constant nobody would think of as
load-bearing. **Sweep, 2026-10-22:** the only text anchors are the EDGE
logger's two `loadFromAppJs` extractions (`const STOCK_UNIVERSES = {`
and `const BASE_SCORE_THRESHOLD = scoreThresholds().watch;`). The Warrior
logger no longer reads `app.js` text. `tests/code-version.test.js` now
checks **every** `loadFromAppJs` call (start anchor present exactly
once, end anchor after it), including ones added later. The sweep's last hole, the name lists
passed to `loadReal`, is closed by `tests/script-dependencies.test.js`:
every name in every `loadReal(file, [names])` call across `scripts/`
(71 names, in both loggers, `fill-outcomes.mjs` and the split audit)
must be declared at the top level of its target file. A renamed core
function now fails a test instead of the next cron run. Mutation-checked
by renaming `getLivePrice`: it failed, naming both loggers.

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

**Two rules for mutation checks, a pair (2026-11-02).**
- **A mutation the code swallows is not a mutation.** A rewrite that no
  input can tell apart from the original (db/035's `!x.asOf` for
  `x.state !== 'EARLIER_SESSION'`) is a refactor; drop it from the set
  rather than "killing" it with a lint, and test the invariant that makes
  it equivalent at the producer instead.
- **The rule's second catch (2026-11-05):** in `scripts/audit-first-hour-cell.mjs`, the Sunday orders fell on a day with no other cell, so real data could
  not detect them leaking into the same-day comparison. A mutant survived, and a fixture now reaches the hole real data can't.
- **A mutant must resemble the code it guards.** `tests/anon-write-paths.test.js`
  first matched a supabase-js chain only when a `;` came within 200
  characters, so it never saw the sale insert, whose object literal runs to
  thousands; the same flaw sat in the UPDATE/DELETE check, which had been
  accepted because it killed four mutants, all of them short. A mutation
  set drawn only from easy cases certifies the easy cases. From now on, any
  guard that parses or enumerates source gets at least one mutant built
  from the LONGEST and ugliest real instance in the repo, not from a short
  synthetic one.
  - **First catch, the same day (2026-11-02):** building
    `tests/empty-read-sites.test.js`, the 400-character window came back
    a second time. The longest real chain, the sale insert, turned out to
    hide a genuine read: `.select('id')` 4,161 characters after
    `.from('trades_v2')`. When that read comes back empty, the sale is
    reported written (correct), but `record.supabaseId` is never set, so
    later id-keyed updates of that sale miss it in silence. The window is
    now the whole statement.

**Reporting rule: every figure carries its source in its own line
(2026-11-02).** The source is one of: committed SHA, pin (a backup
revision), working tree, or live (with the time read). It goes in the
line that reports the number, not the paragraph around it. A number
without its tree or pin is unreadable, and twice in one day it cost a
round trip:
- the 19-row discrepancy compared a pinned backup against a live table;
- the carve-out's stamps were printed from the local checkout (mid-sync,
  before its uncommitted stamps were restacked) and read as the pushed
  commit 67308c3.

Same error, different tree.

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

### Open: the bottom nav sometimes sits at the end of the page (2026-10-27)

Roman: on any tab, intermittently, the nav doesn't appear until he scrolls
to the very bottom. **Not the containing-block cause.** `#bottom-nav` isn't
`position: fixed`; it's the last flex child of `#app` (`height: 100dvh`),
below the scrolling `#tab-content`, and no ancestor's transform, filter,
backdrop-filter, perspective, will-change or contain can capture it.
**Mechanism reproduced** on a static copy of the shell (real `styles.css`,
headless Chrome at 390×844): with `#app` held to the screen, the nav is
pinned; with `#app` unconstrained, the document grows and the nav lands at
its end, which is the symptom. **Trigger not reproduced.** Nothing in the
code can make `#app` grow (the scroll container's flex minimum is zero, and
the modal's `overflow: hidden` is restored on close), so `#app`'s height
stops matching the screen only when the phone's viewport changes under the
page. **Prime suspect (2026-10-27): Android Chrome's address bar.** Roman
is on Android in a Chrome tab (three-button system nav; the old dialogs
rendered as Chrome's "rocmp150.github.io says"), not iOS. Chrome's address
bar collapses and expands as you scroll, which changes the viewport height
mid-scroll; `100dvh` tracks that, and a transition caught while the page is
scrolled is where a flex child below a scrolling area lands below the
fold. "Intermittent, every tab, resolves when you scroll to the bottom" is
that signature. **The pair that tells it apart in one reading:**
`window.innerHeight` against `visualViewport.height` (recorded as `vvDiff`,
with `visualViewport.offsetTop`) at the moment the nav is off-screen. The
diagnostic records it and the Settings line leads with it ("window 780 vs
visible 724 (differ by 56)"). Also recorded: keyboard close, resume, modal
close and tab switch. **Asked of Roman:** his Chrome version, and whether
he uses a tab or a home-screen shortcut. The candidate fixes conflict: locking
the page's scroll fixes a scrolled document but would hide the nav if
`dvh` is reported too tall. So **a read-only diagnostic ships first**
(`checkLayout` in `app.js`, `tests/layout-check.test.js`). When the nav is
off-screen, the app is taller than the window, or the page has scrolled,
it records the window and visual-viewport heights, the app height, the
nav's bottom edge, the scroll offset, standalone mode, dvh support and the
last event (modal close, keyboard close, resume, tab switch). The last 20
are kept and summarised under Settings → App Info → Layout check. **The
fix waits for one recorded case.** No sticky nav and no scroll listener
moving anything.

### Open: "Closest to time limit" compares two scales (2026-11-02)

The portfolio's default order (named "Closest to time limit" when the sort
control shipped) ranks the share of the hold window used. **EDGE's share is
quantized to whole market closes** (closes held over the window: 0, 1/3,
2/3, 1 for a 3-DAY) **while Warrior's is continuous within the day**
(minutes since midnight PT over 12:30). On day 0 every EDGE position is 0
and every Warrior position is the same nonzero number, so **Warrior sorts
above EDGE all day on day 0 regardless of actual urgency**, and every
Warrior position ties with every other. That is a defect in the default
order, not in the sort control: the control kept the formula exactly and
added only the id tiebreak (`comparePortfolioCards`), so equal values now
come out in one fixed order instead of load order. **Its own change**:
the fix has to put both engines on one comparable measure (or rank them
separately), and that is a decision, not a refactor.

### Open: "Closest to time limit" reads an unrecognised duration as a one-day hold (2026-11-02)

The default sort key is `holdSpan(p).closes / (MAX_HOLD_DAYS[p.duration] || 1)`.
The `|| 1` keeps an unrecognised (or missing) EDGE duration from producing
NaN, but what it produces instead is worse: **the position is treated as a
one-day hold and sorts as maximally urgent.** NaN would at least have been
visibly unknown (`knownNumber` turns it into the unknown bucket); this is a
confident wrong answer in the key that is now the default order. Measured
2026-11-02 (`node scripts/count-portfolio-urgency-unknown.mjs --rev d6e277d
--today 2026-11-02`): 0 of 451 sold positions and 0 open positions have an
unrecognised duration (every row is DAY, 3-DAY or WEEK). **Not changed:**
the fix (an unrecognised duration is unknown, not 1) changes the default
order, so it belongs with the cross-engine scale defect above, in the
default order's own change.

### Open (wording, low priority): "Highest current score" claims more than is checked (2026-11-02)

`portfolioScoreState` ranks a score only if it was scanned after the most
recent open by the current formula. It does **not** check which daily bar
the score was computed on (a post-open scan can still have read yesterday's
dailyBar, and the owned-ticker refresh stamps no `dailyBarAsOf` at all; see
below). Roman will read "current score" as "scored on today's price". The
code comment says what is and isn't checked; the label doesn't. It closes
when the owned-ticker refresh gets its freshness stamps and the sort also
refuses a score whose dailyBar was an earlier session's; until then the
label overstates.

### Open: an unparseable bar date reads as age 0, i.e. CURRENT (2026-11-02)

`tradingDaysBetween` counts with `while (cur < end)`, and an Invalid Date
compares false, so a bar date that doesn't parse (`''`, `'x'`, a truncated
timestamp) gets age **0**. `barsFreshness` therefore reports such a history
or dailyBar as today's: STALE_BARS and STALE_DAILY_BAR pass it, the card
calls it CURRENT, and the logger writes it to `signal_log.bars_as_of`
alongside age 0. Unknown read as fresh: the three-state rule's exact
failure. Found by probing `dailyBarSessionAge` for an input that could
separate two mutants. Not observed in the data; Alpaca's `t` is an ISO
timestamp. Fix: an unparseable date is unknown (`null` age), in
`barsFreshness`, one place for every reader.

**Stored data, 2026-11-02: zero, and zero by the schema, not by luck.**
`node scripts/audit-unparseable-bar-dates.mjs --rev d6e277d`: 0 of 1,338
`signal_log.bars_as_of` (each equal to the max of its own snapshot's bar
dates), 0 of 166,314 snapshot bar dates, 0 of 159 `trades_v2` dates, 0 of
11,013 buy-snapshot bar dates. That count could not have been anything
else: the columns are Postgres `date`, so a non-date insert is rejected
(the logger then exits 1 and the run fails, recorded in `workflow_runs`),
and db/031's backfill cast `::date` would have aborted on one bad value.
The failure mode was never "a wrong stored date"; it was "a failed run".
Every failed run on record has an established cause, none a date
rejection (2026-11-02 enumeration).
**The same loop, the same collapse, NOT fixed by that change:**
`marketClosesHeld` (holdSpan: the hold count on every card, the default
sort key, the exit window, stale pending orders, and the AT-SALE hold
count, which is stored) and `businessDaysBetween` (one log line in
fill-outcomes). Their inputs are Postgres `date`/`timestamptz` today, so
they are schema-valid, but an unknown start date would read as 0 closes,
"same day". Its own change.

### Decided: a stale quote qualifies a display and withholds a record (2026-11-02)

**The principle, stated generally because it will come up again: a DISPLAY
can be qualified by its state. A RECORD cannot.** A number shown on screen
can carry a marker that says what it is; a number written into the data
cannot, because the record outlives the screen and nothing reading it later
sees the marker. So when the quote is an earlier session's close (no trade
on the feed yet today; `displayQuoteAge` EARLIER_SESSION_CLOSE):

- **The exit verdict is computed and marked**, never blocked. Blocking is the
  worse failure: a position that needs selling silently stops getting a
  verdict. Both banners (EDGE's and a registered engine's) carry the same
  tag as the P/L: "Computed on the YYYY-MM-DD close".
- **The nav badge counts it, and says so.** Its warning count includes
  verdicts computed on an earlier close, and the badge is marked when any
  are.
- **The summary totals include it, and disclose it** ("Includes N positions
  priced at an earlier session's close").
- **Mark as Sold does NOT pre-fill it.** The pre-fill becomes the recorded
  sale price, and a wrong sale price corrupts the P/L history permanently
  and silently. The field stays empty, the notice says which close was
  withheld, and Roman enters the fill.

One state, one source: every one of these reads the same `quoteAge`
computed once per card in `renderPortfolioTab`. Out of scope, and open: the
stock modal's verdict reads a different price (the last IEX minute bar),
whose staleness this state does not describe.

### Open, HIGH PRIORITY: `scanFreshness` throws on a dailyBar with no `t` (2026-11-02)

`core/clock.js scanFreshness` passes the snapshot's `dailyBar` to
`barsFreshness`, which reads `bar.t.slice(0, 10)`. A `dailyBar` without `t`
throws a TypeError. Both scans call it inside the per-ticker scoring map
(`app.js runScreener`, `scripts/log-signals-edge.mjs`), so **one malformed
snapshot ends the whole scan: no signals at all, not one degraded card.**
Found while building the portfolio sort, whose own reader
(`displayQuoteAge`) now refuses an undated dailyBar as UNJUDGED; the scan
path was left for its own change. The fix is the three-state rule: no date
is unknown (`dailyBarAsOf: null`), never a throw. Not observed in the data
yet; nothing in the code prevents it.

### Open: the owned-ticker refresh scores without freshness stamps (2026-11-02)

`runScreener`'s step 7b re-scores held tickers the main scan never reached
(failed the price/volume filter, or outside the selected universe). It
calls `scoreStock` and stores the result in `ownedScores`, but **does not
apply `scanFreshness` or `barsFreshness`**, so those signals carry no
`dailyBarAsOf`, `dailyBarAgeTradingDays`, `scanSession` or `barsAsOf`.
Consequences: the entry gate's STALE_DAILY_BAR and STALE_BARS can't judge
them (unknown passes), and a held ticker's score can be computed on
yesterday's dailyBar and still rank as current in the portfolio's "Highest
current score" (which checks when the scan ran and which formula ran it,
not which bar it read; see `portfolioScoreState`). Fix: stamp the refresh
exactly as the main scan does, one helper for both.
### Decided: the at-sale verdict is not computed; stored ones are marked (2026-11-02)

**What was wrong.** `computeUnifiedSaleFields` computed the exit verdict
when a sale was *recorded*, from inputs of several moments: the sale's
price and date, but `rsi = rsiAtBuy` (the card passes live RSI, so a
stored label can never equal what the card showed, for any trade),
`prevRSI`/`peakPrice`/`momentumProtectionActivated` from whichever
Portfolio renders happened, the recording session's macro condition, and
`currentSignalForHolding` at recording, which for a sale recorded after the
fact is a scan taken after the sale: **post-sale data in the record of the
sale.** The factor "RSI declining from peak (X → Y)", −30, compares a
render-time RSI with the buy's RSI; it is in 10 of 451 stored verdicts
(4 of them LOCK IN PROFITS), and in 3 of them X equals Y ("92 → 92").
`peak_rsi_during_hold` fell back to `rsiAtBuy` when no render saw the
position.

**Who read it.** No script. Four sections of the app's generated EDGE
report: the recommendation-at-sale counts, UNIFIED RECOMMENDATION AT TIME
OF SALE (label distribution with average outcome per label, top factors),
WINNER EXIT TIMING (LOCK IN / HOLD STRONG outcomes, held-past-LOCK-IN,
peak-RSI buckets, peak-risk factors), and URE FACTOR ACCURACY (factor
presence in wins vs losses). Expectancy, win rate, P&L, the sell-timing
"Did I sell too early?", the floor scoreboard and the forward test read
none of it. Retracted: phase-9 §0.1's "22 of 37 sold while showing HOLD
STRONG" and §4.4's quoted distribution (struck, with what replaces them).

**The ruling.**
- The 451 stored verdicts can't be recomputed (the sale-moment inputs were
  never captured). They are MARKED: `trades_v2.verdict_provenance`
  (db/035), write-once, `sale_moment` / `mixed_moment` / `not_recorded`.
  Every stored verdict is `mixed_moment`; rows without one `not_recorded`.
  The reason for marking is not a reader (only the report reads them, and
  it is now gated) but the two populations: once forward writes change,
  nothing else would tell them apart (taken_resolution, code_version).
- **Forward: no verdict is computed at sale.** `verdict_provenance =
  'not_recorded'`, every verdict column an explicit NULL (never a default:
  db/035 drops `lock_in_profits_fired default false`). Recorded instead:
  the facts (price, dates; the hold is derived on read) and
  `signal_before_sale`, the last scan signal that PREDATES the sale with its
  own `scanned_at`, or `NOT_ESTABLISHED` with the reason.
- **`sale_moment` stays RESERVED: not cleanly detectable today.** Three
  inputs block it. (1) The sale's time is never recorded (the form takes a
  date; `sell_time` is the recording clock), so a same-day scan can't be
  placed before the fill, and only the PT date can establish "predates".
  (2) `prevRSI`, `peakPrice` and `momentumProtectionActivated` are render
  state with no sale-moment value (§7.6 step 2.5). (3) The macro condition
  is the recording session's. A sale-moment RSI is computable (prior daily
  closes plus the sale price as today's close); the others are not. It is
  reserved and unused: see "The verdict saved with a sale", which names a
  fourth blocker, the scan signal, that keeps it unreachable.
- **The report is gated, not relabelled**, on `sale_moment`: each section
  says "No qualifying trades" with what it excluded and why. URE FACTOR
  ACCURACY hardest: it correlates factors with outcomes, and a factor from a
  post-outcome scan can produce a correlation that doesn't exist. The
  peak-RSI buckets and "held past LOCK IN" are LEFT OUT, with the reason,
  until §7.6 step 2.5: `peak_rsi_during_hold` is render-dependent and
  nothing marks which rows aren't.
- `marketClosesHeld` travels with this change on the weaker reason: the
  at-sale hold count is not a column (`daysHeld` is derived on read); the
  hold count reached stored data only inside the verdict's window factors,
  which are no longer computed. Its inputs are `date`/`timestamptz`
  columns, so its bad-date collapse can't have fired in stored data.

### Withdrawn: Monday insurance crons for EDGE (2026-11-02)

~~On Monday 11-02, Warrior delivered only through its two "Monday insurance"
crons (07:32Z and 08:20Z), which fired about ten hours late (17:22Z,
18:26Z). EDGE has no insurance crons, and as of 19:10Z no EDGE run existed
at all, not even a GitHub-created one. That is evidence for giving EDGE
the same spread insurance crons.~~

**WITHDRAWN the same day, by the day's own evidence.** EDGE's crons did
land, all in one displaced bunch: 10:35Z fired at 20:28Z (12:28 PT, the
one real scan: 80 scored, 159 pre-filtered), 11:15Z at 20:46Z and 11:50Z
at 20:54Z (both correctly no-op'd by the 30-minute spacing rule), 12:25Z
at 21:48Z (no-op, after the close). Warrior's insurance crons fired about
ten hours late too: they delivered something because Warrior runs more
crons, not because spreading them helped. Crons spread across the morning
land in the same ten-hour-displaced bunch, after the close, exactly as
EDGE's did. Adding crons would only have let us believe otherwise.

**The conclusion: GitHub's scheduler cannot deliver time-of-day-sensitive
collection.** The delay moved from landing EDGE runs BEFORE the buy window
(05:40-07:37 PT the week of 10-26) to AFTER it (12:28 PT on 11-02); both
miss. No cron arrangement fixes a ten-hour queue. **The 30-minute spacing
rule behaved correctly** on 11-02 (it suppressed two bunched duplicates and
let the one real scan through); it is not the defect and is not to be
"fixed".

### Process note (low priority): test rows in production (2026-11-02)

A hand-inserted verification position (`ZZVERIFY`, `position_id`
`verify-step6-disposable`, 10 sh @ $5, 2026-09-06) sat in the production
`portfolio` table for four days, showed as a holding in Roman's app, and
was deleted with no record, so finding it again in the backups cost an hour
of tracing. Rule from now on: a test row written to production carries a
documented marker (a `ZZ`-prefixed ticker plus an id beginning `verify-`)
and a named cleanup step in the same change, recorded here when it runs.
Prefer no production rows at all: rolled-back transactions (the db/035 and
db/037 behaviour runs) leave nothing behind.

### Rules and findings landed ahead of the observe-only build (2026-11-04)

**Rule: text that states a threshold, version or count is GENERATED from
the value (2026-11-02).** It is never written beside the value, and a test
fails when the value moves and the text doesn't.
- **Why:** three false statements sat beside numbers: db/027's sell_time
  comment, the overlay hint, and the banner's "score 50+" for a cut of 65.
- **What the sweep found:** both scoring legends were wrong.
  - Settings said volume 0–30, RSI 0–20, "Total (capped) 100" and labels
    80/50/20. Scoring v2 is −10..+20, −10..+20, uncapped, 110/65/20.
  - The report pasted into Claude said RSI <35 = 10 (it's 0 since step 2)
    and "rewards RSI 50-65" (it's 55–65).
  - The report's bucket labels put v2 RSI <35 trades under "RSI 65-75".
    **Did any quoted RSI figure come from those buckets? No (2026-11-03;
    `node scripts/audit-rsi-figures.mjs`, guard
    `tests/rsi-figure-provenance.test.js`).** Not a retraction:
    - §1, §2, §3, §3.5 (the 270 trades): parsed from the report's per-trade
      history, using each trade's own RSI (see the Appendix), not its buckets.
      They now recompute from `rsi_at_buy` at 80f52fb: n, win rate and dollars
      exact, averages within 0.01 (the parse used 2-decimal text).
    - The forward figures, "63% against 73%" included:
      `report-forward-test.mjs --rev 0775407`, from `rsi_at_buy`.
    - §7.2, "−0.04 points at 30 minutes" included: signal_log, each signal's own
      snapshot RSI, at 80f52fb (664 rows, 18 dates; +3d recomputes as +1.24 against
      the table's +1.23). The §7.2 withdrawal about the noon-hour rows still stands:
      the figure is right and what it can support is narrow.
    - The buckets couldn't have produced them: their edges are 35, 55, 65, 75, and
      the quoted bands turn on 45 and 58. Pre-v2 their labels were true: "Got 0" held
      RSI 66.7–72.9 at 80f52fb. The false legend only touches scoring-v2 trades: at
      0775407 "Got 0" holds 8, 6 of them RSI <35, and no spec figure quotes it.
    - That bucket still merges the two ranges, labelled as such: read no RSI band
      from it.
- **Now:**
  - the points are computed by calling `scoreComponents` at each band's
    probe;
  - the band boundaries are written once, and probed either side by
    `tests/generated-text.test.js`;
  - labels come from `scoreThresholds()`;
  - `RAW_SCORE_MAX` must equal the computed sum;
  - the detection thresholds (1.3×, 8–15%, RSI 45) are checked against
    `scoreStock`'s literals, which can't be referenced without moving the
    hash.
  - the 60+ snapshot cut, the duration ranges and the workflow-health limit
    are generated from their constants.
  - 6 mutants killed, three of them moving the scorer itself.

**Rule: a layout assertion in a test is not a substitute for rendering it (2026-11-04).**
Anything that carries a warning gets both: a test, and a render at phone width that someone
looks at. Two defects got past tests and were found only by looking, both at 390px. The
market banner's fixed 36px clipped its text, so "HUN sale NOT recorded" lost its ticker on
main while every other failure sat hidden behind it; the tests read its HTML and passed.
Then "NOT RECORDED" clipped to "NOT RECO…" on the macro line, after a test had already
asserted that the line can't wrap. The test held. Not wrapping is what caused the clip.

**The queue tests, and a failure that is UNEXPLAINED (2026-11-03).**
`tests/queue-pacing.test.js` failed once, at 23:26Z on 11-03, in a full strict run:
serial, nothing else of ours running. It then passed on every rerun. It was written
off as "load-sensitive", with no evidence: `scripts/run-tests.mjs` runs files one at a
time, and 3 runs under 12 busy processes on 8 cores all passed. **The cause is not
known, and whether there is a defect in real pacing is not known.** "Nothing else of ours running"
is not something any surviving record can show: the transcript here starts at 01:38Z on 11-04. The runner had kept
only the test's name, so the numbers are gone; it now keeps the assertion's message.
- `queue-pacing`, `concurrency` and `priority-ordering` run on `_lib.virtualClock`, so
  they are deterministic. They prove the bucket's arithmetic and can't see real timers.
- `tests/queue-pacing-real-clock.test.js` (slow, about 25 s) is the check on real
  pacing. Never faster than refill paid for: a hard failure, always. Too slow: a failure
  unless a probe shows timers ran late, when it says NOT JUDGED with its numbers. If the
  original failure recurs, this is where its numbers will be. Three runs under those 12
  busy processes (live, 2026-11-04): 171–172/min, timers p95 58 ms late. Load slowed the
  timers and not the rate, which counts against "load" as the explanation.

### THE SLOPE IS THE REASON DB/039 IS THE HIGHEST-VALUE ITEM IN THE QUEUE (2026-11-04)

Within a day, across 1,354 EDGE rows shown and below the cut, the point estimate of return
per score point is on the wrong side of zero: −0.0062 points at the close for rows first
shown before 10:00 PT (se 0.0079, 14 days), −0.0030 across all rows (se 0.0044, 27 days).
Source: signal_log at 8535a85, by `scripts/macro-sign-horizon.mjs`, which is on the local
gated branch and not yet on main. Scoring versions are mixed in these rows.

**Both are well inside noise. This is not a finding, and no conclusion follows from it.** It
is the same signal_log whose coverage §7.2 was withdrawn over. But the score is the central
premise of the app: it ranks stocks by it, and Roman buys from the top of the list. And §7.2
had already reached "no RSI band predicts the immediate move" from another direction (one
component, withdrawn for its coverage; this is the whole score). So nothing yet measures this
properly, and it is not a macro footnote.

**db/039 exists to answer it:** does the score rank same-day return in the morning window
where Roman actually trades, exit-free? 44% of rating_snapshots rows at 8535a85 were captured
06:00 to 09:59 PT (1,412 of 3,184, over 30 days), where the logger's morning rows cover 14
days. Everything else built this week makes the records trustworthy; db/039 is what the
trustworthy records are FOR.

**db/039 is the BEST INSTRUMENT AVAILABLE, not a clean answer.** On the rows captured so far,
its limits are:
1. **60+ only.** Rows scoring under `RATING_SNAPSHOT_MIN_SCORE` aren't there (minimum 60,
   median 70, at 8535a85), so it compares near the top against near the top, not the top
   against the rest. A flat result inside that range would not mean the score ranks nothing.
2. **Only on days Roman opened the app.** See the assumption below.
3. **1,005 of the 3,184 rows were captured after the close** (16:00 PT on), with no same-day
   return to measure.
4. **Entry and exit are on different feeds.** Entry is the browser's IEX snapshot and the
   outcome is SIP bars, the venue error measured at 0-2.7% by IEX share.

**ASSUMPTION: the dataset exists only on days Roman opened the app, and we assume the days he
opened it are not different in a way that matters to whether the score ranks return.** This
is probably harmless, but it is an assumption, and nothing here tests it.

These limits print with db/039's coverage line, as its first condition requires.

**Order: the sell form's fill time first (half a session, and it unblocks exit-hour analysis
too), then db/039, then the verdicts.**

### Backups of signal_log and rating_snapshots are monthly files (2026-11-04)

`data/backups/signal_log.json` was 46.3 MB at f66fe02, growing 2.9 MB a trading day (20.6 MB
at de95a93 on 10-22), which reaches GitHub's 100 MiB block about 20 trading days on. A refused
push loses every table's backup that day, and the backup is the recovery path the auth plan
rests on. An earlier estimate of 41 days used compact row sizes; the committed file was indented.

- **Layout:** `data/backups/<table>/YYYY-MM.json`, one row per line, by `created_at` /
  `captured_at`. Only months whose text changed are rewritten. At the same rows, signal_log
  went from 46.3 MB to about 25 MB. Restore by concatenating a table's month files.
- **A pin needs `backupRowsAtRev` for commits after the move.** Scripts pinned to an older
  commit keep working, because the old file is still there at that commit. Scripts that take
  a commit as an argument already use it.
- **A daily read is not "new rows only".** signal_log rows are PATCHed for about 7.5 days after
  insert, and its ids are UUIDs. It re-reads 14 days, every unsettled row (141 older than the
  window, live 2026-11-04), and anything settled since the last run. rating_snapshots also reads
  by id, because a retried batch keeps its old `captured_at`.
- **Once a month a full read takes everything else** and records `changed_outside_window`.
  Until then, a PATCH to an old settled row (`audit-signal-log-splits.mjs`) is not in the
  backup. That is the cost of not reading everything daily, and that count is how to judge it.
- **The guarantee moved from a file's rows to the table's rows across all its files.** Refused,
  with nothing written and the run red: a month file missing or different from the last manifest;
  rows held (prior + read, by id) not exactly the live count, which sees a delete hidden by an
  insert; the floor or never-shrink rule on the total; any file over 90 MiB.

### EVERY READ PAST 1,000 ROWS (2026-11-04)

PostgREST answers any read with at most 1,000 rows, status 200 and no error. Live on
2026-11-05 01:43Z: signal_log 2,311, rating_snapshots 3,665, trades_v2 541, workflow_runs 377,
signal_snapshot_at_buy 188, scan_runs 124, trades 37, portfolio 11. Every read in the app and in
every script is now enumerated by `tests/unpaged-reads.test.js`: it pages, limits, or says why
it can't reach 1,000, and a new unpaged read fails it.

**What was actually cut:**
- **The score history report and the archive report (`rating_snapshots`).** The table passed
  1,000 rows on 2026-09-02 at 23:21 UTC. From then, the report said "Total snapshots recorded:
  1000" with a range ending 2026-09-02, and its "score trend" lines judged only those rows. The
  archive said "Rating snapshot total rows: 1000". **Nothing in this repo's specs cites either.**
- **`fill-outcomes` pending rows (`signal_log`), unordered: exactly 1,000 on 2 of the last 45
  runs, 2026-11-03T02:33Z and 2026-11-05T00:59Z** (Actions logs; the count rose from 308 on
  10-15). Returns only came late: the rows stayed pending, and the next run on 11-03 read 867. The
  risk was Pass 2, which resolves a symbol-day group permanently from the rows it read. **No
  group shows it:** `takenGroupProblems` finds 0 of 2,115 groups (194 with more than one row)
  in a state a whole-group resolve can't produce, on a full read at 2026-11-05 01:36Z. That read
  came after the first run and before any later run of 11-05 finished.
- **Reads that weren't cut yet:** the stale-unresolved check (945 live), the splits audit (would
  read the oldest 1,000 of 2,250 filled rows, but its last logged run on 09-15 read 95), and
  every `trades_v2` read.

**Rendering, extended (2026-11-04):** the rule above now applies to any text stating a number,
warning or not. "The warning is gone so the rule does not apply" is how a rule erodes.

**Figures from reports:** the report's trade sections read `trades_v2`, which has never held
1,000 rows, so §1, §2, §3, §3.5 and the forward test (292 and 451 trades) are not affected, and
signal_log figures came from scripts that page or from backups that page. The one way a report
figure is affected is if it came from a pasted score history or archive section: look for
"Total snapshots recorded: 1000" or "Rating snapshot total rows: 1000".

### TABLES WITH NO CREATE IN db/ (2026-11-04)

Five tables were created outside the numbered migrations: `db_meta`, `portfolio`,
`rating_snapshots`, `settings`, `trades`. **For these we don't know what constraints exist; we
infer the schema from behaviour.** Listed from a search of db/ against every table the code and
the backup use, kept true by `tests/tables-without-create.test.js`. The list can't show a public
table nothing here names: the anon key can't read the schema (REST root: 401, "Secret API key
required", live 2026-11-05).

This bears on the auth plan: step 4 writes policies against tables whose definitions we have
never read. `db/inspect-public-schema-read-only.sql` returns every public table's real
definition. It is one SELECT, not yet run. Until it is, nothing about these tables' constraints
should be stated as known; db/038 aborts on a CHECK on `rating_snapshots.score` or `label`
because it can't rule one out.

**engine_source is never NULL (db/041, 2026-11-05).** EGHT and CMPX, re-entered 2026-09-09 without an engine, are
set to EDGE by elimination, not assumption: no trade has ever been WARRIOR, and the app already reads a missing engine
as EDGE, so the record now says what the app believes. Both `trades_v2` and `portfolio` become NOT NULL. The
portfolio half goes beyond what was approved, and is declared: a sale copies its engine from its position, and positions
load only from portfolio, so with only trades_v2 NOT NULL a NULL position would make recording its sale fail, a gate on
recording. Guarded on exactly those two rows, no NULL position, and no WARRIOR trade.

**The schema harness (2026-11-05).** Roman ran the inspection query; its output is
`C:\Users\cmp15\edge2\live-schema-2026-11-05.json`, excluded from git in every worktree (never commit it: it maps the
production schema beside a public anon key). The harness lives outside the repo, in `C:\Users\cmp15\edge2-schema-harness`
(PGlite 0.5.11, pinned, installed with `--ignore-scripts`, no dependencies of its own; the repo keeps zero dependencies
and CI installs nothing). Before adopting it, a probe checked the role system, not just DDL: 20 of 20 (RLS refusing with
42501, `has_table_privilege` ignoring RLS, column grants, `pg_policies`, SECURITY INVOKER against DEFINER, FORCE RLS,
write-once triggers, event triggers, table comments). It reproduces a migration's defect before it tests the fix
(db/035 run 4's 3 of 4 came back first). **What it can't do yet:** the dump has no grants, so db/037, which only changes
grants, can't be tested until the live grants are dumped; and the dump has no server version (the probe ran on
PostgreSQL 18.6), so a version difference is not ruled out until `select version();` is run live.

**It has three dependents (2026-11-05):** auth step 4's policies, written against five tables whose definitions we
have never read; the backup's key uniqueness for four tables, inferred from data; and **a local schema to test
migrations against.** Without the real CREATE statements nothing can be reconstructed locally, so every migration
sent to Roman is untested against a real database until he runs it. A mistake fails loudly there, but the time it
costs is his, which is the scarce resource. The third is the one that buys his time back.

**No rollback of db/035 may use CASCADE.** db/038 (gated) adds a write-once trigger on `trades_v2` that calls db/035's
`trades_v2_reject_provenance_change`, and aborts if that function is missing. That guards the forward case only.
Backwards, a plain `drop function` is refused by Postgres while a trigger uses it, which fails loudly and is fine;
`drop function ... cascade` would remove db/038's trigger with it, quietly, and the verdict capture would stop being
write-once with nothing to show it.

### Why fill-outcomes went red on first runs (2026-11-04)

Seven red runs in 70 (2026-10-06 to 11-05, all logs read), every one the first of its day. Only
the first run has much to write. They are two different failures, and neither is an ordering
dependency between jobs. **Both have a fix on main. The second is not proven until the first
run after `baf67e1`.**

**What the stale check asserts:** at the end of a `--write` run, after its PATCHes, it reads every
`unresolved` row and fails if `signal_date` + 9 calendar days has closed. Pass 2 uses the same
constant and clock, so in one run any row Pass 2 saw has already been resolved.

| Failure | Runs | Cause | Status |
|---|---|---|---|
| `TypeError: fetch failed` | 5: 10-27T00:01Z, 10-27T23:55Z, 10-29T00:14Z, 10-30T00:08Z, 10-30T23:58Z | The re-select after the PATCHes put every id in one URL, at 408 to 597 ids (371 worked). It never reached the stale check. | Fixed 11-01, `9adf28c`. The 11-04T00:48Z run re-selected 541 and passed. |
| Stale check | 2: 11-03T02:33Z (5 rows), 11-05T00:59Z (9 rows) | Both read exactly 1,000 pending rows, so Pass 2 never saw these rows, while the check's own read did. | Paged, `baf67e1`. |

**The evidence for the second:** the check failed on 2 of 2 runs at exactly 1,000, and on none of
the others. The stuck rows are all from the date whose window had just closed. No candidate query
failed and every PATCH succeeded, so a row Pass 2 had read would have been resolved. On both days
the next run, reading under 1,000, made exactly as many transitions as there were stuck rows (5
and 5, 9 and 9). It is still an inference: no log lists the rows that weren't read.

**The ordering hypothesis doesn't hold.** Neither logger writes `taken_resolution`; a later
fill-outcomes run resolved these rows only because its read was no longer cut. Warrior rows being
named first is not a pattern: one of the 9 is EDGE, and the list has no order. **The check's window
is right, and it should not change.** It did its job: it was the only thing that noticed the
truncation, two days before anyone looked for it.

**Paging can't make the check fire more,** because it now reads the same complete set Pass 2 does.
It would still catch a real failure to resolve.

**Why 13 of the 14 stuck rows are Warrior: it is an artefact of those two dates, not of Warrior.**
Not because Warrior is never traded, though it never has been (0 of 492 `trades_v2` rows at
f66fe02): an untraded EDGE row waits for its window just the same, and at the backups before each
run Warrior was only 33 of 124 and 28 of 128 of that date's unresolved rows. **The stuck rows are
the last created that day:** positions 119 to 123 of 124 on 10-23, and 120 to 127 of 128 on 10-26.
On those two dates the Warrior logger ran after EDGE, so the tail was all Warrior. From 10-27 on,
Warrior logs first and the tail is EDGE. So the cut followed row order, and this adds to the case
for truncation. Why the read returned rows in that order isn't known (it had no ORDER BY), and one
row doesn't fit: EDGE COTY, position 77 of 128.

### A PAGED READ NEEDS A TOTAL ORDER (2026-11-04)

Without an ORDER BY Postgres guarantees no order. Roughly insertion order is what a sequential
scan usually gives, which is why the stuck rows above mostly followed creation order and why EDGE
COTY didn't. Offset paging over an unordered read can skip or repeat rows, more so under concurrent
writes, **with the row count still matching.** Every paged read must end its order on a unique key;
`tests/paged-reads-ordered.test.js` fails one that doesn't, per table.

**What shipped without it:**
- **The backup, from 2026-09-05 until `db41bfc`, for every table.** Its comment reasoned that a backup
  doesn't need a stable order. **No committed backup shows damage:** 0 repeated ids across all 36
  backups over 1,000 rows (9 of signal_log, 27 of rating_snapshots, at 92a77fa). Each read was required
  to match Postgres's count, so a skipped row would have to appear with a repeat. No pin is affected.
  That was luck, not a guarantee.
- **The backup's whole-file tables, still, until this change.** All under 1,000 rows, so one page.
- **`measure-iex-vs-sip-scoring.mjs`, broken by `baf67e1`:** ordered on `id`, which
  `signal_snapshot_at_buy` doesn't have. Its key is `position_id`. A live read would have failed
  loudly; `--rev` was unaffected. The test now checks the key per table.

**What a total order doesn't do:** an insert sorting before the current page can still repeat a row.
So reads drop repeats by key, and the deduplicated total is what must match the count. Month-file
backups merge by id and compare with a fresh count. **Uniqueness of `id` on `rating_snapshots`,
`trades`, `portfolio` and `settings` is inferred, not read,** as they have no CREATE in db/: the data
shows it, the schema inspection will confirm it, and a repeated key is refused, not trusted.
### Whether cross-test interference could explain the queue-pacing failure (2026-11-04)

"There's no parallel set to move it out of" was true of parallel files and was too broad as a dismissal.
**Interference from another process cannot be ruled out. Interference in memory can.** Failed in a full
run, passed alone is that signature, so the failure stays UNEXPLAINED.

| Route | Verdict | Why |
|---|---|---|
| Another test file's globals | Ruled out | `run-tests.mjs` gives each file its own process, one after another, so memory can't carry over. |
| Another test in the same file | Ruled out by reading | The version that failed (044bf0e) has two tests awaited in order, each on a fresh bucket, and stubs no console, Date or fetch. |
| Anything outside the process, on the wall clock | **Cannot be ruled out** | That version timed real timers, so anything stalling the machine reaches it: a process of ours, the OS, a sleep. The load test only exercised CPU, 3 runs. |
| The code under test at that moment | **Cannot be ruled out** | It ran on a working tree, and nothing records its state at 23:26Z. |

`queue-pacing.test.js` now runs on a virtual clock, so it can't recur there; `queue-pacing-real-clock.test.js`
is where it would show, with its numbers.

### `sell_time` means "recorded at", for every row ever written; the fill goes in `sell_filled_at` (2026-11-05)

**The decision.** A separate column makes the mistake impossible, and a shared one only makes it guarded. A
guard in the app's own reads doesn't protect a hand-written query in January. The sell form's fill time was
on main for about two hours as `644f5b0`, storing the fill in `sell_time`, and it has been taken back off.
**0 sales were written on that build** (of the latest 400 `trades_v2` rows, live 2026-11-05 05:17Z).

**A row with `sale_code_version.app = '20261105033000'` would hold a fill in `sell_time`.** A phone still on
that cached build could write one before it updates. None exists at the time above, and any later one is the
exception to the first line of this section.

**THE GAP, stated: between now and db/038, sales store no fill time at all.** The form doesn't ask for one,
because asking and discarding is worse than not asking. Exit-hour analysis has nothing to read until then, and
`sell_time` must never stand in for it. The field, `sell_filled_at` and its source ride with db/038, which also
corrects db/027's false column comment. Analysis has to handle a missing fill regardless ("Time not known"),
while nothing would have made it handle a column with two meanings.

### The verdict saved with a sale: A is the deliverable, B is not commissioned (2026-11-05)

Scoped 2026-11-03, when the build queue was set. **Roman's choice, 2026-11-05: A.** He asked whether
it is accurate enough. It is more accurate than B: B is a rebuild missing its largest inputs, and A
is a recording. Not built yet.

**A: the verdict as displayed, captured, not recomputed.**
- **What it stores:** the card's verdict verbatim, with its inputs (price and quote state, RSI, previous
  RSI, peak, momentum state, the signal's score and scan time, macro condition, hold count) and when
  it rendered. Nothing is recomputed. The card's verdict lives only inside `renderPortfolioTab`'s loop
  today, so the render keeps it in a per-position session cache and the sell form reads that.
- **That is a render-time write a record reads,** which `view-no-decision-writes` forbids. It is legitimate
  only because the captured object IS the display, so it is a declared entry on that ratchet.
- **Scoped cost, 11-03:** about half a session, plus one migration (`verdict_displayed_at_sale` jsonb, its
  state column, a CHECK, write-once, the column comment).

| State | Meaning |
|---|---|
| `CAPTURED_BEFORE_FILL` | The card rendered before the fill. |
| `CAPTURED_AFTER_FILL` | The card rendered after the fill. **The normal case, not a defect:** Roman records a sale after placing it. The report says it neutrally, as the gap in minutes, so a reader can judge whether it mattered on that row. |
| `CAPTURED_FILL_UNKNOWN` | The card was on screen, and nothing places it against the fill: "Time not known", or an accepted default. |
| `NOT_DISPLAYED` | No render was available for this position, or the sale is recorded on a later day. |

**Only an entered fill can place the card.** An accepted default can't: the field starts when the form opens,
after the card rendered, so comparing against it would always say `CAPTURED_BEFORE_FILL`, which is false. **Until
db/038 stores a fill and its source, every captured card is `CAPTURED_FILL_UNKNOWN`.** The before/after split
isn't available sooner than that.

**The report gives the distribution of recording minus fill, in minutes,** so "a few minutes" is measured, not
assumed: `created_at` minus `sell_filled_at`, on `entered` rows only. **It isn't published before db/038:** defaults
sit near zero by construction and would make it look better than it is. Until then the report says why it is
absent, rather than showing an empty section.

**B: the verdict reconstructed as of the fill, from bars. NOT COMMISSIONED, and nothing is built on
`signal_before_sale` to approximate it.** `signal_before_sale` (db/035) serves the analysis angle by itself.

**`sale_moment` stays reserved and unused.** It is reserved for a verdict whose every input comes from the
fill moment, which is currently unreachable, because of four blockers:
1. The fill time: solved with db/038, where one was entered.
2. `prevRSI`, peak and momentum protection are render state: addressable through §7.6 step 2.5, not built.
3. The macro condition: dissolved by the observe-only pin, once it ships. With the overlay pinned the macro
   factor drops out of the verdict entirely. It is not listed at zero (the real function, on the gated
   branch: `RISK_OFF` pinned gives 105 and 7 factors, none macro; unpinned 85 and 8, with `Macro: RISK_OFF`, −20).
4. **The scan signal and the snapshot, the reason it stays unreachable:** the score, volume ratio, distance
   from the 20-day MA, catalyst, up-day count, today's high and the previous close have no value at the fill.
   News isn't stored, and partial-day volume at a past minute isn't known. The last scan before the sale is
   a different moment.

**A doesn't depend on step 2.5.** Roman's complaint was that a stored label could never match the card. A stores what the card showed, verbatim, so the two match by
construction, whatever the inputs were. What A inherits is their quality: the captured verdict can carry a render-dependent factor, "RSI declining from peak (92 → 92)" among them, and
it says what was on screen, not what was true. Step 2.5 is what fixes the inputs, for the card and everything downstream, and it is a separate decision.

**Sizes, estimated from reading the code on 2026-11-05, not measured, for the reviewer. Nothing goes to Roman until the reviewer has ruled.**
- **A: about half a session, plus one migration.** As scoped on 11-03. Every captured card is `CAPTURED_FILL_UNKNOWN` until db/038 stores a fill, and its column could join db/038 while that is unrun.
- **Step 2.5: about 2 to 3 sessions, and no SQL expected. Parked behind db/039 and Roman's SQL (2026-11-05): measured at zero label changes, so it fixes the record rather than the recommendation (§7.6 step 2.5).** The derivation mostly exists for the display panel (`computeIntradayPanel`, `fetchIntradaySipBars`).
  - Hold high, with its split check, IEX fallback label and NULL on a partial fetch: about half a session.
  - The exit engine's inputs, "computed from 7 of 9 factors", and the renamed day-over-day RSI factor: about 1 session. It is where the risk is: the inputs have 77 references, and the exit advice changes.
  - The render stops writing, and the sale's recorder fields derive from bars: about half a session. The three `backgroundSavePosition` calls go, which closes the surface the resurrection race used.
  - Tests, mutants and 390px renders: included above, and about half a session on top if the render finds what it usually finds.
  - Requests are not the constraint: 11 positions at the latest backup, about 2 calls each, against 170 a minute, with daily bars cacheable for the day.

**The fill is back on the 11-03 scope,** in its own column (see "`sell_time` means "recorded at""). One declared
departure from it: the source column is `sell_filled_at_source` with `entered` / `default` / `not_known`, because
a stored source is what separates a typed fill from an accepted default, and the scope's "auto-now" state is what
`default` records.

### The win/loss ratio question is OPEN AGAIN (2026-11-05)

"The binding problem is the win/loss ratio" came from +$8.96 and −$16.69, quoted as current all week. Those are the first 292
trades, all before scoring v2 (`trades_v2` at 164099a; the same figures at 80f52fb).

| Population | Trades | Win rate | Avg win | Avg loss | Ratio | Expectancy | Position |
|---|---|---|---|---|---|---|---|
| Before v2 | 292 | 55.2% | $8.96 | −$16.69 | 0.54 | −$2.34 | $408 |
| Scoring v2 | 249 | 59.6% | $10.98 | −$10.57 | 1.04 | +$2.24 | $563 |
| All | 541 | 57.3% | $9.96 | −$13.93 | 0.72 | −$0.24 | $480 |

Under v2, break-even falls near 49%. **That doesn't show v2 fixed it.** The 249 trades were bought on just 7 dates (10-27 to 11-04), so
the effective sample is seven days, not 249 trades; they overlap a period already known to have been favourable; and scoring wasn't the
only change. The honest position is that the ratio question is open, and neither population should be quoted alone.

### Buys stamped inside the blocked window (2026-11-05)

**48 of the 249 v2 buys, 19%, are stamped 07:00 to 07:29 PT** (`trades_v2` at 164099a), the window with evidence against it. The gate
warns and doesn't prevent, deliberately: a gate on advice must not block recording.
- **What they are:** all 48 are market orders, on weekdays, in the REGULAR session, and each was added to the app in the same minute as its
  stamp. None is a Sunday-style order or a pre-market order filled at the open. None is before 07:00.
- **On four dates:** 10-28 (9), 10-29 (3), 11-03 (17), 11-04 (19). The effective sample is 4 days, not 48 buys.
- **The stamp is the recording clock.** So it says when he recorded the buy, which is at or after the buy. On the SIP tape, within a minute of
  the stamp, the buy price traded on 38 of the 48. It didn't on 10, so those were bought earlier than stamped or have some other mismatch, and
  this can't say which. For the 38, the tape is consistent with a prompt recording, but a price that traded then may also have traded earlier.
- **36 of the 48 were sold within the hour.** Their outcome isn't computed here.
- **So the 48 may understate how early he is buying, not overstate it.** A stamp at 07:05 means the buy was at or before 07:05, so some of these may
  have been bought before 07:00, which is the 06:30 to 07:00 window that Roman's timing analysis calls unjudged at n=5, not safe. The 10 non-matching rows, and DNUT matching only
  pre-market, point the same way. If a broker export ever arrives, those 10 are among the rows it would settle.

### The 07:00–07:29 cell on the whole book (2026-11-05)

An update of §3.4, not a separate thin cell: `node scripts/audit-first-hour-cell.mjs`, `trades_v2` at 164099a. Same method as the timing analysis, and it
excludes the same rows: 22 `sell_price_unverified` and the 18 rows of the 9 resurrected pairs, so 501 of 541 sold trades. It reproduces the published cell
first: n=70, −$377.03, 14 days at b4620bc, and the same 252 population.

| 07:00–07:29 | n | Days | Win | Avg | P&L | Minus best trade | Profitable days |
|---|---|---|---|---|---|---|---|
| **Whole book** | **118** | **18** | **50.4%** | **−0.95%** | **−$400.28** | **−$440.28** | **5 of 18** |
| Before v2 | 70 | 14 | 51.4% | −1.48% | −$377.03 | −$411.53 | 4 of 14 |
| Scoring v2 | 48 | 4 | 48.9% | −0.18% | −$23.25 | −$63.25 | 1 of 4 |

| Other cells, whole book | n | Days | Win | Avg | P&L | Minus best trade | Profitable days |
|---|---|---|---|---|---|---|---|
| 06:30–06:59 | 5 | 5 | 100% | +1.14% | +$13.05 | +$8.05 | 5 of 5 |
| 07:30–09:59 | 245 | 21 | 64.0% | +0.33% | +$568.40 | +$438.40 | 12 of 21 |
| 10:00 on | 133 | 21 | 48.1% | −0.86% | −$267.00 | −$310.50 | 9 of 21 |

**The cell's own figures hold on 18 days, and v2 has not reversed them.** They are milder under v2: −0.18% against −1.48%, on 4 days, which can't say whether the cell has improved or those days were kind. **What that does not establish is corrected in the next section: compared on the same days, the difference is not clear.**

**What limits it:**
- **Stamp, not fill.** The stamp is at or after the buy, so a row here may have been bought earlier. On the tape, 45 of the 48 v2 buys traded within ±10 minutes of the stamp, the test §3.4 uses (68 of 70 before).
- **2 buys stamped in the cell were still open at the pin** (BEKE and AGNT, 11-04), so they aren't in these figures.
- **06:30–06:59 is still n=5, all before v2.** It isn't evidence that earlier is safe.

### The cells split, and on the same days (2026-11-05)

`node scripts/audit-first-hour-cell.mjs`, `trades_v2` at 164099a, the same 501. **The 24 Sunday orders are out of these cells:** one evening, 09-27, stamped 07:xx (14) and 16:xx (10), −$213.25, 0 of 1 days, and none of them is a trade at that time of day. They had been inside "07:30–09:59" and "13:00 on".

| Whole book | n | Days | Win | Avg | P&L | Minus best trade | Profitable days |
|---|---|---|---|---|---|---|---|
| 07:00–07:29 | 118 | 18 | 50.4% | −0.95% | −$400.28 | −$440.28 | 5 of 18 |
| 07:30–09:59 | 231 | 20 | 66.2% | +0.53% | +$734.15 | +$604.15 | 12 of 20 |
| 10:00–12:59 | 96 | 15 | 50.0% | −0.30% | −$41.65 | −$85.15 | 8 of 15 |
| 13:00 on | 27 | 10 | 44.4% | −2.45% | −$177.85 | −$188.85 | 3 of 10 |

| Before v2 | n | Days | Win | Avg | P&L | Minus best trade | Profitable days |
|---|---|---|---|---|---|---|---|
| 07:00–07:29 | 70 | 14 | 51.4% | −1.48% | −$377.03 | −$411.53 | 4 of 14 |
| 07:30–09:59 | 65 | 13 | 63.1% | −0.11% | +$87.10 | −$42.90 | 7 of 13 |
| 10:00–12:59 | 61 | 12 | 57.4% | −0.22% | +$25.15 | −$5.85 | 6 of 12 |
| 13:00 on | 27 | 10 | 44.4% | −2.45% | −$177.85 | −$188.85 | 3 of 10 |

| Scoring v2 | n | Days | Win | Avg | P&L | Minus best trade | Profitable days |
|---|---|---|---|---|---|---|---|
| 07:00–07:29 | 48 | 4 | 48.9% | −0.18% | −$23.25 | −$63.25 | 1 of 4 |
| 07:30–09:59 | 166 | 7 | 67.5% | +0.78% | +$647.05 | +$577.75 | 5 of 7 |
| 10:00–12:59 | 35 | 3 | 37.1% | −0.43% | −$66.80 | −$110.30 | 2 of 3 |
| 13:00 on | 0 | | | | | | |

**Compared on the same days, it is not clearly better.** A cell comparison also compares which days each cell fell on.
| Same days, average percent per trade | Better on | Mean difference | Sign test, one-sided |
|---|---|---|---|
| 07:30–09:59 against 07:00–07:29, whole book | 7 of 12 days | +0.96 points, mostly two days (09-29, 08-17) | p 0.387 |
| The same, before v2 | 5 of 8 | +1.23 points | p 0.363 |
| The same, v2 | 2 of 4 | +0.43 points | p 0.688 |
| 07:30–09:59 against 10:00–12:59, whole book | 4 of 10 | −0.06 points | p 0.828 |

**What this supports:**
- **07:30–09:59 has done best in aggregate, but most of that is one stretch.** 166 of its 231 trades and +$647.05 of its +$734.15 are v2's seven days, and before v2 it loses without its best trade. It is not yet a timing result.
- **That doesn't show the 07:00–07:29 cell is harmless either.** 12 shared days can only detect a large difference, so this isn't a null to quote as "the hour doesn't matter".
- **10:00–12:59 is neutral at best,** and on the same days not distinguishable from 07:30–09:59.
- **13:00 on is the poorest cell, and there is nothing to stop:** no buy stamped after the close since 09-30, none under v2. By §3.4, 14 of its rows may be closing fills typed in later.
- **§3.4's standing instruction holds:** cite the rule "as a precaution in force, never as evidence that early entries are bad." Its third confound, early-scan bars, is also untested here.
- **Nothing about time of day is established.** The wording for Roman: the gate stays a precaution; 07:30–10:00 has done best overall but mostly in one good week; on days he bought in both windows the difference is unclear; the after-close cell was poorest and he has already stopped.

BEKE and AGNT (11-04) were still open at this pin, so a later rerun's n differs for that reason.
