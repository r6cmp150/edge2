# EDGE2 — Warrior Trading Engine
## Implementation Spec v2 (build-ready for Claude Code)

**Supersedes:** `edge2warriortradingengine.md` (v1, architecture-review draft)
**Companion:** `warrior-engine-architecture-review.md` — read that first if you want the reasoning behind the changes. This document is the buildable version.

**Build this in phases.** Each phase below is independently testable and has its own acceptance criteria. Do not start a phase until the previous one passes. Phases 0 and 1 are load-bearing refactors — the isolation guarantees in this spec are not real without them.

---

## 0. What is being built

A second, independent signal engine inside EDGE2 that surfaces stocks using Ross Cameron's (Warrior Trading) publicly documented momentum day-trading method, structurally separated from EDGE's existing scoring engine.

**Honesty note, carried forward from v1 and still true:** Ross Cameron has published his stock selection criteria (the "5 Pillars") and *named* his setups. He has **not** published the pattern-recognition algorithm behind them — that lives in the paid Warrior Pro product. The setup definitions in §5 of this spec are a reasonable, explicit implementation of the publicly described patterns. They are our definitions, not his. Treat them as a v1 hypothesis to be validated by the replay harness (Phase 4), not as a replica.

### The four reasons this is a separate engine

State these in code comments at the top of `engines/warrior/index.js` so the boundary doesn't erode:

1. **Timeframe** — intraday minute bars, not EDGE's daily bars
2. **Cadence** — signals resolve in minutes, not over 1–7 days
3. **Universe** — a dynamic market-wide gapper scan, not a maintained list
4. **Exit discipline** — same-day tight stops, not ATR-based multi-day targets

---

# Phase 0 — Extract `core/`

**Behavior-neutral refactor.** No feature changes. The app must work exactly as it does today when this phase is complete.

Today the EDGE engine owns the data-access code. Both engines need it. Pull it into a third layer that neither engine owns.

### Confirmed state of the current code

Verified against the codebase 2026-08-23:

- **No shared rate limiting.** `alpacaGet()` (`app.js:1098–1104`) is a bare `fetch()` wrapper — no queue, no token bucket, no backoff, no 429 handling. Every caller (`fetchSnapshots`, `fetchAHSnapshots`, `fetchMultiBars`, `fetchSingleBars`, `fetchMinuteBars`, `fetchHourlyBars`, `fetchNewsForTickers`, `fetchNextDayClose`, `testAlpacaConnection`) hits it independently with its own chunking loop. A Warrior scan and an EDGE refresh would compete for the same 200 req/min with zero coordination.
- **`feed: 'iex'` is hardcoded in every single fetcher**, including `fetchMinuteBars` (`app.js:1399–1408`, feed set at line 1404). Nothing in the codebase ever requests `sip`. This is why the feed must be an explicit parameter rather than a default — Warrior inheriting the ambient default is the failure mode.
- **Everything is one bundle.** `index.html:96` has exactly one `<script src="app.js?v=…">`, ~354KB, no other script tags and no dynamic `import()`. A syntax error anywhere today takes down the whole app before any error boundary runs. See Phase 2.
- **Persistence is already on Supabase** — table `portfolio`, keyed by `position_id` (`app.js:5338–5359`), with `state.portfolio` as the in-memory source of truth after load. The migration this spec originally assumed was pending has landed; see Phase 7.

### Target structure

```
core/                 owned by neither engine
  api-client.js       auth + transport only — rate-limit queue lands in Phase 0.5
  universe.js         Phase 1 — stub in Phase 0
  market-data.js      snapshots + daily/minute/hourly bars, feed always explicit
  indicators.js       RSI, ATR, VWAP, RVOL — pure functions, no state
  news.js             Alpaca news
  clock.js            market session state (already exists — move it here)
  store.js            localStorage / Supabase persistence
engines/
  edge/               scoring, duration classification, ATR target/stop, sell warnings
  warrior/            Phase 2+
shell/
  nav.js, render.js, portfolio.js, sold.js, report.js, registry.js
```

### Import rules — enforce these

- `core/` **never** imports from `engines/`
- `engines/*` **never** import each other
- `shell/` reaches engines **only** through `shell/registry.js`

Add a comment header to each `core/` file stating rule 1.

### Phase 0 is move-only

`core/api-client.js` receives the existing `alpacaGet` / `alpacaHeaders` **as they are**. The rate-limit queue is new logic and belongs in its own reviewable diff — see Phase 0.5. Do not build it here.

### The import boundary is convention, not enforcement — plan accordingly

The app uses inline `onclick="functionName(…)"` handlers throughout, which only work because top-level declarations in a classic script attach to `window`. That rules out converting `app.js` to `type="module"`, so `core/` files load as ordered classic `<script>` tags sharing one global scope.

**Consequence:** "core/ never imports from engines/" cannot be enforced by the language. It is a convention, and conventions erode.

Two mitigations:

1. **Add a boundary check to the repo now** — a grep-based script that fails if any `core/*.js` or `engines/edge/*.js` file references a Warrior symbol or setup name. Run it as part of every phase's acceptance pass. Cheap, and it's the only enforcement available.
2. **The asymmetry works in your favour.** `engines/warrior/` loads as a real ES module via dynamic `import()`, so its exports are module-scoped. `core/` and `engines/edge/` genuinely *cannot* reach into Warrior code, while Warrior can still call core's globals. The direction that most needs enforcing is the one the module system enforces for free. Do not "fix" this by making Warrior a classic script.

### `core/market-data.js` — feed must be an explicit parameter

```js
fetchBars({ symbols, timeframe, start, end, feed })   // feed: 'iex' | 'sip'
```

- **EDGE keeps its current behavior** (daily bars; the feed choice barely matters at daily resolution)
- **Warrior always passes `feed: 'sip'`** — see Phase 3 rationale
- Cache minute bars per symbol per session-day; they are immutable once the day closes
- Every returned bar set carries the timestamp of its newest bar, for freshness display

### Known debt to record, not fix, in Phase 0

`core/` currently reads app-owned state. `alpacaHeaders()` reads `state.settings.alpacaKey`; `getMarketStatus()` reads `state.settings.forcePreMarketMode`; `persist(key)` reaches into `state[key]` by arbitrary key. Moving these does not change behavior, but it does mean the "state-agnostic" core is trusting `app.js` to have initialized first.

That ordering is safe today only because `init()` runs last. **Assert it rather than assume it:** `alpacaHeaders()` should throw a clear, named error if called before settings load, instead of sending an empty key and surfacing a confusing 401. Warrior will call through this same path on a different schedule, which is exactly when an implicit ordering assumption becomes a bug.

Parameterizing these properly (credentials passed in, `persist` taking a value) is a later cleanup. Record it; don't do it here.

### Phase 0 acceptance

- [ ] App behaves identically to before the refactor — Signals, Watchlist, Portfolio, Sold, News, Settings all unchanged
- [ ] The diff contains moved code, new script tags, `sw.js` / version bumps, and nothing else
- [ ] Boundary-check script exists and passes
- [ ] `sw.js` `APP_SHELL` lists all new `core/*.js` paths and `CACHE_NAME` is bumped — verify a hard reload serves the new files rather than a stale cache
- [ ] Each file's move is its own commit, bisectable

---

# Phase 0.5 — The shared rate-limit queue

Separated from Phase 0 because it is new logic, not moved code, and deserves its own review. **It must land before Phase 1** — Phase 1 introduces ~41-call snapshot bursts against a 4,047-ticker universe, and today those would fire against a bare `fetch()` with no coordination and no 429 handling, colliding with the concurrent `checkPriceAlerts` poll (`app.js:7271`).

Alpaca Basic allows **200 requests/minute**, shared by both engines. Separate `setInterval` handles do not give separate quotas.

```js
enqueue(request, { engine: 'EDGE' | 'WARRIOR' | 'CORE', priority: 'foreground' | 'background' })
```

- Token bucket at 200/min with headroom — target 170/min sustained
- `foreground` (the tab the user is looking at) preempts `background`
- Per-engine budget so neither can starve the other: cap each at 60% of the bucket — but **only while two or more engines are active in the current window**. With a single active engine it gets the full global bucket; a strict cap would otherwise throttle EDGE on Phase 1's wide scans for a competitor that isn't running. The global 200 ceiling protects Alpaca in both cases.
- Any ambient/contextual priority flag must be restored in a `finally`. A flag left set by a thrown exception deprioritises every subsequent request for the life of the page — the user's Refresh ends up permanently queued behind a background poll.
- On 429: exponential backoff, and surface **which engine** was throttled
- Batch by default: always the multi-symbol form, e.g. `GET /v2/stocks/bars?symbols=A,B,C&timeframe=1Min`. Never loop per ticker. Handle `next_page_token`.

Every existing caller routes through `enqueue`. `alpacaGet` keeps its signature so call sites don't change — the queue goes *inside* it.

### Phase 0.5 acceptance

- [ ] A forced burst **sustains a measured dispatch rate of ≤170/min**, asserted numerically — **and the test must first prove it drove the bucket below its burst buffer.** Two ways this criterion has already failed: the original wording ("produces backoff, not 429s") measured the absence of errors rather than the rate; the replacement measured the rate over a burst that never exhausted the 200-token head start, so it recorded unthrottled behavior and read 290/min. A rate assertion against a burst that never hits the limit tests nothing. Log the token count at start, midpoint and end as part of the evidence.
- [ ] **Note for interpreting all of the above:** at realistic volumes (30–120 requests) the bucket never throttles — a 200-token buffer absorbs the whole scan. The queue is a safety net for pathological cases, not a governor on normal work. Wall-clock at those volumes is set by dispatch concurrency, not by the rate limit.
- [ ] Concurrency and the token bucket are enforced **simultaneously** — at most N in flight *and* never exceeding the bucket rate. Prove both in the same test.
- [ ] Wall-clock elapsed is recorded alongside request count for anything that fans out. Counting requests missed a fully serial dispatcher for a full day.
- [ ] A simulated `background` burst does not delay a concurrent `foreground` request beyond one bucket interval
- [ ] Throttling messages name the engine responsible
- [ ] No call site changed — `alpacaGet`'s signature is unchanged

---

# Phase 0.6 — Two confirmed data-layer bugs

Both found by inspecting live network traffic on `main`, 2026-08-23. Both pre-date the Warrior work, both affect EDGE today, and both land in `core/`.

**Run this phase BEFORE Phase 0.5.** An earlier draft gated it behind the rate-limit queue on the assumption that fixing bug 1 would multiply request volume. It doesn't — the chosen fix costs the same four requests per scan as today (see below). With that premise gone, correctness ships first: this phase changes which stocks the app recommends, while the queue is infrastructure that isn't load-bearing until Phase 1 widens the universe.

