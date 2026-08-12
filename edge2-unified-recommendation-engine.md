# EDGE2 — Feature Requirements: Unified Recommendation Engine
### (For Claude Code — implement after EDGE2 initial release)
### Replaces the current sell warning system entirely

---

## Why This Feature Exists

The current sell warning system (SELL NOW / SELL SOON / HOLD) fires 
individual trip wires independently — stop-loss proximity, % loss, 
duration, RSI — with no awareness of each other or the broader context 
of the stock. This creates contradictions like SELL NOW showing on a 
stock with a current score of 69, or SELL SOON firing because of RSI 
while macro conditions are strongly bullish.

The goal of this feature is to replace disconnected rules with a single 
unified judgment that weighs ALL available information simultaneously — 
price action, technical signals, macro context, position specifics, and 
intended hold duration — and produces one transparent, explainable 
recommendation with visible reasoning.

---

## Architecture Overview

The unified engine works in four steps:

1. Evaluate every applicable factor and assign it a point value on a 
   −100 to +100 scale
2. Sum all factors into a single composite score
3. Map the composite score to a recommendation label
4. Display the recommendation with the top contributing factors visible

This replaces getPortfolioTier(), calcSellWarning(), and 
buildPortfolioBanner() with a single function: calcUnifiedRecommendation()

---

## STEP 1: Factor Scoring Table

### Exit Pressure Factors (negative — push toward selling)

| Factor | Condition | Points |
|--------|-----------|--------|
| Stop-loss breach | Price at or below stop-loss price | HARD FLOOR — always SELL NOW, bypasses composite |
| Severe loss | Down 20%+ from purchase price | −60 |
| Significant loss | Down 8–20% from purchase price | −30 |
| Trailing stop hit | Pulled back 20%+ from peak price (momentum protection) | −50 |
| Trailing stop warning | Pulled back 15–20% from peak price | −25 |
| Severely overdue | Past max duration by 3+ days | −50 |
| Overdue | Past max duration by 1–2 days | −25 |
| Overbought RSI | RSI above 75 | −25 |
| Elevated RSI | RSI 65–75 | −10 |
| Weak current score | Current signal score below 30 | −25 |
| Low current score | Current signal score 30–49 | −10 |
| Score deteriorating | Score now more than 20pts below score at purchase | −15 |
| Macro headwind | RISK_OFF or GEOPOLITICAL condition | −20 |
| Sector weakness | SECTOR_WEAKNESS condition for this stock's category | −15 |
| Volume fading | Volume ratio below 0.5x (liquidity drying up) | −10 |
| Below 20-day MA | Price currently below 20-day moving average | −10 |

### Hold/Buy Pressure Factors (positive — push toward holding)

| Factor | Condition | Points |
|--------|-----------|--------|
| High current score | Current signal score above 80 | +50 |
| Good current score | Current signal score 65–80 | +30 |
| Moderate current score | Current signal score 50–65 | +15 |
| Score improving | Score now higher than score at purchase | +20 |
| RSI sweet spot | RSI 55–65 (historically best bucket) | +20 |
| RSI neutral-bullish | RSI 35–55 | +15 |
| Healthy volume | Volume ratio 1.0–2.0x | +15 |
| Quiet accumulation | Volume ratio 0.5–1.0x | +10 |
| Above 20-day MA | Price currently above 20-day MA | +15 |
| Within duration window | Days held still within intended max | +20 |
| Early in window | Days held less than half of max duration | +10 |
| Macro tailwind | BROAD_RALLY or MOMENTUM_DAY condition | +20 |
| Catalyst setup | CATALYST_SETUP flag active on current scan | +20 |
| Momentum protected | Momentum protection active AND above trailing stop | +30 |
| Near target | Within 10% of target price and profitable | +15 |
| Price tier premium | Stock in $10–$20 tier (historically best win rate) | +10 |

---

## STEP 2: Composite Score Calculation

```
compositeScore = sum of all applicable factor points

Notes:
- A stock can score multiple factors simultaneously — they all apply
- The composite can range roughly from −250 to +230 in extreme cases
- The stop-loss hard floor bypasses the composite entirely — it is 
  checked first before any factor calculation
- Momentum protection trailing stop factors replace the standard 
  loss % factors when momentum protection is active — do not 
  double-count both
```

---

## STEP 3: Recommendation Mapping

| Composite Score | Recommendation | Banner Color |
|----------------|----------------|--------------|
| Stop-loss breached | SELL NOW — Stop-loss hit | Red (hard floor) |
| Below −60 | SELL NOW | Red |
| −60 to −30 | SELL SOON | Yellow-red |
| −30 to −10 | CONSIDER SELLING | Yellow |
| −10 to +10 | HOLD — Mixed signals | Gray/neutral |
| +10 to +30 | HOLD | Green-gray |
| +30 to +60 | HOLD STRONG | Green |
| Above +60 | HIGH CONVICTION HOLD | Bright green |

Note: "CONSIDER SELLING" is a new label that does not exist in the 
current system. It fills the gap between HOLD and SELL SOON for 
genuinely ambiguous situations where the composite is mildly negative 
but not decisively so.

---

## STEP 4: Display Requirements

### Portfolio Card Banner

Replace the current single-line banner with a two-part display:

