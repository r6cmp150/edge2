# EDGE2 Warrior Engine — Architecture Review

**Reviewing:** `edge2warriortradingengine.md`
**Date:** 2026-08-23
**Scope:** document-level review. I do not have the EDGE2 source, the Supabase migration doc, the Sell Timing doc, or the Full Signal Capture doc — see "What I couldn't verify" at the end.

---

## Verdict

The isolation instinct is right and the honesty note in §1 is the best thing in the doc. But the boundary is drawn **one layer too high**, and the design is missing the single component the Warrior method depends on most: the **universe**. Ross Cameron's edge is not the gate or the setups — it's that he starts every morning from a market-wide top-gainer scan. This doc applies his criteria as a filter over EDGE's existing candidate list, which inverts the method.

Three blockers, six architecture fixes, seven smaller items. All are fixable before a line of code is written.

---

# Part 1 — Blockers

## B1. There is no universe layer, and the universe *is* the method

Ross's documented process starts with a **Top Gainer scanner** across the whole market, then narrows. Warrior Trading's own page describes exactly this: begin the day on the Top Gainer scanner, then switch to the High of Day Momentum scanner as the session progresses.

The doc never says where candidates come from. By omission, Claude Code will feed the 5 Pillars whatever EDGE's screener already produces. That is backwards: a stock that is up 10%+ on 5× relative volume with a fresh catalyst and a sub-10M float is, almost by definition, **not** on a list you built yesterday. Gating a stale list with Ross's criteria will return zero results on most days and the wrong results on the rest.

**There is already evidence this layer is broken today.** In `edge-report-2026-06-25.txt`, 10 of your 11 completed trades are tickers beginning with A or B (AMC ×3, AMRX, ADMA, ARRY, ATAI, ACHR, BATL, BBWI), and **none** of them appear in the v3 spec's hardcoded seed list. That is not chance. It strongly suggests the live scanner walks an alphabetically-ordered asset list and runs out of time or rate-limit budget before it gets past B. Worth confirming in the code — but if true, the Warrior engine would inherit that truncation, and a gapper engine that can only see the letter A is not an engine.

**Fix:** a shared `universe` module owned by neither engine, with two strategies:

- **Intraday:** Alpaca `GET /v1beta1/screener/stocks/movers?top=50` and `/v1beta1/screener/stocks/most-actives`. Real SIP-based, exactly the "top gainer" primitive the method needs.
- **Pre-market:** the movers endpoint resets at market open and returns *prior-day* movers until then, so it cannot give you pre-market gappers. Build that separately: pull tradable US equities from `GET /v2/assets`, filter to $1–$20 on last close, batch `GET /v2/stocks/snapshots?symbols=…` and compute gap % yourself.

This becomes step 1 of the build, before the gate exists.

---

## B2. The free-tier feed makes every intraday number wrong — and the fix is counterintuitive

Alpaca's Basic plan gives you **real-time IEX only, or 15-minute-delayed SIP**. IEX is a single exchange carrying a small single-digit percentage of consolidated volume.

Everything §4 marks "✅ already available" is computed off IEX bars unless the spec says otherwise:

| Quantity | What breaks on IEX |
|---|---|
| Relative volume | Ratio of IEX volume to a 30-day consolidated average — two different things. Not noisy, wrong. |
| VWAP | Volume-weighted by ~2% of the tape. |
| High of day | IEX's high, not the market's. |
| HOD "fresh volume surge" | Surge detection on a fraction of prints. |
| ABCD pullback volume | Same. |

**Fix:** the Warrior engine should explicitly request `feed=sip` and accept the 15-minute delay. Given you check in on an hours-scale cadence, complete-but-15-minutes-late beats real-time-but-2%-of-the-tape every time. This must be an explicit parameter in the spec, or Claude Code will silently inherit whatever `fetchMinuteBars` currently defaults to.

Then surface it: every Warrior signal card shows its data timestamp and minutes-since-trigger, so a late signal is *visibly* late.

---

## B3. §8 is filed as a "constraint." It is actually a validity threshold

Gap and Go triggers in the first minutes after 6:30am PT. HOD Momentum resolves in minutes. A 9:00am PT check-in is ~2.5 hours late; the 4:00pm check is after the close.