## Bug 1 — Bars pagination: the app scores ~1 stock in 30

`fetchMultiBars` (`app.js:1158–1174`) requests 30 symbols with `limit=100` and reads `data.bars` once. `next_page_token` is never read — it appears nowhere in the 7,517-line file.

For Alpaca's multi-symbol bars endpoint, **`limit` is the total number of bars across the entire response**, and results are "sorted by symbol first, then by bar timestamp." Their docs state you are likely to see only one symbol in the first response if that symbol has enough bars to hit the limit.

**Confirmed live.** A request for 30 symbols returned exactly one — `ABSI` — plus a `next_page_token` that was ignored. ABSI was not first in the request; it was first alphabetically. Response sizes were 3.3–3.5 kB where 30 symbols × ~100 daily bars would be ~300 kB.

Downstream, the missing symbols vanish silently through three separate points:

1. `catch(e) { console.warn(…) }` in `fetchMultiBars` — dev console only
2. `const bars = allBars[ticker] || []` (`app.js:2415`)
3. `if (bars.length < 15) return null` in `scoreStock` (`app.js:2155`) — indistinguishable from "failed the score threshold"

**Second-order effect:** the request uses `sort:'asc'`, so truncation drops the **newest** bars. A partially-filled symbol can pass the `>= 15` gate and be scored on RSI, moving averages, and volume ratios computed from a window ending weeks ago. Those stocks aren't missing from the results — they're wrong, and they render normally.

**Fix — raise `limit` to 10000 *and* follow `next_page_token`.** Costs analysed for a 100-candidate scan (4 chunks of 30, 180-day lookback ≈ 3,000–3,700 bars per chunk):

| Approach | chunk | limit | Requests |
|---|---|---|---|
| A — paginate at current limit | 30 | 100 | ~108 (4 chunks × ~27 pages) |
| B — raise limit only | 30 | 10000 | ~4 |
| C — smaller chunks | ~1 | 100 | ~100 (degenerates to per-ticker looping) |
| **D — raise limit AND paginate** | **30** | **10000** | **~4** |

D costs the same as B in every realistic case, because 10000 is Alpaca's platform ceiling rather than a guessed-at headroom number — the pagination loop should essentially never fire under a 180-day lookback. It earns its two lines by turning a trusted assumption into an assertion, which is what this phase's acceptance criteria require. B alone still silently truncates if the window ever grows.

Then add a completeness assertion: if a symbol returns fewer bars than the requested window should contain, log it and exclude it explicitly rather than letting it fall through the `>= 15` gate.

**Consequence to accept:** expect roughly a **25–30× increase in scored stocks** — from ~4 per scan to essentially every candidate clearing the price/volume filter, since real $1–$20 stocks with volume almost never have fewer than 15 days of history. Signal counts will rise sharply. That is the bug being fixed, not a new problem — but existing score thresholds were tuned against a ~1% sample and will likely need revisiting once real volume is visible.

## Bug 2 — News endpoint returns 404 on every call

The app calls `https://data.alpaca.markets/v2/news`. The correct path is **`/v1beta1/news`**. Every news request 404s, confirmed in the browser console.

Consequences:

- The "recent news" scoring component (0–20 pts) has never fired
- The negative-sentiment penalty (−10) has never fired
- Every card displays "No recent news" unconditionally
- All 11 trades in `edge-report-2026-06-25.txt` record `News at purchase: none` — that is total failure, not a quiet month

**This would also have silently killed the Warrior engine.** Pillar 4 is *news catalyst present*, a hard gate. With news 404ing, nothing would ever pass, and Phase 3 would render an empty screen indefinitely while appearing healthy.

**Fix:** give `alpacaGet` an optional base-URL override parameter (defaulting to `ALPACA_BASE`), and have `fetchNewsForTickers` pass the `v1beta1` base. Touches only `core/api-client.js` and `core/news.js` — nothing in `app.js`. No dependency on Phase 0.5, no request-volume consequence, and it can land as a standalone commit.

Also surface the failure. A 404 on a scoring input must not degrade to a silent zero — it should be visible on the card as "news unavailable," distinct from "no news."

## Bug 4 — News requests pass no `start`, so the window is empty when it matters most

Confirmed pre-existing, not introduced by Bug 2's fix. `fetchNewsForTickers` passes only `{ symbols, limit: 50, sort: 'desc' }` — no `start`, no `end`, on `main` as well as on the branch. It was invisible while the endpoint 404'd: the window never mattered because every request failed before reaching it.

Alpaca defaults `start` to **the beginning of the current day**. Consequences:

- **Sunday:** window begins Sunday 00:00 — Friday and Saturday news excluded by construction
- **Monday 6:30am PT:** window covers only since Monday 00:00. FDA decisions, M&A, and contract announcements frequently drop Friday evening or over the weekend — precisely the catalysts a Monday-morning scan exists to find
- **The scoring buckets can't be populated.** "News <4hrs = 20pts, 4–12hrs = 10pts" needs at least a 12-hour lookback; a since-midnight window is shorter than that for most of every trading morning
- **Warrior Pillar 4** is *news catalyst within 24h*, a hard gate. A sub-24h window would silently prevent anything from ever passing — the same failure mode Bug 2 would have caused, arriving by a different route

### The trap in the obvious fix

Widening `start` alone reintroduces Bug 1's shape, in news form. `limit` maxes at 50 and results are sorted `desc` **across the whole batch of symbols**, not per symbol. A batch whose symbols collectively have more than 50 items in the window returns only the 50 most recent — so symbols whose latest news is slightly older get nothing, silently. **Widening the window makes this strictly more likely.**

### Fix

- Pass `start` = now − **72 hours**. Covers the Friday-evening-to-Monday-morning gap, satisfies both scoring buckets, and satisfies Warrior's 24h catalyst gate. Scoring already buckets by age, so a wider window costs nothing in precision.
- Handle the batch-truncation risk: either follow `page_token` until every requested symbol has at least one item or the window is exhausted, or reduce symbols per news request. Report the request-count cost of each before choosing — same analysis shape as Bug 1's option table.
- A symbol that returned no news because the batch limit was hit is **not** the same as a symbol with no news. Track and surface the difference, consistent with Bug 2's "news unavailable" state.

## Bug 3 — Silent chunk failures make the acceptance test uninterpretable

`fetchMultiBars`'s per-chunk `try/catch` does `console.warn('bars batch error', …)` and continues. A transient network failure drops ~30 symbols from that scan with no user-visible signal — the same disappearing-stock symptom as Bug 1, from a different cause.

Fixing Bug 1 removes the *deterministic* source of run-to-run variance. This is the remaining *stochastic* one, and while it exists, a mismatch in the acceptance test below can't be distinguished from the fix not working.

**Scope this narrowly: surface it, don't fix it.** Retry and backoff are Phase 0.5's job and shouldn't be duplicated here.

- Count symbols that failed to return data because their chunk request errored
- Surface the count in the scan header: `Scanned 489 stocks — 12 could not be checked` — muted, but present
- A scan that dropped chunks is not a complete scan and must not present itself as one

That single line makes acceptance item 5 interpretable: if two scans differ *and* the header reports dropped symbols, the cause is known and the pagination fix is not implicated.

## Phase 0.6 acceptance

- [ ] A 30-symbol bars request returns bar data for all 30 symbols, or logs exactly which are missing and why
- [ ] No symbol is scored on a bar series shorter than the requested window
- [ ] News requests return 200; at least one card shows a real headline
- [ ] A forced news failure renders "news unavailable", not "No recent news"
- [ ] News requests pass an explicit `start` of 72 hours back — verify in the Network tab, not just in code
- [ ] A Monday-morning scan surfaces news published the previous Friday evening
- [ ] A symbol dropped by the 50-item batch limit is distinguishable from a symbol with genuinely no news
- [ ] A scan that dropped a chunk reports the count in its header rather than presenting itself as complete
- [ ] Two consecutive scans of the same universe, market closed, return **identical** result sets — this is the regression test for the whole phase. If they differ, the header's dropped-symbol count says whether Bug 3 is the cause; only a mismatch with zero dropped symbols implicates the pagination fix

---

# Phase 1 — `core/universe.js`

**This is the most important phase in the spec.** Ross Cameron's method starts every day from a market-wide top-gainer scan. Filtering a pre-built list with his criteria inverts the method and will return nothing useful.

### `universe.js` serves both engines, not just Warrior

It lives in `core/` for a reason. EDGE has the same universe problem in a milder form: 4,047 unique tickers across nine curated arrays, with the app defaulting to one arbitrary bucket of 239. The sector labels are not reliable — RETAIL holds 1,830 tickers and 233 tickers appear in two or more categories, which means the arrays were auto-generated and the categories are decorative.

Design `getUniverse()` so EDGE can adopt it too:

```js
getUniverse({ session, strategy })
// strategy: 'movers' | 'premarket-gap' | 'full-filtered'
```

`full-filtered` is EDGE's path — the deduped tradable US equity list filtered to $1–$20 and the configured minimum volume, replacing `STOCK_UNIVERSES` entirely. Migrating EDGE onto it is **not** part of this phase; build the interface so it can happen later without a second rewrite.

**Do not flip EDGE's universe default before Phase 0's shared queue exists.** A ~41-call snapshot burst against 4,047 tickers colliding with the concurrent `checkPriceAlerts` poll (`app.js:7271`) is precisely the A1 failure mode. Dedupe before combining, never after.

### Confirmed state of the current code

Verified against the codebase 2026-08-23. The v1 review hypothesised an alphabetical scan truncating on budget — **that is not what's happening.** The actual finding:

- Candidates come from hardcoded, per-sector curated arrays in `STOCK_UNIVERSES` (`app.js:227–737`: HEALTHCARE, ENERGY, TECH, RETAIL, FINANCIAL, INDUSTRIAL, REAL_ESTATE, CONSUMER, OTHER)
- **The app defaults to a single sector — `OTHER`** (`app.js:817`, `738–739`). Every signal you've acted on came from one curated bucket.
- `runScreener()` (`app.js:2336`) → `fetchSnapshots(TICKERS, …)` (`app.js:1121`) chunks the full selected universe with **no early exit** — no elapsed-time check, no request cap, no `.slice()`. There is no truncation to fix.
- No `/v1beta1/screener/stocks/movers`, no `most-actives`, no pre-market gap builder. `core/universe.js` does not exist.

So the framing for this phase is **replace a static curated-list universe model with a dynamic market-wide scan** — not "fix a truncation bug."

### Open question to check while you're here (hypothesis, not confirmed)

