# Triage of the 24 fields Roman asked about (2026-11-26)

The 18 "can be fabricated" and 6 "not established" rows of docs/field-provenance.md as they stood on 11-26 morning.
Figures: trades_v2 @ 28610fb, PRE-START-LINE rows only (908; the 10 added after the start line were not read), the
pre-delete portfolio export (46, data/exports/portfolio-2026-11-23-before-delete.json), and signal_log @ 28610fb.
Nothing is fixed here except bucket (a), whose reads are pinned by tests/field-establish-2026-11-26.test.js.

**Frozen path** means the code that writes the field is in data/forward-test/instrument-freeze.json, checked by name.

**Reach** names what the fabricated value can touch: a measurement (FT means the forward test), a decision (what he
buys or when he sells), or only the screen.

## Bucket (a): the 6 not established, read and established

| field | result | evidence |
|---|---|---|
| `buy_time` | split. **Paper trade: provenanced.** Live trade or unknown mode: still not established, and no record can establish it. | It equals the add's clock on 616 of 616 rows. None was recorded outside 06:30-13:00 PT or on a weekend. Median scan-to-recording lag 0.4 min (b86069c). On a paper trade the recording IS the trade. 753 rows are of unknown mode. |
| `rsi_at_buy` | **provenanced** | 908 of 908 strictly between 0 and 100. The one exact 50 earned 15 points. |
| `buy_session` | **provenanced** (the session of the recording) | Recomputing it from buy_date and buy_time agrees on 908 of 908. |
| `code_version` | **provenanced** | 616 of 616 app stamps occur in index.html's history, and every hash is the known v2 hash. The 292 blanks all predate 10-27. |
| `threshold_at_buy` | **provenanced** | Every value is a line of its scoring version (29 and 73 for v1, 20 and 65 for v2). No score is below its threshold. 37 blanks predate the field. |
| `taken_resolution`, `matched_trade_id` | **can be fabricated** | "Taken" means any buy of the same ticker within 9 calendar days. Of the 92 matches, 82 were bought 1 to 8 days after the signal. |

## The table, ranked by consequence (bucket (a) results included)

