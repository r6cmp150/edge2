# Phase 10 — entry timing: findings and spec

From the 2026-10-21 report (292 closed trades, 270 resolved). Goal
Roman set: **the stock should go up right after he buys**, instead of
stagnating or dropping.

All times Pacific. Market opens 6:30am PT, closes 1:00pm PT.

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
  `not-measured` and every column is NULL.
- **NULL is a finding.** Never 0, never the buy price. `??` not `||`.
  A horizon that falls outside market hours stays NULL rather than
  borrowing the nearest print.
- **SIP, not IEX**, for the same reason the intraday panel uses SIP: an
  excursion computed from one venue is the excursion of a fraction of
  the volume.
- **Backfill is retrievable.** Minute bars are available on demand for
  every past fill — this is the move that let `position_bars` be deleted.
  The whole history can be filled in from the existing fill timestamps,
  except the 24 Sunday rows and the first 37 trades, which need Roman's
  broker export first.

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