10 of 11 trades in `edge-report-2026-06-25.txt` are tickers starting with A or B, which curated sector lists alone don't explain. Possible cause: if `STOCK_UNIVERSES.OTHER` is alphabetically ordered and signal scores are coarse (the report shows scores landing on 20/25/35/50/60/75/80/90), ties are frequent — and `Array.prototype.sort` is stable, so every tie breaks in source-array order, pushing A/B tickers to the top of the ranked list.

Check whether the ranking sort has an explicit tie-breaker. If it doesn't, this affects the **EDGE** engine today and biases the trade history the Claude Report draws conclusions from. Fix it independently of the Warrior work.

### Two strategies

**1. Intraday universe (market open → close)**

```
GET https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=50
GET https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?top=50
```

SIP-based. Union the two, dedupe. This is the "Top Gainer scanner" primitive.

**2. Pre-market universe (before 6:30am PT)**

The movers endpoint resets at market open and returns *prior-day* movers until then, so it cannot give you pre-market gappers. Build this one yourself:

1. `GET /v2/assets?status=active&asset_class=us_equity` → filter to `tradable: true`, exchange in NASDAQ/NYSE/AMEX
2. Filter to prior close $1–$20 (from cached daily bars — no live call needed)
3. Batch `GET /v2/stocks/snapshots?symbols=…` over the survivors, ~200 symbols per request, `feed=sip`
4. Compute `gapPct = (premarketPrice - prevClose) / prevClose`
5. Return the top 50 by `gapPct`, plus anything above +10%

Cache the asset list for 24 hours. Cache prior closes daily.

### Interface

```js
getUniverse({ session, strategy })
// session  — from core/clock.js
// strategy — 'movers' | 'premarket-gap' | 'full-filtered'
// → [{ symbol, price, prevClose, changePct, volume, source: 'movers'|'actives'|'premarket-gap' }]
```

An earlier draft showed this without `strategy`; the three-strategy form above is correct.

The "fewer than 30 requests per scan" acceptance bullet applies to the two Warrior strategies (`movers`, `premarket-gap`). `full-filtered` is the wide-scan case at ~41 requests — that's the number this spec cites elsewhere and the reason Phase 0.5's queue exists.

**Verify before building on it:** `top` maxes at 50 and the movers endpoint returns market-wide gainers with no price filter. If a typical day's top 50 are mostly above $20, the endpoint is too coarse for a $1–$20 low-float strategy, and deriving gainers from `full-filtered` snapshots becomes the primary mechanism rather than a fallback. Confirm coverage, not just availability.

### Phase 1 acceptance

- [ ] Pre-market run returns tickers **not** present in the v3 seed list — that's the point
- [ ] No alphabetical bias: run the scan, confirm the first-letter distribution is not concentrated in A–C
- [x] **Universe cost — measured live 2026-08-24, not estimated.**

| | Requests | Wall clock |
|---|---|---|
| `movers` | 2 | — |
| `premarket-gap` **warm** | 53 (asset 0 · closes 1 · pass1 29 · pass2 23) | **~5s** |
| `premarket-gap` **cold** | 169 (asset 1 · closes 116 · pass1 29 · pass2 23) | **44.5s** |

The cold cost is paid once per trading day. 44.5s is ~3% of the 6:00–6:25am PT window, and every scan after it is ~5s, so repeated checking through the window works — which was the requirement.

Two things this measurement corrected, both of which arithmetic got wrong:
- An earlier estimate said 76–87 cold. The first live run was **1,329 requests / 5.7 min** — the minute-bar fetcher paginated ~36× per chunk against a 3-hour window. Fixed with a 45-minute first pass plus a 3-hour fallback for symbols that missed it.
- Wall clock was 61s at 36 requests because the queue dispatched strictly serially. Counting requests without timing them hid it for a full day.

**Margin note:** 169 requests sits just under the 200-token bucket buffer. A larger universe or one more page per chunk pushes the cold path into throttling — correct behavior, but noticeably slower. Re-measure if the universe grows.
- [ ] Validate against a known past gap day: the stocks you know ran that morning appear in the pre-market universe

---

# Phase 2 — Warrior scaffold, engine registry, graceful degradation

Build the boundary before building anything that depends on it.

### `shell/registry.js`

```js
registerEngine(id, {
  label,               // 'EDGE' | 'Warrior' — display string
  renderTab,           // () → void — the engine's own tab content. In the registry
                       //   deliberately: it keeps dispatch to ONE mechanism, so the
                       //   boundary check stays mechanical and app.js never stores a
                       //   module reference.
  renderBadge,         // (position) → HTMLElement — small badge on a portfolio card
  renderSnapshot,      // (signalSnapshot) → HTMLElement — signal detail in modal
  evaluateExit,        // (position, liveData) → { status, reasons[] } — see Phase 6
  summarizeForReport   // (trades[]) → string — engine's own stats block
});

getEngine(id)          // → registration, or null if not loaded
```

**Shell never branches on engine id.** No `if (engineSource === 'WARRIOR')` anywhere in `shell/`. When `getEngine()` returns null, shell renders a neutral fallback:

- Badge → the raw `engineSource` string in a muted pill
- Snapshot → *"Signal detail unavailable — Warrior engine not loaded"*
- Exit → a generic conservative rule (stop breach only)
- Report → *"Warrior engine not loaded; N trades omitted from per-engine statistics"*

**Consequence to enforce:** no file under `shell/` or `engines/edge/` ever contains the strings `ABCD`, `VWAP Momentum`, `Gap and Go`, or `Red-to-Green`.

### Loading `engines/warrior/`

Load via dynamic `import()` inside try/catch, **not** bundled into `app.js`. If it's concatenated into a single bundle, a syntax error in Warrior code takes down the entire app before any try/catch can run.

**Confirmed:** today `index.html:96` loads a single `app.js` and nothing else. `engines/warrior/index.js` must be served as its own file. Dynamic `import()` works from a classic script, so `app.js` does not need to become a module for this — but the Warrior file does, and it must be a real separate request. Do not let a future build step concatenate it back in; that silently deletes the isolation guarantee while every test still passes.

```js
try {
  const warrior = await import('./engines/warrior/index.js');
  warrior.register();
} catch (err) {
  state.warrior = { status: 'unavailable', error: err.message };
}
```

### Error boundary — implement it correctly

The v1 doc described this right and would have been built wrong. Three specifics:

1. A try/catch around a **`setInterval` call** does not catch throws inside the **callback**. The try/catch goes *inside* the callback body.
2. try/catch does not catch async rejections. Every promise chain needs `.catch()`.
3. Add `window.addEventListener('unhandledrejection', …)` that attributes failures by module tag, so a Warrior async failure is identifiable rather than anonymous.

On any caught Warrior error: the Warrior view shows an explicit error state **with the real error message**. It never throws into shared code and never fails silently.

### Navigation — answering v1's open question 2

**Revised 2026-08-23.** The v1 review recommended nesting Warrior inside Signals as a segmented control, on the grounds that a 7th nav tab would be ~55px wide at 390px. That premise was wrong: Watchlist and News were removed from the app deliberately some time before v2.9.0, so the current nav has **four** tabs — Signals, Portfolio, Sold, Settings. A fifth gives ~78px each, which is comfortable.

**Warrior gets its own bottom-nav tab, positioned between Signals and Portfolio.**

Final nav order: `Signals · Warrior · Portfolio · Sold · Settings`

That placement is deliberate — the two screeners sit adjacent, so switching between engines is a single tap, and both sit upstream of the tabs that track what you already own.

The stronger argument is now architectural rather than cosmetic. A separate tab means the shell mounts exactly one engine's render function per nav destination — the simplest possible dispatch, and it keeps Phase 2's boundary work trivial. Nesting would make the Signals tab a container that performs a *second* dispatch inside the first, adding a coupling point precisely where this spec is trying to keep things clean, and buying nothing now that crowding isn't a concern.

It also matches the mental model the rest of the spec is built on: two independent engines, not two views of one screener.

Only the active tab's render path executes. The inactive engine is never called from the shared render loop.

### Phase 2 acceptance

- [ ] Delete `engines/warrior/` entirely → **Signals, Portfolio, Sold, Settings** all work normally; the Warrior tab shows "engine unavailable". (Corrected: an earlier draft listed Watchlist and News — both were removed from the app before v2.9.0.)
- [ ] `app.js` holds **no** stored reference to the Warrior module after `register()` returns. Every call into Warrior code, including rendering its own tab, goes through the registry — no exceptions, so the boundary check is mechanical rather than a judgement call.
- [ ] Introduce a deliberate syntax error in `engines/warrior/index.js` → same result, app still loads
- [ ] Throw deliberately inside the Warrior scan interval → only Warrior stops; EDGE polling continues
- [ ] `grep -r "ABCD" shell/ engines/edge/` returns nothing

---

# Phase 3 — The 5 Pillars gate

### Feed: use delayed SIP, not real-time IEX

Alpaca Basic gives real-time **IEX only**, or **15-minute-delayed SIP**. IEX is one exchange carrying a small single-digit percentage of consolidated volume.

Relative volume computed from IEX bars against a 30-day consolidated average is a ratio of two different things — not noisy, wrong. Same for VWAP, high-of-day, and every volume-surge test in §5.

**Corrected 2026-08-24 against a live 403.** An earlier draft said all Warrior bar *and snapshot* requests should pass `feed: 'sip'`. That is wrong and will fail:

```
403 Forbidden — "subscription does not permit querying recent SIP data"
```

Basic permits SIP only for data **older than 15 minutes**. The rule that actually works:

| Request type | Feed |
|---|---|
| Historical bars with `end` ≥ 15 min in the past | `sip` — use it, this is where the value is |
| Snapshots / latest-quote / latest-trade | `iex` only — SIP is forbidden, no exceptions |

**Consequence for pre-market.** Snapshots fall back to IEX, and pre-market IEX volume is negligible — gap percentages computed from it are unreliable or absent for most symbols. So the pre-market gap scan must **not** be built on snapshots. Use 15-minute-delayed SIP minute bars instead: a 6:00am PT scan sees data through 5:45am, which is entirely adequate for detecting a gap.

Everywhere else the original reasoning holds — complete-but-15-minutes-late beats real-time-but-2%-of-the-tape, on an hours-scale check-in cadence.

Every Warrior card displays its data timestamp and minutes-since-trigger, so a late signal is visibly late.

### Gate order — cheapest first

Evaluate in this order and short-circuit. Never spend an FMP call (Phase 6) on a stock that already failed pillar 1.

| # | Pillar | Test | Data |
|---|---|---|---|
| 1 | Price range | `$1.00 ≤ price ≤ $20.00` | universe (free) |
| 2 | Daily % change | `changePct ≥ 10%` | universe (free) |
| 3 | Relative volume | **time-normalized** — see below | cached daily bars + delayed SIP **minute bars** |
| 4 | News catalyst | Alpaca news item for this symbol within the last 24h | 1 batched call |
| 5 | Float | `float < 10,000,000` (configurable) | FMP — **Phase 6** |
| — | **Halt check** | `NOT halted` — see below | Alpaca trading status |