| # | field | frozen path? | can it reach a decision / measurement / screen? | has it ever fired, how often? | direction | bucket |
|---|---|---|---|---|---|---|
| 1 | `buy_date` (trades_v2) | yes (add form default) | **FT: yes.** It sets qualifying days and the entry minute of A, B and C. | **Not detectable from the record.** 616 of 616 equal the add's day. On paper the recording is the trade, so it cannot be wrong while the mode stays paper. | A late recording moves the window later. Either sign on returns. | c |
| 2 | `sell_date` (trades_v2) | yes (sale form default) | **FT: yes.** Measure A's exit minute. | **Not detectable.** No sale time was ever typed (`sell_filled_at_source` entered 0, default 125, empty 783). On paper the recording is the sale. | Either sign. | c |
| 3 | `peak_price` (portfolio) | yes (refreshPortfolio) | **FT: yes, THROUGH HIS SALE.** It feeds the trailing stop in calcUnifiedRecommendation (the pullback from `position.peakPrice`), the advice shapes when he sells, and his recorded sale closes measure A's window. | **Not countable.** 10 of 46 equal the buy price, which a position that never rose also does. | Understates the peak, so a trailing stop fires later or never. One way. | c |
| 4 | `risk_score` (trades_v2) | yes (core/edge-scoring.js calcRiskScore) | Screen. The stored number feeds analytics; the screen says "may be understated". | **Not countable:** an empty `news_at_buy` (463) does not tell "no news" from "not retrieved". | **Understates risk** (the +2 is missing). One way. | c |
| 5 | `target`, `stop` (portfolio) | yes (finalizeAddPortfolio) | **FT: yes, THROUGH HIS SALE.** `price <= position.stop` returns "SELL NOW — Stop-loss hit", and checkPriceAlerts tells him to sell at the target. Both shape his sale, which closes A's window. | **0 of 46** carry the 1.10× / 0.92× default. The default needs a buy with no signal, and none exists. | Either. | c |
| 6 | `duration_classification` (trades_v2), `duration` (portfolio) | yes (finalizeAddPortfolio) | Decision: hold advice. | **0 of 908.** No buy without a signal. | Either. | c |
| 7 | `signal_score` | yes (core/edge-scoring.js) | Decision and screen (what shows), and C's shown set. | Paths a-c fixed in v3. Path (e), the macro lookup, **0 of 908**: overlay off. Path (d) touches only target and stop. | Either. | c |
| 8 | `macro_adjustment_pts` | yes | Score, hence screen and decision. | **0 nonzero of 908** (overlay off). | Either. | c |
| 9 | `filled_at` (trades_v2 and portfolio) | yes (mark-filled form) | FT: not read today. A pending order would be measured from its placement minute. | **0 of 616:** every fill equals the add minute, so no pending order has existed. | Either. | c |
| 10 | `buy_price` (trades_v2 and portfolio) | yes (add form pre-fill) | Screen and history P&L. **FT: no**, prices come from the tape. | 51 of 586 off SIP by ≥1% before v3 (84d161a). Since v3 the pre-fill is the latest trade. | Either (a stale close). | c |
| 11 | `sell_price` (trades_v2) | yes (sale form pre-fill) | Screen and history P&L. **FT: no.** | 38 of 429 before 11-02, 6 of 157 after (8bc7432). | Either. | c |
| 12 | `pnl_dollars`, `pnl_pct` | yes (derived) | Screen and history. **FT: no.** | As 10 and 11 (exact arithmetic on them, 586 of 586). | As 10 and 11. | c (fixed by fixing 10 and 11) |
| 13 | `source` ('App Signal') | yes (sale form label) | Screen and analytics label only. | **908 of 908:** always the default. | n/a (a label). | c |
| 14 | `taken_resolution`, `matched_trade_id` | **no** (scripts/fill-outcomes.mjs) | Logger analyses (history). FT: no. | **82 of 92** matches are later-day buys. | Overstates "taken". | b |
| 15 | `reference_price` (signal_log) | **no** (scripts/log-signals-edge.mjs) | Logger comparisons (history). FT: no. | **Not countable:** the row does not carry the trade's date. | A stale last trade, either sign. | b |
| 16 | the `*_pts` components before 10-22 | **no** (historical rows only; the code is fixed) | History analytics; already written off and counted. | Every row before 10-22 for three components. | Either. | b (nothing to fix in code) |

## CORRECTION (2026-11-26, the reviewer's §2): two bucket (c) fields DO reach a forward-test measurement

The first version of this triage's summary said that nothing in bucket (c) reaches a forward-test measurement while
the mode stays paper. **That was wrong, and rows 3 and 5 of this table said so.**
- **Measure A's window ends at his recorded sale.** scripts/measure-selection-differential.mjs differentialRows reads
  the tape from `buy_date`/`buy_time` to `sell_date`/`sell_time`, and scripts/measure-forward-test.mjs computes A with
  that same function.
- **So a field that shapes when he sells reaches A, through him:**
  - `peak_price`: the trailing stop. It can only be understated, because a missing price leaves the peak un-raised.
    How often is not countable.
  - `target` and `stop`: the stop-loss SELL NOW and the target alerts. Their default has fired 0 of 46 times.
- **B and C are measured from the entry,** with his exit playing no part, so neither field reaches them.
- **One consideration, not a ruling:** under the freeze these defects are CONSTANT. A measures the system as it
  stands, defect included, the same way on every day of the test. It does not measure a moving object.

## §5: does the forward test read an app price?

**No price.** Every price comes from the tape: `sipRef` at the minute, plus the adjusted daily closes. No forward-test
measure reads `buy_price`, `sell_price` or `pnl_*`.

**But the MINUTE is app-recorded.** The fields read are `buy_date`, `buy_time`, `sell_date` and `sell_time` (A), and
`buy_date` and `buy_time` (B and C):
- `sell_time` is "recorded at", not the sale; the sale's own time, `sell_filled_at`, has never been typed.
- `buy_date` and `sell_date` default to today.

On a **paper** trade (the mode since 11-12) there is no broker event, so the recording is the trade, and the minutes
are right by definition. On a live trade they would be the recording minutes. `execution_mode` is declared OUT of the
instrument freeze ("does not change a scan, a score, a gate or a price"), which is true, but **a switch to live would
change what every recorded minute means for measures A, B and C.**
