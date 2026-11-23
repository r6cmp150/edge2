# Field provenance: everything that enters a trade record or a score

Ordered by the reviewer on 2026-11-20 (CC-romans-call-audit, section 3). Written on 2026-11-22, at the close of the
audit phase.

**The rule this list applies:** every value that enters a decision carries its provenance, and a value that could not
be measured is absent, never replaced.

**Each field is in exactly one of three states, and nothing else:**

- **provenanced**: the value records where it came from, and a value that could not be measured is absent rather than
  substituted.
- **can be fabricated**: there is a path by which a substituted, defaulted or coerced value reaches it.
- **not established**: nobody has checked.

"not established" is the honest default.

**The Clock column is machine-readable** (the reviewer, 2026-11-23): which clock a time-bearing field was read from.
The values are the add, the save, the scan, the render, "typed, or the form opening", and — for a field that is not
a time. **THE RULE: two fields sharing a clock may not be compared as evidence about timing.** Their agreement checks
the arithmetic between them and nothing else. tests/same-clock-guard.test.js reads this column and holds every analysis
script to it.

**Where the marks come from:** a field is marked provenanced or can be fabricated only where its code path was read,
or its data measured, during this audit (2026-11-20 to 11-22). The source is given in each row. Code references are to
main at 05969ca and later. Data references are to the backups named in each row.

**This list is a name list, not a count:** a state describes the field, not how often it fired. Where a path's firing
was counted, the count is given beside it.

**What the list does not cover:** it lists the fields this audit actually read, so "not established" is a minority of
the rows. Every column NOT listed here is **not established**. That includes trades_v2's exit-model and outcome-window
columns (`unified_*_at_sale`, `*_factors_at_sale`, `best_exit_*`, `price_at_plus*`, `peak_*`, `target_drift_pct`,
`distance_from_target`, `minutes_late` and the rest). Counted: 43 rows, 20 can be fabricated, 17 provenanced, 6 not
established, plus every unlisted column.

## trades_v2 (the outcome record)