### Pillar 3 — relative volume must be time-normalized

**Corrected.** An earlier draft said "SIP snapshot" for today's volume — stale wording from before the Feed section was fixed. Snapshots cannot use SIP. Use delayed SIP **minute bars**, reusing Phase 1's `_fetchLatestSipMinuteBars` fetch path.

Two requirements beyond swapping the source:

1. **Cumulative, not latest.** RVOL needs the sum of today's minute bars so far, not the most recent bar. Same fetch, different aggregation.
2. **Normalize by time of day.** Comparing 40 minutes of accumulated volume against a *full-day* 30-day average yields ~0.1× for everything in the morning. Nothing would ever clear a ≥5× gate before mid-afternoon, and it would present as a quiet market rather than a broken denominator. Compare today's volume-to-now against **the same time-of-day slice** of the 30-day average.

```
expectedByNow = avg30DayDailyVolume × intradayCurve(elapsedMinutes)
rvol          = todayVolumeToNow / expectedByNow
```

**`intradayCurve` is a static table, not `elapsedMinutes / 390`.** Intraday volume is U-shaped and front-loaded: roughly 13% of daily volume trades in the first thirty minutes against 7.7% of elapsed session time. A linear proxy therefore reads ~1.7× RVOL for *every* stock at the open, and deflates it midday — trading a systematic false negative for a systematic false positive on the pillar that decides what gets surfaced.

A hardcoded cumulative-share table costs zero extra requests and removes a known bias. Approximate shape (cumulative share of daily volume by elapsed session minutes):

| Elapsed | Cumulative share |
|---|---|
| 30 min | ~13% |
| 60 min | ~21% |
| 120 min | ~32% |
| 180 min | ~41% |
| 240 min | ~50% |
| 300 min | ~61% |
| 360 min | ~78% |
| 390 min | 100% |

Interpolate between points. Rejected alternative: fetching 30 days of minute bars per symbol to derive a true per-symbol curve — accurate, but it would blow the request budget by an order of magnitude for a second-order gain.

**Display the basis on the card** (expected-by-now alongside actual), so an implausible RVOL is diagnosable rather than mysterious.

**Pre-market: RVOL is `not-checked`.** The curve is defined over the 390-minute regular session, and cumulative volume since the open is zero before the open — so there is no valid denominator. Pre-market is also the primary Warrior workflow, which makes a silently wrong value here worse than anywhere else. Mark Pillar 3 `not-checked` for the whole pre-market session, same as the first-15-minutes rule, leaving price, change and news as the checkable pillars. That matches how the method actually screens pre-market (gap plus catalyst); a real pre-market RVOL needs a pre-market volume baseline this app doesn't have.

**Edge case that must not compute to zero:** with a 15-minute SIP delay, cumulative volume in the first 15 minutes of the session is genuinely empty. Render "RVOL not yet available" and exclude the candidate from QUALIFIED — never a 0× that reads as a real measurement. The same applies after hours: the curve's domain is the regular session only.

**Phase 4 follow-ups, both for the replay harness:** derive a real intraday curve from historical bars to replace the static table, and derive a pre-market volume baseline so Pillar 3 becomes checkable pre-market too. Cheap once the harness exists; not worth building before it.

### Pillar 4 — the gate window is 24h, the fetch window is 72h

These are deliberately different and must not be conflated. Bug 4 widened the *fetch* to 72 hours so weekend catalysts survive to Monday. The *gate* asks whether there is a catalyst within **24 hours**.

If Pillar 4 simply asks "did any news come back," a Friday-evening headline passes as a fresh catalyst on Monday afternoon. **Filter by article age explicitly inside the gate** — never inherit the fetch window as the criterion.

### Halt check — deferred, with the reason recorded

Alpaca has no REST endpoint for halt status, and **Basic caps WebSocket subscriptions at 30 symbols** — fewer than the candidate universe, so a streaming implementation could not cover the gate even if built, and would leave an unknown subset silently unchecked. Scraping NASDAQ's halt page is worse than nothing for a safety gate: no contract, and silent staleness fails in the direction that says a halted stock is fine.

Deferred deliberately. Two conditions:

- Every candidate card carries a **per-card** line: "Halt status not checked — verify in your broker before buying." Not a page banner; those go invisible within a week.
- `haltStatus: 'unknown'` is recorded in `signalSnapshot` at buy time, so Phase 8 can distinguish trades made without halt information from ones made with it.

The backstop is real: execution is manual on Robinhood, which shows halt status at order time.

### Halt check — original note

Sub-$20 low-float runners hit LULD volatility halts constantly, and a buy signal on a halted stock is actively dangerous. Query trading status and exclude halted symbols from signals; show them in a separate "halted" strip so you can see what's happening without being told to buy it.

Capture SSR (short sale restriction) status on each candidate for later report analysis — it directly shapes Red-to-Green behavior.

### Output shape — a gate result, not a boolean

```js
{
  symbol: 'ABCD',
  passed: false,
  pillars: [
    { id: 'price',   pass: true,  value: 4.12,  threshold: '$1–$20' },
    { id: 'change',  pass: true,  value: 0.34,  threshold: '≥10%' },
    { id: 'rvol',    pass: true,  value: 8.2,   threshold: '≥5×' },
    { id: 'news',    pass: true,  value: 'FDA clearance…', threshold: '<24h' },
    { id: 'float',   pass: false, value: 24_100_000, threshold: '<10M' }
  ],
  passCount: 4,
  halted: false,
  ssr: false,
  dataTimestamp: '2026-08-23T13:45:00Z'
}
```

### QUALIFIED before float exists (Phase 3 → Phase 6)

Pillar 5 lands in Phase 6. Until then float is **not checked** — which is neither a pass nor a fail, and must not be rendered as either.

- Each pillar carries `status: 'pass' | 'fail' | 'not-checked'`. Float is `'not-checked'` in Phase 3.
- **QUALIFIED = every *checkable* pillar passes.** Not `passCount === 5`, which would stay permanently empty; not `passCount === 4` with float dropped from the array, which would present a four-pillar method as if it were the whole method.
- Float stays visible on the card, reading "Float — not checked until Phase 6." A missing pillar teaches the wrong criteria; a visibly unchecked one doesn't.
- `signalSnapshot` records `float: { status: 'not-checked' }`, so Phase 8 can distinguish trades made before float existed. Same shape as `haltStatus: 'unknown'` — and it means the snapshot format doesn't change when Phase 6 lands.

**Never stub a pillar as passing.** A fabricated check on unverified data is the same failure as the $0.00 P&L: a real-looking number standing in for something never measured.

### Near-miss tier — required, not optional

A hard AND across 5 rare conditions means an empty screen on most check-ins, and no way to distinguish *"no candidates today"* from *"the engine is broken."*

Render two sections:

- **QUALIFIED** — every *checkable* pillar passes (see the section above; `not-checked` pillars are excluded from the count, never treated as passing)
- **NEAR MISS** — exactly one checkable pillar fails, each pillar shown pass/fail/not-checked with its **actual value**

**Short-circuit only on the free pillars.** Price and change come from universe data at zero request cost, so failing either is a plain disqualification — stop there. But for anything clearing those two, evaluate **both** Pillar 3 and Pillar 4 rather than halting at the first failure.

Reason: short-circuiting past Pillar 3 leaves Pillar 4 `not-checked`, which makes "exactly one checkable pillar fails" vacuously true for *every* rejected candidate — a $25 stock would classify as NEAR MISS identically to a genuine 4-of-5. It also guts the tier's purpose, since a card reading "RVOL fail, news not-checked" only half-explains the rejection.

The cost is bounded: that set is the same batch already receiving RVOL data, and news batches 10 symbols per request — a couple of extra calls. Cheap, and it makes a single failure genuinely single.

This serves debugging and the project's stated goal of understanding why something is or isn't recommended.

### Phase 3 acceptance

**Merged to main 2026-08-26 with two items below marked OUTSTANDING, not verified.** Rationale for merging anyway: a wrong `feed` produces a visible 403 rather than silent bad data, and Phase 2's isolation boundary was verified live under three failure modes, so a broken Warrior tab can't affect EDGE. `engines/warrior/index.js`'s `_scanTick()` logs `[PHASE-3-UNVERIFIED]` to the console with a per-stage request count on every regular-session scan until both are confirmed and that logging block is deleted — see the comment right above it.

- [ ] **OUTSTANDING** — All Warrior requests use `feed=sip`; verify in the network log during a regular-session scan
- [ ] Gate short-circuits — a stock failing pillar 1 triggers no further calls
- [ ] Near-miss tier renders with real values on a day with zero qualified candidates
- [x] Every candidate card displays the halt-status-unknown line (there is no halted boolean — halt detection is deferred; see above) — live-checked 2026-08-26
- [x] Float renders as `not-checked`, never as a pass, and never absent from the pillar list — live-checked 2026-08-26. **Superseded by Phase 6 (2026-09-04):** float is real now; this line records what was true in Phase 3, before it existed. Phase 6's own acceptance checklist below covers the current, real behavior.
- [ ] RVOL uses the static intraday curve, not a linear elapsed fraction — verify a mid-session candidate's expected-by-now figure is materially above `dailyAvg × elapsed/390`
- [ ] In the first 15 minutes of a session, RVOL reads "not yet available" rather than 0×
- [ ] During pre-market, Pillar 3 renders `not-checked` — never 0×, never a divide-by-zero, never a number derived from a regular-session curve (live-checked 2026-08-26, but during CLOSED not PRE specifically — reads "not available outside regular session"; the PRE-specific case is still unverified live)
- [ ] Pillar 4 passes only on articles under 24h old, verified against a candidate whose only news is 25–72h old — it must fail that pillar despite news being present in the fetched data
- [ ] **OUTSTANDING** — Full scan of a 50-symbol universe stays under 30 requests, measured during regular session with RVOL's 30-day-average and cumulative-minute-bar fetches actually running. Live-checked 2026-08-26 at ~6 requests, but that run had RVOL skipped entirely (outside regular session) — that number does not satisfy this bullet
- [ ] QUALIFIED and NEAR MISS section headers carry a caveat outside regular session (or the first 15 minutes of it) — RVOL is the most selective pillar, and a bare "QUALIFIED (10)" label outside the window where RVOL is checkable overclaims what the pillars underneath it actually support. Fixed 2026-08-26 (`evaluateGateBatch`'s `rvolCheckable` flag, read by `renderTab`, unit-tested); not yet visually confirmed live

---

# Phase 4 — Replay harness

**Build this before the setup detectors.** Otherwise you are shipping five pattern detectors that no one has ever watched fire, into a market you can only observe twice a day.

Historical minute bars are already free on the Basic plan. The harness is cheap and it decouples engine development from live market hours.

**Phase 5 doesn't exist yet, so Phase 4 has nothing real to classify against.** Resolved 2026-08-27: the harness classifier is a plain injectable function (`(barsSoFar) -> trigger | null`), and Phase 4 ships one self-contained example — price change from the session's open crossing Pillar 2's real `CHANGE_MIN_PCT` (10%) threshold, reusing that constant from `gate.js` rather than inventing a new one. It needs no external baseline (unlike an RVOL-based trigger, which would need a 30-day trailing average *as of a past date* — the existing `_getSip30DayAvgVolume` only computes that relative to *today* and would need new date-parameterized logic; building that inside the phase meant to prove the harness works means a bad replay result couldn't be attributed to the harness or the fetcher). Real Phase 5 setups replace the example without changing the harness itself.