The damage isn't only missed trades. It's that the Claude Report (§7) will attribute the resulting losses to **setup quality** when the actual cause is **latency** — and the report's explicit purpose is to rewrite your scoring rules. You would end up tuning a scoring system to fix a problem that isn't in the scoring system.

Two compounding issues the doc doesn't mention:

- **iOS suspends timers.** In a home-screen PWA, `setInterval` stops when the app is backgrounded or the screen locks. §3's "own scan interval" cannot be relied on for intraday polling. The monitoring problem is structural, not a settings toggle.
- **Push notifications need a server.** The v3 spec is explicitly serverless. But a Supabase migration is in flight — that's your notification path, and it makes §8's "natural follow-up" concretely cheaper than it looks. Worth connecting the two docs.

**Fix, pick one:**

- **(a)** Commit to a pre-market session (~6:00–6:25am PT) as the primary Warrior workflow. Gap and Go becomes usable; the rest stay informational.
- **(b)** In v1, build only the setups that survive latency. ABCD and VWAP Momentum offer repeated entries through the session. Ship Gap and Go pre-market-only. Mark HOD Momentum and Red-to-Green explicitly as *"informational — this already ran"* until a notification path exists.

Either way: tag every Warrior trade with `minutesLate` at entry so the report can separate latency from setup quality.

---

# Part 2 — The boundary is drawn one layer too high

The doc's split is two-way: EDGE's engine on one side, `warrior-engine.js` on the other. That leaves an **unowned middle**. Both engines need API keys, a rate-limited fetch queue, the market clock, bar caching, news, indicator math, and storage.

Under a two-way split each of those either gets duplicated inside `warrior-engine.js`, or the Warrior module reaches into EDGE's code — and the second option quietly makes the isolation claim false while the file layout still looks clean.

**Proposed three-layer structure:**

```
core/                 (owned by neither engine)
  api-client.js       keys, auth, retry, ONE rate-limit queue with per-engine budgets
  universe.js         movers, most-actives, pre-market gap scan, asset list  [B1]
  bars.js             daily/minute/hourly fetch + cache, feed configurable   [B2]
  indicators.js       RSI, ATR, VWAP, RVOL — pure functions, no state
  clock.js            market session state (exists today)
  store.js            localStorage / Supabase persistence
engines/
  edge/               scoring, duration classification, ATR target/stop, sell warnings
  warrior/            gate, setup classification, tight-stop math, own exit rules
shell/
  nav, render dispatch, portfolio/sold rendering, report generation
```

**Import rules, stated as rules so Claude Code enforces them:**
- `core/` never imports from `engines/`
- `engines/*` never import each other
- `shell/` reaches engines only through the registry (A2)

---

### A1. Rate limiting is real coupling, and the doc doesn't address it

Both engines share one 200 req/min quota. A Warrior scan pulling minute bars for 40 candidates will starve a concurrent EDGE refresh. "Own scan interval" (§3) does not help — separate timers, same quota.

The stated isolation test ("delete `warrior-engine.js` and EDGE still works") **passes** while the actual failure mode — EDGE returning 429s because Warrior is scanning — persists. A test that green-lights the bug it should catch is worse than no test.

**Fix:** one request queue in `core/api-client.js`, per-engine budgets, foreground tab gets priority. Also: use the multi-symbol form (`/v2/stocks/bars?symbols=A,B,C&timeframe=1Min`) and handle `next_page_token`. A per-ticker minute-bar loop will blow the quota on any realistic candidate set.

---

### A2. The isolation test already fails as written

§6 has Warrior writing `engineSource` into shared position records. §7 has the report reading Warrior-specific gate and setup data. Delete `warrior-engine.js` with a Warrior position open, and the Portfolio badge renderer and report statistics have dangling references.

Don't weaken the test — fix the contract:

```js
// A position carries an engine-agnostic envelope
{
  engineSource: 'WARRIOR',
  signalSnapshot: { /* opaque to shell — only the owning engine reads it */ },
  exitRuleId: 'warrior.sameday.tightstop'
}

// Each engine registers itself at load
registerEngine('WARRIOR', {
  label:          'Warrior',
  renderBadge,          // small badge on a portfolio card
  renderSnapshot,       // signal detail in the modal
  evaluateExit,         // ongoing SELL NOW / SELL SOON — see A3
  summarizeForReport    // engine's own stats block for §7
});
```