| Field | State | Clock | Why, and the source |
|---|---|---|---|
| `buy_price` | can be fabricated | — | It is the add form's pre-fill (app.js `openAddPortfolioModal`), taken from the signal's `getLivePrice`. That function reads `dailyBar.c` FIRST, however old the bar (core/market-data.js:37). It equals the pre-fill on 244 of 244 snapshot trades. Against SIP: 51 of 586 were off by 1% or more (84d161a). |
| `sell_price` | can be fabricated | — | The sell form's pre-fill is `getLivePrice(snap) \|\| p.buyPrice` (app.js:5535). Since 3f15225 (11-02) an earlier session's close is withheld, and the `buyPrice` fallback renders an empty field. Off by 1% or more against SIP: 38 of 429 sold before 11-02, 6 of 157 after (8bc7432). |
| `pnl_dollars`, `pnl_pct` | can be fabricated | — | Derived from the two prices above. Exact arithmetic on them: 586 of 586 to the cent. |
| `shares` | provenanced | — | Typed. The field has a placeholder and no value (app.js `pf-shares`), and is never re-sized. |
| `buy_date` | can be fabricated | the add | A date field that defaults to today. A late recording with the default left stores the recording day (the retraction, 7f32ffa). |
| `sell_date` | can be fabricated | the save | The same: it defaults to today. |
| `buy_time` | not established | the add | As the BUY's time. It is the add's clock (`getPT()` at the add, app.js:4957), so it is honest only as "recorded at". The decision is not recorded anywhere. |
| `sell_time` | provenanced | the save | As what it is named for since 5cf9863: "recorded at". It is not the sale's time; that is `sell_filled_at`. |
| `sell_filled_at` with `sell_filled_at_source` | provenanced | typed, or the form opening | entered / default / not_known, each stored with its source (db/038). A default is no longer used to place anything against the fill (7d8cf22). |
| `filled_at` (buy) | can be fabricated | typed, or the form opening | The mark-filled form pre-fills the fill time with NOW and the fill price with the order's price (app.js `mf-time` / `mf-price`, found by tests/prefill-guard.test.js 2026-11-22), and no source column records whether either was typed. (Was: not established.) |
| `signal_score` | can be fabricated | — | Five substitution paths in core/edge-scoring.js. Counted on the 586 (7dd8248): 0 established. Path (a) is not established on 342 trades, at most 86. A no-signal add stored `\|\| 0` until 11-14; none of the 586 has a 0. |
| `volume_ratio_at_buy` | can be fabricated | — | `avgVol10 > 0 ? volume / avgVol10 : 1`, the TOP of the volume ladder. 0 of 586 exactly 1 or 0 (7dd8248). The modal fallback at app.js:3730 repeats the `: 1`. |
| `rsi_at_buy` | not established | — | A NaN RSI scores 0 by design, and the null path was fixed 11-14 ("0 of 817 sales held a 0 or null"). Not re-checked in this audit. |
| `risk_score` | can be fabricated | — | `calcRiskScore(..., hasRecentNegNews)`. With news not retrieved, the +2 is missing. The screen says so ("News not retrieved (risk may be understated)"); the stored number does not. |
| `duration_classification` | can be fabricated | — | `sig?.duration \|\| '3-DAY'` for a buy with no signal (app.js `finalizeAddPortfolio`). classifyDuration itself returns only DAY / 3-DAY / WEEK (586 of 586). |
| `macro_condition` | provenanced | — | null when the context had not loaded, never a guessed condition. |
| `macro_adjustment_pts` | can be fabricated | — | `MACRO_ADJUSTMENTS[c]?.[k] ?? 0`: a lookup miss becomes 0. 0 of 244 visible; overlay off on the newest 156. |
| the `*_pts` components (`price_momentum_pts` ... `rel_strength_pts`) | can be fabricated | — | Before 2026-10-22 three of them hold the stock modal's recompute, not the scored values (`MODAL_COMPONENTS_FIXED_FROM`; written off, counted). |
| `entry_vs_signal_price_pct` | can be fabricated | — | It compares the form price, pre-filled from `sig.price`, with `sig.price` itself. It measures only Roman editing the field, and emits 0 for every unedited pre-fill, a plausible value no one measured (the self-referential sweep). |
| `spread_at_buy` | provenanced | — | A real `ap - bp` from the add's snapshot quote, or null. Never a default. |
| `buy_session` | not established | the add | It is classified from the add's clock, so it is the session of the recording. The 24 Sunday 09-27 buys are CLOSED (af9d788). |
| `position_id` | provenanced | the add | Date.now() at the add (app.js `finalizeAddPortfolio`), a real stamp. It is the SAME clock as `buy_time`, so the two agreeing is never evidence about timing (5104c49). |
| `created_at` | provenanced | the save | The database insert stamp at the save. It is the SAME clock as `sell_time` (5104c49). |
| `signal_before_sale` | provenanced | — | A state with a reason, never a guess. Only a typed fill places it (7d8cf22). |
| `verdict_display_state`, `verdict_displayed_at_sale` | provenanced | — | Three states. It refuses the default fill time, with the reason in the code (core/orders.js `saleDisplayFields`). |
| `peak_rsi_during_hold` with its provenance | provenanced | the render | sampled_since / not_sampled / not_established / corrected (db/044). |
| `sell_price_unverified` | provenanced | — | A flag on the 22 rows the `buyPrice` fallback produced (db/026). |
| `code_version` | not established | — | Set from db/028 on. Earlier rows: not checked. |
| `threshold_at_buy` | not established | — | Not checked. |
| `signal_snapshot` / `signal_snapshot_at_buy.snapshot` | provenanced | the scan | A JSON copy of the signal at the click, with `scannedAt` (156 of 244) and the bar's age (156 of 244) where recorded. `appShowedAtBuy` only from 11-10 (4e71a4a). |
| `source` ('App Signal') | can be fabricated | — | It is the sale form's pre-selected label, not derived. The derived answer would be `signal_log.taken_resolution`, which cannot see most trades (below). |

## portfolio (the open positions)

| Field | State | Clock | Why, and the source |
|---|---|---|---|
| `buy_price` | can be fabricated | — | The same pre-fill as `trades_v2.buy_price`. |
| `target`, `stop` | can be fabricated | — | `sig?.target \|\| price * 1.10` and `sig?.stop \|\| price * 0.92` for a buy with no signal (app.js `finalizeAddPortfolio`). These drive the exit warnings and alerts. |
| `duration` | can be fabricated | — | `sig?.duration \|\| '3-DAY'`, as above. |
| `peak_price` | can be fabricated | — | Raised from `currentPrice = getLivePrice(snap) \|\| p.buyPrice` (app.js:5535, 5670), so it can be a stale close or the buy price. |
| `execution_mode` with `execution_mode_source` | provenanced | — | A mode is never stored without its source (db/042, db/044). The six 11-02 rows are pending Roman's run of RUN-ME-20. |
| `peak_rsi` with `peak_rsi_sampled_from` | provenanced | the render | db/044. |
| `filled_at` | can be fabricated | typed, or the form opening | The same pre-filled fill time, with no source recorded, as on trades_v2. |