**Line 1 — Recommendation label:**
```
SELL SOON
```
Styled with the color from the mapping table above.

**Line 2 — Top factors (show the 2–3 highest absolute-value factors):**
```
↓ Down 22% from purchase  (−30)
↓ Past intended hold window  (−25)
↑ Current score 69 — support signal  (+30)
Net: −25
```

Show downward arrows (↓) for negative factors in red/yellow.
Show upward arrows (↑) for positive factors in green.
Show the net composite score at the end.

If the composite is within ±10 (genuinely mixed), add:
```
Signals are conflicted — Groq analysis recommended
```

### Stock Detail Modal

In the Signal Breakdown section, add a RECOMMENDATION block 
above the existing signal rows:

```
UNIFIED RECOMMENDATION
━━━━━━━━━━━━━━━━━━━━━
HOLD STRONG  (+42 composite)

Factors for holding:
  ↑ Score improved from 55 → 69  (+20)
  ↑ Within intended 5-7 day window  (+20)
  ↑ Macro: BROAD_RALLY  (+20)
  ↑ Healthy volume 1.4x  (+15)

Factors for selling:
  ↓ Down 18% from purchase  (−30)
  ↓ RSI elevated at 67  (−10)
━━━━━━━━━━━━━━━━━━━━━
```

Show all factors, not just the top 2-3, in the modal view since 
there is more screen space available.

---

## Integration with Groq

The unified recommendation composite score and top factors should be 
passed to the Groq prompt for owned stocks (buildAIPrompt) so Groq 
is aware of the app's holistic judgment, not just individual signals.

Add to the Groq prompt data block:

```
Unified recommendation: {LABEL} (composite score: {N})
Top exit factors: {list top 2 negative factors}
Top hold factors: {list top 2 positive factors}
```

This gives Groq full context for its probability assessment rather 
than requiring it to independently re-derive the same judgment from 
raw signals.

---

## What This Replaces

The following functions should be replaced by calcUnifiedRecommendation():

- getPortfolioTier() — currently drives Portfolio card banner
- calcSellWarning() — currently drives Signals tab exit alerts, 
  nav badge count, and sellWarningAtSale in trade records
- buildPortfolioBanner() — currently builds the banner HTML

The nav badge count should use the new recommendation labels:
- SELL NOW → counts toward badge
- SELL SOON → counts toward badge
- CONSIDER SELLING → counts toward badge (new)
- HOLD and above → does not count

---

## What This Does NOT Change

- The scoring formula (scoreStock()) — untouched
- Target price and stop-loss calculation — untouched
- ATR, RSI, volume calculations — untouched
- Momentum protection activation logic — untouched
- The stop-loss price itself — untouched
- Trade duration classification — untouched
- Groq prompt structure — extended, not replaced

---

## Claude Report Updates

Add a new section to the Generate Claude Report:

```
=== UNIFIED RECOMMENDATION AT TIME OF SALE ===

Distribution of recommendations at time of sale:
  SELL NOW:           {N} trades | avg outcome {X}%
  SELL SOON:          {N} trades | avg outcome {X}%
  CONSIDER SELLING:   {N} trades | avg outcome {X}%
  HOLD:               {N} trades | avg outcome {X}%
  HOLD STRONG:        {N} trades | avg outcome {X}%
  HIGH CONVICTION:    {N} trades | avg outcome {X}%

Top factors that appeared most in SELL NOW recommendations:
  1. {factor name}: appeared in {N} SELL NOW cases
  2. {factor name}: appeared in {N} SELL NOW cases
  3. {factor name}: appeared in {N} SELL NOW cases

Top factors that appeared most in HIGH CONVICTION HOLD:
  1. {factor name}: appeared in {N} cases
  2. {factor name}: appeared in {N} cases
```

Store on each sold trade record:
- unifiedRecommendationAtSale: the label
- unifiedCompositeAtSale: the numeric score
- topExitFactorsAtSale: array of top 2 negative factor names
- topHoldFactorsAtSale: array of top 2 positive factor names

---

## Implementation Notes for Claude Code

1. Build calcUnifiedRecommendation(position, currentSignal, macroContext) 
   as a pure function that takes a portfolio position object, the current 
   signal data for that ticker (from state.signals or state.ownedScores), 
   and the macro context, and returns:
   { label, composite, factors, topFactors }

2. The function must gracefully handle missing data — if currentSignal 
   is null (stock not in last scan), skip all signal-dependent factors 
   and calculate from position data only

3. Implement calcUnifiedRecommendation() first as a standalone function 
   and test it with mock data before wiring it into the UI

4. Replace getPortfolioTier() and calcSellWarning() call sites one at 
   a time, verifying the UI looks correct at each step

5. The hard floor stop-loss check must be the very first thing evaluated 
   before any factor scoring — implement as an early return

6. This is a significant behavioral change — implement behind a Settings 
   toggle "Use unified recommendations (beta)" that defaults to OFF, 
   allowing Roman to test it alongside the old system before fully 
   switching over

7. Run in parallel mode for at least 2 weeks before removing the old 
   system — the toggle lets Roman compare old vs new recommendations 
   on the same positions

---

## Version Note

This is a post-launch EDGE2 feature. Implement only after EDGE2 v2.0.0 
is live and stable. This feature alone warrants a minor version bump 
to v2.1.0 given the scope of the change.