Shell looks up the registry. Missing engine → renders *"signal detail unavailable (Warrior engine not loaded)"* and falls back to a generic exit rule. That degrades gracefully instead of throwing.

**Consequence worth stating explicitly in the spec:** EDGE code and shell code never contain the string `"ABCD"`. §7's setup breakdown is produced by asking the Warrior module to summarize its own snapshots — not by report code that knows Warrior's shape.

---

### A3. Nobody owns sell warnings for a Warrior position

§5 correctly says Warrior needs its own entry/target/stop. It says nothing about who evaluates the **ongoing** SELL NOW / SELL SOON banner once the position is in the Portfolio.

Today that logic keys off EDGE's DAY/3-DAY/WEEK classification and ATR stop math. A Warrior position has neither field. Left as-is it will either throw on a missing field or silently mis-warn — the worse of the two outcomes.

This is `evaluateExit` in the registry above, and it also **answers open question 3**: Warrior positions don't get DAY/3-DAY/WEEK badges at all. They get a Warrior-native badge (`SAME DAY`) and Warrior-native exit rules. That's not a UI preference — it's this hole.

---

### A4. Module isolation only holds if the module is separately loaded

If `warrior-engine.js` is concatenated into one bundle, a **syntax error takes down the whole app** — your try/catch never runs, because the file never parses. Load it via dynamic `import()` inside a try/catch (or a separate `<script>` with an `onerror` handler) so a parse failure degrades to "engine unavailable."

Two more places §3's error boundary reads right but implements wrong if taken literally:

- A try/catch around a `setInterval` **call** does not catch throws inside the **callback**. The try/catch has to be inside the callback body.
- try/catch does not catch async rejections. Every promise chain needs `.catch()`, plus a `window.addEventListener('unhandledrejection')` that attributes failures by module tag.

---

### A5. Setups are not mutually exclusive, but §2 treats classification as singular

A stock can be gapping, holding above VWAP, and printing a new high of day in the same minute. §2 says "classify which pattern it's showing" — singular.

§7 then asks which of the 5 setups produced the best results. With singular classification, that statistic is an artifact of whatever order your if/else runs in, not a fact about the setups.

**Fix:** return an array — `setups: [{ id, triggerPrice, triggeredAt, confidence }]` — and choose a display primary by a documented priority order. Report by primary, but persist the full array so attribution can be revisited once you have trades.

---

### A6. Sequencing against the other three docs in flight

§6 and §7 touch exactly the records the Supabase migration and Full Signal Capture docs touch.

- Add `engineSource` and `signalSnapshot` **in the same schema change** as the Supabase migration, not after. Otherwise those fields get written to localStorage, migrated, then rewritten — two migrations for one field.
- Existing positions and sold records **predate the field**. Define the backfill default explicitly (`'EDGE'`, never `undefined`), or every engine-filtered statistic silently undercounts your history. §6's "always populated, no third case to handle" is true going forward and false for the 11 trades you already have.

---

# Part 3 — Smaller, still real

### Good news the doc doesn't know about: the PDT rule is gone

The one external constraint that would have capped this entire engine has been removed. The SEC approved eliminating the pattern day trader designation; the new rules took effect **June 4, 2026**, replacing the $25,000 minimum equity requirement with broker-set intraday margin buying power for accounts above $2,000. Day trades are no longer counted.

Under the old rule, a same-day-exit engine on a $500 account would have been limited to 3 day trades per rolling 5 business days — which would have made most of this unbuildable. Check where Robinhood is in its implementation (brokers have until October 2027, though most moved early), but the structural blocker is gone. Your timing is good.

### C1. Float / Pillar 5 — workable, with three conditions

Confirmed: FMP's `stable/shares-float` endpoint **is** available on the free tier and returns float shares, outstanding shares, and free-float percentage. Free tier is 250 calls/day.

- **Apply it last.** Cheapest gates first — price, % change, RVOL, then news, then float. Never spend an FMP call on a stock that already failed pillar 1.
- **Cache hard.** Float changes on offerings, not daily. A 7–30 day per-ticker cache keeps you inside 250/day even on a busy gap morning.
- **Don't make it a boolean.** Ross's <10M is his *ideal*, not a wall — he trades higher float when RVOL is extreme. Make the threshold configurable (default 10M) and **display the float value** on the card, not just pass/fail. Also worth knowing: FMP float for sub-$300M microcaps is often stale and won't reflect a dilutive offering from last week — which is exactly the population you're gating on.