### What it does

1. Pick a date and a symbol list (or reuse a stored universe snapshot)
2. Fetch that day's 1-minute SIP bars, **including pre-market** — the fetch window is a parameter, defaulting to the extended session starting 4:00am ET (1:00am PT — the same boundary `core/clock.js`'s `isPreMarketHours` already uses) through the regular session close (1:00pm PT). Gap and Go is defined against the pre-market high and triggers on the first post-open bar clearing it; scoping the fetch to the regular session only makes that setup unreplayable, and it's the one the pre-market workflow depends on.
3. Replay them forward, bar by bar, feeding each prefix to the setup classifier as if it were live
4. Record every trigger: setup id, trigger time, trigger price, and for each horizon (+5m / +15m / +30m / close): the close-based forward return, **plus max favorable and max adverse excursion within that horizon** (the best/worst price touched between the trigger and the horizon, not just the price AT the horizon). Same bars already fetched, no extra request. Ross exits at roughly 2:1 within minutes — a setup that runs +20% and closes flat is a good trade with a normal exit, not a failure, and a close-only return would read it as one. Fixed-horizon close returns alone systematically undervalue the setups this engine exists to find.

**`close` is not comparable across triggers at different times of day** — found via live replay validation (2026-08-28): it scores against `bars[bars.length-1]` (whatever the fetched window's last bar is), so a trigger 6 minutes before the window ends and one 5 hours before it get scored on the same axis despite having wildly different room to move; MFE/MAE for that horizon inherit the same bias. Kept rather than deleted (it's free, already-fetched data, and "did this survive to end of day" is a real question for a specific trade), but every trigger now also carries `minutesOfSessionRemainingAtTrigger` (minutes to 1:00pm PT, `core/clock.js`'s own regular-session-close boundary) so the incomparability is visible on the row instead of silently misread — same "show what you don't know" principle as `gate.js`'s not-checked pillars.

### Fetch-window chunk size — proof, not estimate

The default window (4:00am ET to regular close) is 720 minutes. Alpaca's single-page ceiling is 10,000 bars. `floor(10000 / 720) = 13` — 13 symbols/chunk stays single-page (13×720=9,360 ≤ 10,000); 14 does not (14×720=10,080 > 10,000). `REPLAY_CHUNK_SIZE = 13` is proven single-page **for the default window specifically**. Because the window is a caller-supplied parameter, not a compile-time constant, a wider custom window can't carry the same static proof — correctness there falls back to `_fetchRawMinuteBars`'s existing `next_page_token`-following (already tested, `pagination-merge.test.js`), at the cost of extra round trips. Both properties hold: the default case is single-page and cheap; any wider case is still correct, just not free.

### Why it earns its place

- Tells you whether a setup definition fires at all, and how often
- Tells you what the signal is worth *before* latency — so Phase 5's latency question can be answered with numbers
- Regression-tests the classifiers: change a threshold, re-run, compare

### Access

Hide behind a Settings toggle (`Developer tools`). It is not a user-facing feature. The toggle itself is generic (no Warrior-specific strings, per CLAUDE.md's engine-name rule for `shell/`); the replay panel it reveals is rendered by Warrior's own `renderTab()`, inside the Warrior tab.

### Range-scan mode — validating across many days, not one (added 2026-08-29)

**Why:** a single-day replay result is not evidence a classifier is right — "ABCD: 0 triggers on 2026-08-24" is equally consistent with "ABCD is broken" and "ABCD correctly didn't fire that day." The circularity the fixture-only tests already had (a wrong assumption encoded once in the classifier and again in its own test fixture, so both agree) reappears at the replay-harness level unless the harness is run across enough real days that a real pattern — never fires, fires constantly, only fires on stocks it shouldn't — becomes visible. Range-scan mode is that: the same replay panel, given an end date, walks every trading day in `[startDate, endDate]` and scores each classifier against real bars on all of them, then rolls the results into one totals row per setup. The totals row, not any single day's cell, is the actual acceptance evidence for a setup.

- **One fetch, all five setups.** Selecting "All setups" (`ALL_SETUPS_ID`) evaluates all five classifiers against the same fetched bars for a given symbol/day, rather than five independent fetches — `_evaluateSetupsAgainstBars` in `setups.js`.
- **`prevClose` carried forward, not re-fetched per day.** Symbols scanned in chronological order let each day's own last bar become the next day's `prevClose`; only the first day (or a day recovering from a fetch failure) needs a real `fetchPrevCloseAsOf` call. Self-healing: a broken chain link just re-fetches for the symbols missing a value.
- **Three-state cells, matching the gate's not-checked/pass/fail discipline.** Every symbol-day-setup result is either evaluated-with-a-trigger-count (including zero, a real "checked and it didn't fire") or `{notEvaluated: true, reason}` (fetch failure, no bars for that symbol that day — market holiday, delisting, thin/no trading). Collapsing the second case into a bare zero would silently misrepresent "couldn't check" as "checked and rejected."
- **DST-safe date walking.** `_nextDateStr` increments by UTC calendar-date string, never by adding 24h of real time, which breaks across a DST transition (directly informed by this project's earlier timezone-sweep findings elsewhere in this doc).
- **Cost guardrail is a soft confirm, not a hard cap.** A live pre-flight estimate (`estimateRangeScanRequests`) is shown next to the Run button, updated on every input change. Crossing either of two thresholds — more than 30 trading days, or more than 100 estimated requests — requires one extra confirming click before the scan runs; a separate hard ceiling of 250 trading days blocks the request outright as a typo backstop. A flat day-count cap was considered and rejected — it would make the tool decorative for the actual use case (validating a setup across real market history, which needs weeks, not days).
- **Live progress, partial-results-survive-failure, cancel.** The scan reports `{index, total, dateStr}` after each day; a day that fails to fetch is recorded as `notEvaluated` and the scan continues rather than aborting; a Cancel button sets a flag checked between days, returning whatever days completed rather than discarding them.
- **Paced by the existing shared queue, not a custom delay.** Every Alpaca call still goes through `core/api-client.js`'s `alpacaGet` → `enqueue`, which already rate-limits every caller unconditionally; the scan's own sequential per-day `await` (required anyway by the `prevClose` carry-forward dependency) is enough to get correct pacing and per-day progress for free — no hand-rolled `setTimeout` delays.

### No-lookahead — two negative controls, not one positive test

A lookahead bug never errors and makes every setup look excellent — it's the single easiest mistake to make here, and a passing "the classifier only saw bars up to index i" test can be vacuously true if the classifier never happened to check anything sensitive to it. Two controls, both persisted in `tests/`:

1. **Structural control.** A classifier triggers on a sentinel value planted in one specific future bar, using only its own argument. Run through the real replay loop: must trigger exactly at that bar's index. Run the *same classifier* through a deliberately broken stand-in loop that hands it the full array instead of `bars.slice(0, i+1)`: must trigger at index 0. Proves the real loop's truncation is genuine, not a no-op — the same shape as this session's queue-pacing and timezone negative controls.
2. **Anchoring control.** A classifier that closes over the full bar array from outside the harness — a real, plausible authoring mistake no argument-slicing can prevent, since JS can't sandbox a closure — and self-reports a fabricated future price. The harness never trusts a classifier's self-reported price/time; it derives both strictly from `barsSoFar`'s own last element. Asserts the recorded trigger's price matches the actual current bar, not the cheat's claim. This is a mitigation, not a guarantee: it stops a cheating classifier's *trigger record* from leaking future data, not the cheat's decision to trigger early in the first place. Document it as exactly that — "the harness derives price and time from `barsSoFar` and never trusts the classifier's self-report" is true and useful; "closure-based cheating is prevented" would not be.

### Phase 4 acceptance

- [x] Replaying a known past runner produces at least one trigger at a plausible time. Live-checked 2026-08-27: HVII 2026-08-24 — 6 triggers across 192 bars, timestamps spread through the session (09:04–13:40 UTC, none at bar 0 — the no-lookahead fingerprint holds live too), forward returns/MFE/MAE populated. AMIX's end-of-window trigger correctly returned nulls instead of a fabricated horizon; DAAQ (5 bars, thin trading) correctly produced zero triggers. Also surfaced a real finding, carried into Phase 5 below (re-arm rule) rather than fixed here — the harness itself already showed its value: every HVII trigger's MFE (~0.4%) against its MAE (-10.4%) and close (-9.0%) shows a bad entry invisible from live scanning alone.
- [x] Replay is deterministic — same inputs, same triggers. Unit-tested (`tests/replay.test.js`).
- [x] Output includes forward returns, MFE, and MAE at each horizon. Unit-tested against hand-computed values, including the "+20% then closes flat" shape MFE exists to catch, and the null-when-unreachable case (never a fabricated partial-window number).
- [x] The classifier receives only the bars up to the current replay index — no lookahead, verified by both negative controls, not just a positive-case test. Unit-tested: the structural control proves the real loop's truncation is genuine (a deliberately broken stand-in, given the same classifier, triggers 6 bars early); the anchoring control proves a self-reporting cheat's trigger record still can't carry a fabricated price/time — documented as a mitigation, not a claim the cheat itself is prevented.
- [x] Fetch window includes pre-market by default (4:00am ET / 1:00am PT — the same boundary `isPreMarketHours` already uses) and is parameterized. Unit-tested (`tests/pt-wall-clock.test.js`, `tests/replay.test.js`).

---

# Phase 5 — Setup detection

### Latency reality — which setups are worth building first

Gap and Go triggers in the first minutes after 6:30am PT. HOD Momentum resolves in minutes. A 9:00am PT check-in is ~2.5 hours late.

This is not just missed trades: the Claude Report (Phase 8) will attribute the resulting losses to **setup quality** when the cause is **latency**, and the report's purpose is to rewrite your scoring rules. You would tune a scoring system to fix a problem that isn't in it.

Two structural facts to build around:

- **iOS suspends timers.** In a home-screen PWA, `setInterval` stops when backgrounded or the screen locks. Background polling cannot be relied on for intraday work.
- **Push notifications need a server** — which the in-flight Supabase migration provides. That's the real fix, and it belongs in a follow-up doc.

**Build order within this phase:**

| Setup | Phase | Rationale |
|---|---|---|
| VWAP Momentum | 5a | Repeated entries through the session — survives a late check-in |
| ABCD | 5a | Same — the C→D breakout recurs |
| Gap and Go | 5b | Pre-market only, tied to a ~6:00–6:25am PT session |
| HOD Momentum | 5c | Mark **"informational — already triggered"** until notifications exist |
| Red-to-Green | 5c | Same |

Every signal carries `minutesSinceTrigger`. Anything over 20 minutes renders with a "LATE" flag and is excluded from the primary list.

### Setups are not mutually exclusive

A stock can be gapping, holding above VWAP, and printing a new HOD in the same minute. Return an **array**:

```js
setups: [
  { id: 'vwap-momentum', triggerPrice: 4.18, triggeredAt: '…',
    margins: { volumeMultiple: 5.2, threshold: 3.0, distanceAboveVwap: 0.014 } },
  { id: 'hod-momentum',  triggerPrice: 4.22, triggeredAt: '…',
    margins: { volumeMultiple: 3.1, threshold: 3.0, distanceAboveHod: 0.003 } }
]
```

**No `confidence` field.** An earlier draft included one with no formula behind it — an unfounded score presented as a measurement, which is the failure shape this project has found repeatedly elsewhere.

Record **raw margins** instead: how far past its threshold each condition actually got. That is measured data, and it lets the replay harness and Phase 8 discover *empirically* whether margin predicts outcome. Asserting that a 5× volume break beats a 3.01× one would be a guess; recording both and checking is the point of the whole engine.

Choose a display primary by this documented priority: `gap-and-go` → `abcd` → `vwap-momentum` → `hod-momentum` → `red-to-green`. Report by primary, but **persist the full array** so attribution can be revisited once trades exist.

### Setup definitions

These are our definitions, not Ross's. All operate on 1-minute SIP bars for the current session. Every threshold below goes in a config object so the replay harness can sweep them.

**`gap-and-go`**
- Precondition: `premarketPrice / prevClose - 1 ≥ 0.10`
- `premarketHigh` = highest price 4:00am–6:30am ET
- Trigger: first 1-min bar after the open whose high exceeds `premarketHigh` **and** whose volume ≥ 2× the average of the session's bars so far
- `triggerPrice` = `premarketHigh`

**`hod-momentum`**
- `hod` = session high excluding the current bar
- Trigger: current bar high > `hod` **and** current bar volume ≥ 3× the mean volume of the prior 15 bars
- Exclude the first 5 minutes of the session (everything is a new HOD then)

**`abcd`**
- `A` = session low in the first 60 minutes
- `B` = highest high after `A`, requiring `B/A - 1 ≥ 0.10`
- `C` = lowest low after `B`, requiring the pullback to retrace 30–60% of A→B, **and** mean volume over the B→C bars < mean volume over the A→B bars (pullback on declining volume)
- Trigger: a bar after `C` whose high exceeds `B` on volume ≥ 1.5× the B→C mean
- `triggerPrice` = `B`

**`vwap-momentum`**
- Session VWAP computed cumulatively: `Σ(typicalPrice × volume) / Σ(volume)`, `typicalPrice = (h+l+c)/3`
- Precondition: price crossed from below to above VWAP earlier in the session
- Pullback: a bar whose low comes within 0.5% of VWAP **without closing below it**
- Trigger: a subsequent bar closing above the pullback bar's high on rising volume
- `triggerPrice` = pullback bar high

**`red-to-green`**
- Definition used: crossing above the **prior day's close** (Ross's usage). Make the alternative — crossing above the session open — a config flag.
- Precondition: the session has traded below `prevClose`
- Trigger: first bar closing above `prevClose` with volume ≥ 2× the prior-15-bar mean
- `triggerPrice` = `prevClose`

### Margins — the actual field per setup (built 2026-08-28, revised 2026-08-29)

The two examples in "Setups are not mutually exclusive" above show the *shape* of margins, not a template every setup must force itself into. Implemented per setup's own real conditions:

- `gap-and-go`: `{volumeMultiple, threshold, gapPct, breakoutHigh, breakoutHighAbovePremarketHighPct, baselineSpanMinutes, baselineBarCount}`
- `hod-momentum`: `{volumeMultiple, threshold, breakoutHigh, breakoutHighAboveHodPct, baselineSpanMinutes, baselineBarCount}`
- `abcd`: `{volumeMultiple, threshold, aLevel, cLevel, gainPct, retracementPct, baselineSpanMinutes, baselineBarCount}`
- `vwap-momentum`: `{volumeMultiple, threshold, vwap, distanceAboveVwapPct, baselineSpanMinutes, baselineBarCount}` — redesigned 2026-08-29, see below; was `{volumeRatio, threshold: 1.0, distanceAboveVwap}`
- `red-to-green`: `{volumeMultiple, threshold, distanceAbovePrevClosePct, baselineSpanMinutes, baselineBarCount}`

**Every derived percentage ends in `Pct`** (renamed 2026-08-29 from e.g. `distanceAboveHod` to `breakoutHighAboveHodPct`) so the render layer's existing `Pct`-suffix formatting picks it up automatically — the original names fell through to a raw, unlabeled decimal instead of a percentage, a real bug found alongside the reference-point issue below, not the same bug.

**Every margin is recomputable from numbers shown on the same row** — a principle added 2026-08-29 after live-replay validation found `distanceAboveHod` couldn't be reconciled against the displayed price. Root cause: `gap-and-go`/`hod-momentum`'s trigger conditions check the bar's *high* against a level, while the harness's own `triggerPrice` (what's displayed, what entry/target/stop is built from) is always the bar's *close* — two different numbers on the same bar. `breakoutHigh` is now included explicitly so the derived `Pct` is checkable. Same principle applied to `abcd` (`aLevel`/`cLevel`, neither shown before) and `vwap-momentum` (`vwap`, the VWAP value itself, never shown before). `red-to-green` needed no addition — its trigger condition is close-based already, matching `triggerPrice`.

### Volume-multiple denominator — time-windowed, not bar-count-windowed (2026-08-29)

**Live-replay finding:** the original `hod-momentum`/`red-to-green` baseline ("mean of the last 15 bars") read 46.13× on a 64-bar (sparse) name against 2.21× on a 192-bar (dense) one for a similar-looking spike. Cause: Alpaca only returns a bar for a minute that actually traded, so "last 15 bars" for a thin name can reach back however far real time it takes to find them — 71 minutes, in the reported case — averaging in volume from over an hour earlier and comparing it to right now. Same failure shape Pillar 3's `intradayCurve()` fixed for RVOL: a window that looks fixed but silently varies in real elapsed time.

**Fix:** `_volumeBaselineOverMinutes(regularBars, endIndexExclusive, minutes)` bounds the lookback by real minutes, not bar count — whatever bars actually fall within that time window, however few. Applied to `hod-momentum`, `red-to-green`, and (see below) the redesigned `vwap-momentum`; `priorMinutesForMeanVolume` replaces the old `priorBarsForMeanVolume` in `SETUP_CONFIG`, same default value (15), reinterpreted as minutes instead of bars.

`gap-and-go` and `abcd` are deliberately **not** switched to this window shape: `gap-and-go`'s "average of the session's bars so far" is closer to the spec's own literal wording, and its own trigger condition ("first bar after the open") structurally fires within the first few minutes, so the unbounded-growth exposure is mostly theoretical there. `abcd`'s B→C window is the pullback itself — structurally defined by the price pattern, not an independent bar-count choice. Both still report `baselineSpanMinutes`/`baselineBarCount` for the same transparency, just without the window-shape change.

**`vwap-momentum`'s volume check was redesigned, not just re-thresholded.** It was a single-prior-bar `volumeRatio` with `threshold: 1.0` — "any uptick in volume vs. the immediately preceding bar," which is close to coin-flip odds on a noisy series and the worst case of the sparsity problem (a 1-bar baseline has no averaging at all). Live replay confirmed it too weak: 9 naive fires in one day on one symbol, the one shown a loser. Now uses the same `_volumeBaselineOverMinutes` baseline as its siblings, with a real `volumeMultiple` threshold of 1.5× (matching `abcd`, the next-lowest in the family).

### Pre-market armed levels — approved addition (2026-08-28)

No setup can trigger before the open (every trigger definition above requires a post-open bar, even `gap-and-go`: "first bar *after* the open"), so detection itself doesn't run during PRE. But Ross's actual 6am workflow is building a watchlist of *levels*, not waiting on triggers — and `gap-and-go`'s `premarketHigh` is nearly free to surface early, since it's the same computation the setup needs once the session opens anyway, just read earlier.

For every QUALIFIED candidate during PRE: compute and display `premarketHigh` as an **armed level** — "Gap and Go level: $4.18" — no trigger record, no setup object, no margins. Once OPEN begins, this is replaced by real detection (which may or may not actually fire on that level).

### Re-arm rule — one event, one trigger

**Found via the Phase 4 replay harness (2026-08-27), on HVII 2026-08-24:** the harness's own edge-triggering (fire once while the classifier stays truthy, reset the instant it goes falsy) recorded six triggers for a price oscillating across a single threshold ($7.66–$7.71) — one HOD break, not six. Harmless for Phase 4's example classifier; not harmless here. Six `hod-momentum` records off one move means Phase 8's per-setup attribution counts it six times, and a setup that chops near its threshold reads as more active — and, once outcomes are attributed, as more reliable or less reliable than one that fires cleanly — than the same real signal fired once.

Every setup above needs a re-arm rule, not just the harness's bar-to-bar edge-trigger. **Primary mechanism: a minimum price retracement away from the trigger level, not a fixed time cooldown.** A time-based cooldown was considered and rejected as the primary rule: it suppresses a genuinely new, later breakout that happens to fall inside the cooldown window (a real second opportunity discarded), and it doesn't scale with a setup's own volatility the way a price-distance threshold naturally does.

Shape of the rule, applied per setup per candidate:
- On trigger: fire once, enter a **cooling** state, and remember the level the trigger fired against (`hod-momentum`: the broken `hod`; `vwap-momentum`: VWAP; `gap-and-go`: `premarketHigh`; etc. — each setup already has a natural reference level in its own definition above).
- While cooling: no new trigger for this setup, regardless of how many times the classifier's underlying condition flickers true/false.
- **Re-arm** only once price retraces beyond a configurable distance from that reference level, in the direction that would invalidate the original setup (a breakout-above setup re-arms once price falls back *below* the level by ≥ `rearmDistancePct`, not merely below the level itself — the retreat has to be real, not a one-tick dip). Default `rearmDistancePct`: start at 1%, per-setup override in the same config object the thresholds already live in (spec's existing "every threshold below goes in a config object" rule).
- Once re-armed, a later qualifying crossing is a genuinely new episode and fires again.

Secondary, defensive only: a small minimum-bar-count floor between re-arm and the next trigger (e.g. 1–2 bars), purely to absorb same-bar/adjacent-bar noise — not a substitute for the price-distance rule, since a pure time floor has the same false-negative problem as a cooldown, just shorter.

**This is exactly what the replay harness exists to settle, not guess at.** `rearmDistancePct` is a threshold like any other in the setup config — sweep it the same way the spec already calls for sweeping entry/target/stop thresholds, and use the harness to check the actual tradeoff on real history: too tight and HVII's six triggers become three instead of one; too wide and a genuine second breakout 20 minutes later gets silently dropped. Pick the value the data supports, not the value that feels right.

### Entry / target / stop — Warrior's own math

Do **not** reuse `calcEntryTargetStop`. EDGE's ATR-based multi-day math is wrong for same-day tight-stop trades.

```
entry  = triggerPrice
stop   = max( recentSwingLow, entry × (1 - maxStopPct) )    // maxStopPct default 0.05
risk   = entry - stop
target = entry + (targetR × risk)                            // targetR default 2.0
```

`recentSwingLow` = lowest low of the 5 bars before the trigger.

**`maxStopPct`/`targetR` live in the same sweepable config object as every setup's own thresholds and `rearmDistancePct` — not inline constants, not a Settings field.** The replay harness exists to calibrate thresholds against real history; a bare constant in code can't be swept without an edit. Settings stays reserved for the one genuinely user-facing value (`riskPerTradePct` below) — per the spec's own explicit "new Settings field" language, which names only that one.

### Position sizing — new, and probably the highest-value addition

Ross's actual discipline is fixed dollar risk per trade. The v1 doc defines a tight stop and then never uses it.

```
suggestedShares = floor( riskPerTrade / (entry - stop) )
```

`riskPerTradePct` is a new Settings field (default 2) — a **percentage**, computed live against the current budget each time, not a stored dollar figure that goes stale silently if the budget changes. Available-budget cap reuses EDGE's own budget-bar formula (`budget − deployed`, extracted into a shared `getAvailableBudget()`) rather than a second, parallel computation that could drift from what the budget bar itself shows. Cap `suggestedShares × entry` at available budget and show which constraint bound the size.

On a $500 budget with average wins of +$3.47 and losses of −$3.33 (per the June report), sizing is doing more work than setup selection. Show suggested share count on every Warrior card.

### Phase 5 acceptance

- [x] Every setup validated through the replay harness before shipping. All five classifiers are written to `runReplay`'s exact interface and unit-tested; `hod-momentum` additionally has a dedicated test walking it through the real bar-by-bar `runReplay` loop (not just a single direct call), confirming the same guarantee Phase 4 established (correct trigger index, no lookahead) holds for a real setup, not just the disposable example.
- [x] Every setup implements the re-arm rule via `detectSetupsForCandidate`'s uniform `runReplay(..., {rearmDistancePct})` wiring — no setup reimplements it individually. **Mechanism unit-tested** with a fixture reproducing HVII's exact shape (breakout, harmless chop within the retracement band, genuine retreat, genuine second breakout): naive edge-triggering gives 4 triggers, re-arm gives 2, matching real-event count. **OUTSTANDING** — genuine live verification against the real HVII 2026-08-24 data (not just a reproduction of its shape) needs either live Alpaca access or the replay panel gaining a way to select a real setup classifier instead of Phase 4's placeholder (a small, deliberately-deferred follow-up, not built here).
- [x] Setups return arrays with a deterministic primary. Unit-tested with two simultaneous setups (mechanism is count-agnostic — sorting logic doesn't special-case "three"); primary is `SETUP_PRIORITY`'s first non-late entry.
- [x] `minutesSinceTrigger` computed and rendered on every card; >20min flagged LATE **and demoted** — found while writing this checklist that the first implementation only flagged, not demoted (sorted by priority regardless of late status); fixed and unit-tested (a fixture where the highest-priority setup is late and a lower-priority one isn't confirms the non-late one sorts first).
- [x] Suggested share count present and correct: unit-tested against hand-computed risk- and budget-bound cases, including a floating-point edge case (`5.00 − 4.80` in IEEE 754 is `0.20000000000000018`, which without an epsilon before flooring reports 49 shares where the real math supports 50 — caught by a direct test, not assumed away).
- [x] No Warrior code path calls `calcEntryTargetStop` or `calcScore` — unit-tested across every file in `engines/warrior/`, not just `setups.js`.
- [x] `maxStopPct`/`targetR`/`rearmDistancePct` live in the sweepable `SETUP_CONFIG` object, not inline constants — confirmed by the tests importing and asserting against `SETUP_CONFIG` directly rather than hardcoded expectations.
- [x] Pre-market armed levels (approved addition) — `computeArmedLevels`/`computePremarketHigh` unit-tested; wired into `evaluateSetupsBatch`'s PRE-session branch.

---

# Phase 6 — float, completing Pillar 5

**Shipped against SEC EDGAR (data.sec.gov), not FMP** (2026-09-04) — this
section was written assuming FMP; live testing during the 18-month
backtest found FMP 402s on exactly this gate's microcap population
(DAIC/SPCE/HUBC/QH/HCWC all blocked — a symbol-coverage restriction on
the available tier, not a documented "needs a paid plan" nuance). EDGAR
requires no key, no daily quota (rate-limited by request pacing, ~10/s,
not a call count) and was confirmed live to serve exactly the symbols
FMP couldn't. Shares outstanding only, not "float" — no haircut, labeled
honestly, same settled convention the backtest itself used. Real
implementation: `core/edgar.js` (fetch/cache), `engines/warrior/gate.js`'s
`evaluatePillarFloat` (threshold logic).

### Three conditions (adapted to EDGAR)

1. **Apply last.** Scoped to `pillar12Survivors` (price+change survivors), same population `rvol`/`news` already use — not further narrowed to "only if rvol+news both already passed" (that stricter reading was considered and rejected: it would reintroduce exactly the short-circuit-between-stage-2-pillars bug already fixed for rvol/news, where a NEAR_MISS/disqualified card would show an incomplete picture). The cost pressure that motivated the original FMP-era "never call for an already-failed candidate" language (a 250/day quota) doesn't transfer to EDGAR, which has no daily cap.
2. **Cache hard.** 14 days per symbol (midpoint of the spec's 7–30 day range) in `state.warriorFloatCache`, plus a 24h cache on the CIK-map lookup itself. No daily-quota counter — EDGAR has none; the FMP-era "stop at 240" language doesn't apply.
3. **Not a boolean.** Threshold configurable via Settings (`state.settings.floatThresholdShares`, default 10,000,000, same default this section always specified), never hardcoded. Float value **and** its as-of filing date shown on the card.

**Known limitation, adapted from the original FMP-era note:** EDGAR filings are as fresh as the company's own reporting cadence (quarterly for domestic 10-Q filers, annual-only for foreign private issuers on 20-F) — a filing can be materially stale relative to a dilutive offering from last week, same risk the original note flagged for FMP's cache. `stalenessDays` (nearest-preceding-filing age) is captured and shown alongside the value for exactly this reason.

**A real divergence, disclosed rather than silently resolved:** the original acceptance line below ("qualified candidates fall back to 4/5 near-miss rather than disappearing" on daily-quota exhaustion) is FMP-quota-specific and has no EDGAR analog. What EDGAR DOES have — a real request failure (rate-limited, network error) — is treated as `'fetch-failed'`, which **BLOCKS** qualification outright (a new `BLOCKED` tier, distinct from disqualified), matching the same fetch-failed-vs-not-checked decision this session's gate-honesty pass made for rvol/news. A near-miss implies "we checked, it's close"; a fetch failure isn't that.

### Settings additions (adapted)

- ~~FMP API Key~~ — not applicable, EDGAR needs no key
- ~~"Test Connections" extended to ping FMP~~ — not built; EDGAR self-validates on first real use, no auth to independently verify
- Float threshold — numeric, default 10,000,000 — **shipped**
- ~~Daily FMP call counter~~ — not applicable, EDGAR has no daily quota

### Phase 6 acceptance

- [x] Float cache hit does not consume a call — verified live 2026-09-04 (second call for the same symbol: 0 requests)
- [ ] ~~Daily counter stops at 240...~~ — not applicable to EDGAR (see divergence note above); superseded by the `BLOCKED`-on-fetch-failure behavior instead
- [x] Float value and its as-of date shown on the card — verified live 2026-09-04 (DAIC: 30,259,579 shares as of 2026-05-12, SPCE: 151,595,903 as of 2026-08-12)
- [x] ~~Key stored in localStorage/Supabase, never hardcoded~~ — not applicable, no key exists to store

---

# Phase 7 — Portfolio and Sold integration

### Position envelope — engine-agnostic

```js
{
  // …existing position fields…
  engineSource:  'EDGE' | 'WARRIOR',
  signalSnapshot: { /* opaque to shell — only the owning engine reads it */ },
  exitRuleId:    'edge.atr.multiday' | 'warrior.sameday.tightstop',
  minutesLate:    12          // WARRIOR only: minutes between trigger and entry
}
```

For Warrior, `signalSnapshot` holds the full gate result (§3 output shape) plus the setups array, entry/target/stop, and suggested shares. This pairs with the Full Signal Capture doc — capture everything at buy time.

`minutesLate` exists so the report can separate latency from setup quality. Without it, Phase 8's statistics will blame the wrong thing.

### First: the Supabase migration is only half done for sold trades

Confirmed 2026-08-23. Portfolio got a full read+write migration — `loadPortfolioFromSupabase` hydrates `state.portfolio` at boot. **Sold trades only got the write half.**

| Path | Source |
|---|---|
| Sold tab display (`state.sold`) | localStorage `edge_sold` — **only** read source |
| `writeTradeToSupabase` | Supabase `trades` — write only, never read back |
| `generateClaudeReport()` (`app.js:5309`) | Supabase `trades` |

Four consequences, all live today:

1. **The tab and the report read different datasets.** The Sold tab shows localStorage; the Claude Report queries Supabase. The `trades` table holds 24 rows dating from 2026-08-07; the 11 trades in `edge-report-2026-06-25.txt` are not in it — `writeTradeToSupabase` didn't exist until commit `7d03d59` on 2026-08-10. So a report generated today silently omits the earliest history while the tab still displays it.
2. **History is device-local.** On a new device or after clearing site data, `state.sold` initializes to `[]` and the tab renders "No completed trades yet" while the rows sit intact and unreachable in Supabase.
3. **Writes are fire-and-forget.** `confirmMarkSold` (`app.js:4646`) calls `writeTradeToSupabase` without `await`; the function catches its own errors, logs to console, and returns. A transient failure drops that row from Supabase permanently with no user-visible signal. The local copy always survives, so the divergence is invisible.
4. **At least one duplicate exists** — two identical MSTU rows for 2026-08-17→2026-08-19, suggesting the write path can fire twice.

**Fold the fix into this phase's schema change**, not a separate patch — it touches the same records:

- Hydrate `state.sold` from Supabase at boot, mirroring `loadPortfolioFromSupabase`, with localStorage as a fallback/cache rather than the source of truth
- `await` the write, retry on failure, and surface a persistent failure in the UI — a silently missing trade corrupts every statistic downstream
- Add a uniqueness constraint or an idempotency key to prevent double-writes; dedupe the existing MSTU pair
- **Backfill pre-2026-08-10 trades.** `edge-report-2026-06-25.txt` carries full per-trade detail and is a viable source. One-time script, not app code.
- Until the backfill lands, the Claude Report must state which date range it actually covers rather than presenting a truncated set as complete

### Schema — the Supabase migration has already landed

**Correction to v1:** persistence is already Supabase, table `portfolio`, keyed by `position_id` (`app.js:5338–5359`). This is a column addition to an existing table, not coordination with a pending migration.

Add `engineSource`, `signalSnapshot` (jsonb), `exitRuleId`, and `minutesLate` to the `portfolio` table and the corresponding sold-trades store in one migration.

**Backfill:** existing positions and sold records predate the field. Default them to `'EDGE'`, never `undefined`. The v1 doc's "always populated, no third case" is true going forward and false for the 11 trades already in history — and an `undefined` makes every engine-filtered statistic silently undercount.

### Sell warnings — who owns them

**Confirmed:** there is exactly one entry point today — `calcUnifiedRecommendation(position, currentSignal, macroContext, snap)` at `app.js:4369`, called unconditionally for every position from `renderPortfolioTab()` (`app.js:4009`). There is no per-engine dispatch.

Two EDGE-specific dependencies inside it:

- `app.js:4375` — `if (price <= position.stop)` → `'SELL NOW — Stop-loss hit'`. Warrior positions do have a stop, so this line survives.
- `app.js:4390–4391` — `MAX_HOLD_DAYS[position.duration]` where `MAX_HOLD_DAYS = { DAY: 1, '3-DAY': 4, WEEK: 7 }` (`app.js:4347`). A Warrior position has no `duration`, so this evaluates to `undefined` and **silently disables the max-hold factor** rather than throwing.

That silent-`undefined` path is the worst available outcome: the banner still renders, still looks authoritative, and has quietly dropped a term. Replace the unconditional call with registry dispatch.

Warrior registers its own `evaluateExit`:

```js
evaluateExit(position, liveData) → { status: 'SELL_NOW' | 'SELL_SOON' | 'HOLDING', reasons: [] }
```

**Warrior exit rules (`warrior.sameday.tightstop`):**

| Status | Trigger |
|---|---|
| SELL NOW | price ≤ stop |
| SELL NOW | time ≥ 12:30pm PT (30 min before close — same-day discipline) |
| SELL SOON | price ≥ entry + 2R (target reached) |
| SELL SOON | time ≥ 8:00am PT and position still open (past the high-momentum window) |
| SELL SOON | price gave back more than half its peak gain since entry |
| HOLDING | none of the above |

**Duration badge — answering v1's open question 3.** Warrior positions do **not** get DAY/3-DAY/WEEK. They get `SAME DAY` in the Warrior accent color. This is structural, not cosmetic — those badges are inputs to EDGE's exit math and Warrior positions have no value for them.

### Filter UI

Segmented control on both Portfolio and Sold: **All / EDGE / Warrior**, filtering visible cards by `engineSource`. Portfolio and Sold cards show an engine badge, rendered via `getEngine(id).renderBadge()` — never via a shell-side branch.

### Phase 7 acceptance

- [ ] A Warrior position in the Portfolio shows correct exit warnings driven by `warrior.sameday.tightstop`
- [ ] Delete `engines/warrior/` with a Warrior position open → the card renders with the fallback badge and a generic exit rule; nothing throws
- [ ] Historical records show `engineSource: 'EDGE'`, not `undefined`
- [ ] Filter works on both tabs; counts add up to the All total
- [ ] `state.sold` hydrates from Supabase at boot — clearing localStorage does not empty the Sold tab
- [ ] The Sold tab and the Claude Report return the same trade count
- [ ] A simulated write failure on "Mark as Sold" is visible in the UI, not console-only
- [ ] Re-running a sale does not create a duplicate row

---

# Phase 8 — Claude Report

### Per-trade additions

- `Engine Source: EDGE | WARRIOR`
- `Minutes late at entry: N` (Warrior only)
- `Setups matched: [primary, …]` (Warrior only)
- Full gate result at purchase (all five pillars with their values)

### Per-engine statistics — gate them behind a minimum n

The report's explicit purpose is to rewrite your scoring rules, and it will run on n≈5 Warrior trades for weeks.

Your June report already shows the failure mode: signal score 80–100 won 50% of the time while score 20–49 won 75% (n=11). That inversion is noise. Nobody should retune a system on it.

- Render *"insufficient data (n=6)"* for any per-engine or per-setup breakdown below **n=20**
- Report **expectancy and average R** alongside win rate. The two engines have deliberately different R profiles, so win rate alone is not comparable across them.
- Include a **latency breakdown** for Warrior trades: outcomes bucketed by `minutesLate` (0–5, 5–20, 20+). This is what separates "the setup doesn't work" from "we're always late."

### Generation

Each engine produces its own stats block via `summarizeForReport(trades)` from the registry. **Report code in `shell/` never contains engine-specific field names.** If the Warrior engine isn't loaded, its block is replaced by a note and its trades are excluded from per-engine sections.

### Phase 8 acceptance

- [ ] Report generates correctly with zero Warrior trades
- [ ] Per-engine sections show the insufficient-data note below n=20
- [ ] Latency breakdown present
- [ ] `grep` for setup names in `shell/report.js` returns nothing

---

# Out of scope for this spec

- **Push notifications** — the real fix for the latency problem in Phase 5, and now cheaper than it looks because the Supabase migration provides the server. Separate doc.
- **Warrior Trading's paid scanner, chat room, and exact execution rules** — proprietary and paywalled; not replicable at any scope.
- **Automated order placement** — unchanged from the v3 spec; the app never trades.

---

# Known open items (deferred, not yet scheduled)

- **Chart X-axis labels render in browser-local time, not PT** (`app.js:3503-3510`). Every other timestamp in the app is PT; this is the one place that isn't. Found during the 2026-08-26 timezone sweep (prompted by two real getPT()/local-time-mixing bugs found the same day — see CLAUDE.md's rule on `.setHours()`/`.setDate()` on a `getPT()`-derived Date). Not fixed: it's a display-only inconsistency, not a wrong-answer bug like the other two, and no phase currently touches that code path. Revisit if a phase ends up in `app.js`'s charting code anyway, or if it's reported as confusing.
- **`state.settings.showWatch` is functionally dead.** Found during the 2026-08-28 settings-schema sweep (prompted by `developerTools` silently failing to persist — see that finding elsewhere in this doc). Unlike `developerTools`, this one has full Supabase plumbing: the `show_watch` column exists, both `loadSettingsFromSupabase` and `saveSettingsToSupabase` wire it correctly. But nothing in the app ever *sets* it to anything but its `true` default — no checkbox, no `savePref('showWatch', ...)` call anywhere. It's only ever read once, in the Claude Report's configuration block (`Show WATCH signals: ...`), where it's presented as a live setting despite never having varied. Same category as `developerTools`/`riskPerTradePct` ("a `state.settings` field that isn't trustworthy"), but it fails by never varying rather than by never saving. Not fixed here — recorded so a future reading of that report doesn't reason about this value as if it reflects a real user choice.

---

# Context note: the PDT rule no longer applies

The SEC approved eliminating the pattern day trader designation, effective **June 4, 2026**. The $25,000 minimum equity requirement is replaced by broker-set intraday margin buying power for accounts above $2,000, and day trades are no longer counted.

Under the old rule a same-day-exit engine on a $500 account would have been capped at 3 day trades per rolling 5 business days, which would have made most of this unbuildable. Confirm where Robinhood is in its implementation (brokers have until October 2027, though most moved early), but the structural blocker is gone.

---

# Full phase checklist

| Phase | Deliverable | Blocking? |
|---|---|---|
| 0 | `core/` extraction — **move-only**, no new logic | Yes — nothing after this is truly isolated without it |
| 0.6 | Bars pagination + news endpoint — two confirmed live bugs. **Runs before 0.5** | Yes — changes what the app recommends; no point widening the funnel while 97% is discarded |
| 0.5 | Shared rate-limit queue in `api-client.js` | Yes — must land before Phase 1's burst traffic |
| 1 | `core/universe.js` — movers, most-actives, pre-market gap scan | Yes — the method doesn't work without it |
| 2 | Warrior scaffold, engine registry, graceful degradation, nav | Yes |
| 3 | 5 Pillars gate (1–4), SIP feed, near-miss tier, halt check | Yes |
| 4 | Replay harness | Strongly recommended before Phase 5 |
| 5 | Setup detection, Warrior entry/target/stop, position sizing | |
| 6 | FMP float → Pillar 5 | |
| 7 | Portfolio/Sold integration — with the Supabase schema change | |
| 8 | Claude Report changes | |

---

## Reference links

- [Alpaca — About Market Data API](https://docs.alpaca.markets/us/docs/about-market-data-api)
- [Alpaca — Top market movers](https://docs.alpaca.markets/reference/movers-1)
- [Alpaca — Most active stocks](https://docs.alpaca.markets/reference/mostactives-1)
- [Warrior Trading — Day Trading Scanners](https://www.warriortrading.com/day-trading-scanners/)
- [FMP — Share float on the free tier](https://site.financialmodelingprep.com/how-to/how-to-retrieve-company-share-float-data-using-a-free-api)
- [Schwab — SEC approves scrapping the $25,000 day trader minimum](https://www.schwab.com/learn/story/sec-approves-scrapping-25000-day-trader-minimum)