## signal_log (what the scheduled logger saw)

| Field | State | Clock | Why, and the source |
|---|---|---|---|
| `first_shown_at` | provenanced | the scan | Provenanced as the first writer's sighting (dedup keeps it). It is NOT what Roman saw: the app wrote rows to 10-22 and the late-running logger after. Only 96 EDGE symbols were ever logged, against 310 traded (05969ca). |
| `reference_price` | can be fabricated | — | `getLivePrice(snapshot) ?? null` in the logger (scripts/log-signals-edge.mjs:377): the same stale-first preference. |
| `ret_5m` ... `ret_5d` | provenanced | — | null when no bar or price exists, "never a defaulted 0" (db/016). |
| `tier` | provenanced | — | SHOWN / BELOW_THRESHOLD / NOT_EVALUATED, a column rather than a filter (db/001). |
| `taken_resolution`, `matched_trade_id` | not established | — | Not checked in this audit. It cannot match the trades the log never saw. |

## The app, not a column: what reaches Roman's screen

These are product facts that bear on every field above.

- **What EDGE displayed to Roman is unrecorded before 2026-11-10.** `appShowedAtBuy` began in 4e71a4a. For every
  earlier trade, what he saw is gone, and no record exists that could restore it. A strategy cannot be tested against
  what a person saw if what they saw was never written down. (The reviewer, 2026-11-23.)
- **A displayed price can be days old, and the price figure says nothing.** `getLivePrice` prefers `dailyBar.c` over
  the latest trade (core/market-data.js:37). IPST, 2026-11-05: the card's price was $2.67, the 11-03 close, while SIP
  traded $2.08.
  - In the corrected form: a stale-bar gate existed from 11-01 (b2eb9d8, `entryGateStaleDailyBar`). It would have
    labelled the card "Scored on 11-03's price, not today's: no trade on the feed yet when scanned — not buyable".
  - Whether Roman saw that label is NOT ESTABLISHED: neither snapshot has `appShowedAtBuy`.
  - The price figure itself carries no date.
- **24 of the 586 were entered on a day with no market** (Sunday 2026-09-27, af9d788).
  - Their `buy_price` is Friday 09-25's close. The SIP reference was 2,319 to 3,038 minutes old, with a median gap of
    0.000% (84d161a).
  - None of them is in the 513 priced at the quote: 23 had no buy quote, 1 none at either end.
- **The stale daily bar, three states:** stale 2, fresh 154, not recorded 88, of the 244 snapshot trades. There is
  nothing on the other 342 (7dd8248).
- **The pre-fill limit:** a price left at its pre-fill is the live price at the recording moment. So a tape check at
  the recording minute proves when the price was taken, never when the trade was decided. The 68 of 70 in phase-10
  §3.4 stands as a measurement; its "not typing" inference does not, for pre-filled rows (7f32ffa).
- **The scan is the decision (a product observation, not a defect).** The median lag from the scan that produced the
  signal to the buy's recording is 0.4 minutes, and 155 of 156 are within 5 minutes (b86069c). It fits 11-17's fifteen
  positions in four minutes. No human filter adds judgement on top of the scan, so the system's quality is entirely the
  ranking's, and the ranking has none (ef99790, 84d161a). Established for 156 of 586 trades, the newest 27%; not
  established for the other 430, and no record exists that could establish it.
- **`targetDriftPct` is 0 when there is no live target or position** (app.js:3846, 5773): a fabricated neutral, shown
  as drift.
- **The stock modal's no-card fallback** (app.js:3730) builds a stock with `volRatio ... : 1` and `score: 0`. It reached
  none of the 586, whose scores run 30 to 115.
- **The add path has one route:** the stock modal's "+ Add to Portfolio", in every version across the sample (0628f7e,
  38a1ceb, 314f6e0). Every scored trade had a shown signal in the latest scan. That shows the ticker was on the shown
  list, not that Roman looked at its card.