### C2. A hard AND on 5 pillars means an empty screen most days — with no way to debug it

RVOL ≥ 5× **and** ≥ 10% **and** catalyst **and** $1–$20 **and** float < 10M is a genuinely rare conjunction. That rarity is the point of the method, but the UI consequence is that the tab shows nothing on most check-ins — and you cannot distinguish *"no candidates today"* from *"the engine is broken."*

**Fix:** keep the gate, add a **near-miss tier** — candidates passing 4 of 5, each pillar shown pass/fail with its actual value. This serves debugging *and* the project's stated goal of understanding why something is or isn't recommended.

### C3. Missing gate: halt status

Sub-$20 low-float runners hit LULD volatility halts constantly, and a buy signal on a halted stock is actively dangerous. Alpaca exposes trading status — add it to the gate and to the card. Ross's method absolutely accounts for halts. Worth capturing SSR (short sale restriction) status too, since it directly shapes Red-to-Green dynamics and you'll want it in the report later.

### C4. Missing: position sizing — probably the highest-value omission

Ross's actual discipline is **fixed dollar risk per trade**: `shares = risk_budget / (entry − stop)`. §5 defines a tight stop and then never uses it for sizing.

On a $500 budget with average wins of +$3.47 and average losses of −$3.33 (per your June report), sizing is doing more work than setup selection is. Put a suggested share count on the Warrior card. Cheap to build, disproportionate value.

### C5. The report will lie at low n — and the report rewrites your rules

§7's win-rate-by-engine will run on n≈5 Warrior trades for weeks. Your June report already demonstrates the failure mode: signal score 80–100 won 50% of the time while score 20–49 won 75% (n=11). That inversion is noise, and nobody should retune a scoring system on it.

- Gate per-engine and per-setup statistics behind a minimum n (~20) and render *"insufficient data (n=6)"* below it.
- Report **expectancy / average R** alongside win rate. The two engines have deliberately different R profiles, so win rate alone is not comparable across them.

### C6. §2's stated reason for isolation is the weakest of the four real ones

"Continuous score vs. hard gate + label are different data shapes" is true but shallow — a gate is a score with a threshold.

The load-bearing reasons are **timeframe** (intraday vs daily), **cadence** (minutes vs twice-daily), **universe** (dynamic vs list), and **exit discipline**. This matters practically: the stated reason places the boundary at the scoring function, which is where the doc drew it. The real reasons place it at the data layer, which is where Part 2 moves it.

### C7. Nav — answering open question 2

Seven tabs at 390px is ~55px each with labels, below a comfortable touch target. Recommend Warrior does **not** get a 7th nav item: Signals becomes a container with an `EDGE | WARRIOR` segmented control at the top, and the shell mounts whichever engine's render function is selected.

This costs nothing in isolation — the shell already dispatches through the registry — and it reads correctly, since both are screeners.

---

# Part 4 — Your three open questions, answered

| # | Question | Answer |
|---|---|---|
| 1 | FMP float acceptable as new infrastructure? | **Yes.** Free tier confirmed. Conditions: apply last, cache 7–30 days, configurable threshold, display the value not a boolean. |
| 2 | Own nav tab or nested under Signals? | **Nested.** Segmented control inside Signals. Seven tabs doesn't fit 390px, and both engines are screeners. |
| 3 | Warrior positions default to same-day exit expectations? | **Confirmed, and it's structural, not cosmetic.** Warrior positions get their own badge and their own `evaluateExit` — see A3. Nobody currently owns their sell warnings. |

---

# Part 5 — Revised build order

Two additions to your §9, marked **new**:

| # | Step | Why here |
|---|---|---|
| 0 | **`core/` extraction** — pull api-client, bars, indicators, clock, store out of the EDGE engine | **New.** Behavior-neutral, and it's what makes everything after it actually isolated. Also the right moment to fix the alphabetical-truncation bug (B1). |
| 1 | **`universe.js`** — movers, most-actives, pre-market gap scan | **New.** Validate against a known gap day before anything depends on it. |
| 2 | Warrior tab scaffold + engine registry + graceful-degrade path | Prove the boundary by deleting the module. |
| 3 | 5 Pillars gate on core data (pillars 1–4) + near-miss tier + halt check | |
| 4 | **Replay harness** — feed historical minute bars through the classifier offline | **New.** Turns setup detection from opinion into something testable, and needs no live market hours. Cheap: the historical bars are already free. |
| 5 | Gap and Go + VWAP Momentum, validated against the harness | The two that survive latency (B3). |
| 6 | FMP float → completes Pillar 5 | |
| 7 | Remaining setups (ABCD, HOD, Red-to-Green) | |
| 8 | `engineSource` + `signalSnapshot` — **inside the Supabase schema change**, with backfill default | A6. |
| 9 | Report changes, with min-n gating | C5. |

Step 4 is the one I'd argue hardest for. Without it you're shipping five pattern detectors that nobody has ever seen fire, into a market you can only observe twice a day.

---

# Verification outcome (checked against the codebase, 2026-08-23)

Four of five confirmed as written. One correction.

| Finding | Result |
|---|---|
| **A1** — no shared rate-limit queue | **Confirmed.** `alpacaGet()` (`app.js:1098–1104`) is a bare `fetch()` wrapper. Nine callers, each with its own chunking loop, no coordination, no 429 handling. |
| **B2** — feed | **Confirmed, and worse than stated.** `feed: 'iex'` is hardcoded in *every* fetcher, `fetchMinuteBars` included (`app.js:1404`). Nothing ever requests SIP. |
| **A4** — bundling | **Confirmed.** One `<script src="app.js">` (`index.html:96`), ~354KB, no dynamic imports. A syntax error today takes down the whole app. |
| **A2/A3** — position rendering and exit logic | **Confirmed.** One unconditional entry point, `calcUnifiedRecommendation` (`app.js:4369`). A Warrior position hits `MAX_HOLD_DAYS[undefined]` (`app.js:4390`) and **silently drops the max-hold term** rather than throwing — the worse of the two failure modes. |
| **B1** — alphabetical scan truncating on budget | **Wrong mechanism. Conclusion holds.** There is no truncation: `fetchSnapshots` chunks the full universe with no early exit. The real model is hardcoded per-sector curated arrays (`STOCK_UNIVERSES`, `app.js:227–737`) with the app defaulting to a **single sector, `OTHER`** (`app.js:817`). No movers endpoint, no most-actives, no pre-market gap builder. Phase 1 is still needed — but as "replace a static curated-list universe," not "fix a truncation bug." |

**One bonus correction:** persistence is *already* on Supabase (table `portfolio`, `app.js:5338–5359`). A6's "coordinate with the in-flight migration" is obsolete — it's a column addition to an existing table.

### Still open — hypothesis, not confirmed

The A/B clustering in the trade report isn't explained by curated sector lists alone. If `STOCK_UNIVERSES.OTHER` is alphabetically ordered and signal scores are coarse (the June report shows 20/25/35/50/60/75/80/90), ties are frequent, and `Array.prototype.sort` is stable — so every tie breaks in source-array order and pushes A/B tickers to the top of the ranked list.

Check whether the ranking sort has an explicit tie-breaker. If not, this biases **EDGE** today, and therefore biases the trade history the Claude Report draws its conclusions from. Worth fixing independently of any Warrior work.

---

## Sources

- [Alpaca — About Market Data API](https://docs.alpaca.markets/us/docs/about-market-data-api) — Basic plan: IEX real-time or 15-min delayed SIP, 200 req/min
- [Alpaca — Top market movers](https://docs.alpaca.markets/reference/movers-1) — SIP-based, resets at open, prior-day movers until then
- [Alpaca — Most active stocks](https://docs.alpaca.markets/reference/mostactives-1)
- [Warrior Trading — Day Trading Scanners](https://www.warriortrading.com/day-trading-scanners/) — Top Gainer scanner first, HOD Momentum as the session progresses
- [FMP — Share float on the free tier](https://site.financialmodelingprep.com/how-to/how-to-retrieve-company-share-float-data-using-a-free-api)
- [FMP API pricing and limits, 2026](https://www.findmymoat.com/tools/financial-modeling-prep-fmp) — 250 calls/day on Basic
- [Schwab — SEC approves scrapping the $25,000 day trader minimum](https://www.schwab.com/learn/story/sec-approves-scrapping-25000-day-trader-minimum) — effective June 4, 2026
- [FINRA — Moves to overhaul day trading margin provisions](https://www.finra.org/compliance-tools/weekly-archive/01072026)
