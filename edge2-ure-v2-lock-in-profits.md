# EDGE2 — Feature Requirements: Unified Recommendation Engine v2
### (For Claude Code — implements on top of existing URE in EDGE2)
### Version target: v2.2.0

---

## Why This Update Exists

The Unified Recommendation Engine (v2.1.0) has good coverage for losing 
positions but two gaps:

1. The "when to exit a winner" problem is underweighted — there is no 
   signal that specifically identifies when a profitable position is 
   about to reverse, distinct from the general hold/sell composite
2. The label hierarchy has redundant labels (HIGH CONVICTION HOLD, 
   CONSIDER SELLING, HOLD — Mixed) that create confusion rather than 
   clarity

This update fixes both by consolidating labels and adding a new 
LOCK IN PROFITS signal specifically for winning positions showing 
reversal risk.

---

## CHANGE 1: Label Hierarchy Consolidation

Replace the current 7-tier label system with this cleaner 6-tier system:

| Composite Score | Old Label | New Label |
|----------------|-----------|-----------|
| Stop-loss breach | SELL NOW — Stop-loss hit | SELL NOW — Stop-loss hit (unchanged) |
| Below −60 | SELL NOW | SELL NOW (unchanged) |
| −60 to −30 | SELL SOON | SELL SOON (unchanged) |
| −30 to −10 | CONSIDER SELLING | CONSIDER SELLING (merged) |
| −10 to +10 | HOLD — Mixed signals | CONSIDER SELLING (merged) |
| +10 to +30 | HOLD | HOLD (unchanged) |
| +30 or above, no peak risk | HOLD STRONG | HOLD STRONG (unchanged) |
| +30 or above, peak risk high | (did not exist) | LOCK IN PROFITS (new) |
| Above +60, no peak risk | HIGH CONVICTION HOLD | HOLD STRONG (collapsed) |
| Above +60, peak risk high | (did not exist) | LOCK IN PROFITS (new) |

Key changes:
- HIGH CONVICTION HOLD is removed — composite above +60 with no peak 
  risk now shows as HOLD STRONG
- HOLD — Mixed signals and CONSIDER SELLING are merged into a single 
  CONSIDER SELLING label covering composite −30 to +10
- LOCK IN PROFITS is a new label that replaces HOLD STRONG when the 
  composite is +30 or above AND peak risk indicators cross the threshold

The mixed: true flag (composite within ±10) is no longer needed since 
CONSIDER SELLING now covers that range. Remove the "Signals are 
conflicted — Groq analysis recommended" note — CONSIDER SELLING 
itself communicates the ambiguity.

Update calcUnifiedRecommendation() composite-to-label mapping:
```
if (hardFloor) → SELL NOW — Stop-loss hit
composite < −60 → SELL NOW
composite < −30 → SELL SOON
composite < +10 → CONSIDER SELLING
composite < +30 → HOLD
composite >= +30 AND peakRiskScore <= −40 → LOCK IN PROFITS
composite >= +30 AND peakRiskScore > −40 → HOLD STRONG
```

Note: peakRiskScore is calculated separately from the main composite 
and only evaluated when composite >= +30. See CHANGE 2 for details.

---

## CHANGE 2: LOCK IN PROFITS — Peak Risk Detection

### When It Applies

LOCK IN PROFITS only fires when BOTH conditions are true simultaneously:
1. Main composite score is +30 or above (position is genuinely strong)
2. Peak risk score is −40 or worse (reversal signals are building)

If condition 1 is true but condition 2 is not → HOLD STRONG (keep holding)
If condition 2 fires but condition 1 is not met → falls through normal 
composite path (CONSIDER SELLING or SELL SOON), never LOCK IN PROFITS

LOCK IN PROFITS never appears on a losing position (pnlDollar < 0).
LOCK IN PROFITS never appears when composite is below +30.

### Peak Risk Factor Table

Calculate peakRiskScore as a separate sum using ONLY these factors.
These factors are NOT added to the main composite — they are evaluated
independently after the main composite is determined.

| Factor | Condition | Points |
|--------|-----------|--------|
| RSI turning from high | RSI was above 70 on previous scan and is now lower (declining from peak) | −30 |
| RSI elevated and high | RSI currently above 75 (overbought extreme) | −25 |
| Severe overextension | Price more than 20% above 20-day MA | −25 |
| Moderate overextension | Price 10-20% above 20-day MA | −15 |
| Hard resistance ceiling | Current price within 3% below 52-week high or recent 10-day swing high | −20 |
| Consecutive up days exhaustion | 4 or more consecutive up days | −20 |
| Intraday gain giveup | Today's high was more than 3% above current price (gave back 25%+ of intraday move) — use snap.dailyBar.h vs current price | −25 |
| Volume declining on up day | Today's price is up but volume ratio is below 0.7x (distribution signal) | −15 |
| Profit exceeds 2x target | Current profit % is more than 2× the original target % gain | −15 |
| Well past duration window | Days held more than 3 days past intended max duration while still winning | −20 |

Threshold: if peakRiskScore sum is −40 or worse → LOCK IN PROFITS fires

### RSI Declining From Peak

To detect RSI declining from above 70, the function needs the previous 
RSI value. Use this approach:
- Store the most recent RSI for each owned ticker in 
  state.ownedPrevRSI[ticker] after each portfolio render
- On the next render, compare current RSI to state.ownedPrevRSI[ticker]
- If previous RSI was >70 and current RSI is lower → declining from peak
- If no previous RSI stored → skip this factor (do not assume)
- Update state.ownedPrevRSI[ticker] after evaluation each render

### Display for LOCK IN PROFITS

Portfolio card banner:
```
LOCK IN PROFITS
↑ Up {X}% — strong position
↓ {top negative peak risk factor} ({points})
↓ {second top negative peak risk factor} ({points})
↓ {third top negative peak risk factor} ({points})
This is the exit window — consider selling now
```

- Banner background: deep gold/amber — distinct from both green (hold) 
  and red (sell now). Suggested: #7a5c00 background, #ffd166 text and border
- Show top 3 peak risk factors by magnitude
- The "This is the exit window" line is fixed text, always shown
- Do NOT show the main composite factors on this banner — only the 
  peak risk factors that triggered it

Stock Detail Modal RECOMMENDATION block when LOCK IN PROFITS:
```
LOCK IN PROFITS  (composite +{N}, peak risk {N})

Why the stock is still strong:
  ↑ {positive composite factors, sorted by magnitude}

Why the exit window is closing:
  ↓ {peak risk factors, sorted by magnitude}

Recommendation: The position is strong but reversal signals 
are building. This is the optimal exit zone — selling now 
preserves gains before momentum fades.
```

---

## CHANGE 3: Updated Banner Styling

Add CSS for LOCK IN PROFITS banner — amber/gold color distinct from 
all existing banner colors:

```css
.ur-lock-profits {
  background: rgba(122, 92, 0, 0.3);
  border-left: 3px solid #ffd166;
  color: #ffd166;
}
```

Update the CSS class mapping in buildUnifiedPortfolioBanner():
- Remove: ur-high-conviction class
- Add: ur-lock-profits class for LOCK IN PROFITS label
- HOLD STRONG inherits ur-high-conviction styling (reuse, just 
  remove the separate HIGH CONVICTION HOLD mapping)

---

## CHANGE 4: Groq Prompt Update

When LOCK IN PROFITS is the recommendation, update the Groq context 
block for owned stocks to include peak risk data:

```
Unified recommendation: LOCK IN PROFITS (composite +{N})
Peak risk score: {N} (threshold: −40)
Top peak risk factors: {list top 3 peak risk factors}
Main composite factors for holding: {top 2 positive factors}

Note: The position is strongly positive on the main composite 
but peak risk indicators suggest the upward momentum is 
exhausting. Groq should weight the exit timing heavily.
```

---

## CHANGE 5: Claude Report Updates

### New Section: Winner Exit Timing Analysis

Add this section to generateClaudeReport() after the existing 
UNIFIED RECOMMENDATION AT TIME OF SALE section:

```
=== WINNER EXIT TIMING ANALYSIS ===

Trades where LOCK IN PROFITS was showing at time of sale:
  Total: {N} | win rate {X}% | avg outcome {X}%
  Avg gain preserved at exit: {X}%

Trades where HOLD STRONG was showing at time of sale:
  Total: {N} | win rate {X}% | avg outcome {X}%
  What-if: avg outcome if held 1 more day: {X}% 
  (based on next day's close vs sale price — requires sell date)

Trades where you held PAST a LOCK IN PROFITS signal:
  (approximated: trades where peak RSI during hold exceeded 70 
   but final outcome was lower than peak unrealized gain)
  Total: {N} | avg gain given back: {X}%

Peak RSI reached during hold vs final outcome:
  Peak RSI <65 during hold:  {N} trades | avg outcome {X}%
  Peak RSI 65-75 during hold: {N} trades | avg outcome {X}%
  Peak RSI 75+ during hold:  {N} trades | avg outcome {X}%

Most common peak risk factors at time of LOCK IN PROFITS exits:
  1. {factor name}: fired in {N} of {N} LOCK IN PROFITS exits
  2. {factor name}: fired in {N} of {N} LOCK IN PROFITS exits
  3. {factor name}: fired in {N} of {N} LOCK IN PROFITS exits
```

### New Fields on Sold Trade Records

Add to confirmMarkSold() and writeTradeToSupabase():

- lockInProfitsFired: boolean — was LOCK IN PROFITS showing at sale
- peakRiskScoreAtSale: integer — the peak risk score at time of sale
- peakRsiDuringHold: numeric — highest RSI recorded in 
  state.ownedPrevRSI during the hold period (track max alongside prev)
- topPeakRiskFactorsAtSale: array of strings — peak risk factor 
  names that fired at time of sale

Add matching columns to Supabase trades table:
```sql
ALTER TABLE trades
  ADD COLUMN lock_in_profits_fired boolean,
  ADD COLUMN peak_risk_score_at_sale integer,
  ADD COLUMN peak_rsi_during_hold numeric,
  ADD COLUMN top_peak_risk_factors_at_sale text[];
```

Show the SQL to Roman to run in Supabase before implementing the 
writeTradeToSupabase() changes.

---

## CHANGE 6: Nav Badge Update

LOCK IN PROFITS should count toward the nav badge (same as SELL SOON) 
since it represents an actionable exit signal. Update the badge count 
logic to include LOCK IN PROFITS alongside SELL NOW, SELL SOON, and 
CONSIDER SELLING.

Remove HIGH CONVICTION HOLD from any badge logic if it exists.

---

## What This Does NOT Change

- scoreStock() scoring formula — untouched
- Target price, stop-loss, ATR calculations — untouched  
- Trade duration classification — untouched
- The Settings toggle behavior — untouched
- The existing composite factor table — untouched (peak risk factors 
  are a separate calculation, not added to the composite)
- Any Signals tab behavior — untouched
- Pre-market analysis — untouched

---

## Implementation Order for Claude Code

1. Update label mapping in calcUnifiedRecommendation() — collapse 
   HIGH CONVICTION HOLD into HOLD STRONG, merge CONSIDER SELLING 
   and HOLD — Mixed (Change 1). Test that existing positions 
   still get correct labels before proceeding.

2. Add state.ownedPrevRSI tracking to renderPortfolioTab() — store 
   and update previous RSI per owned ticker each render (Change 2 
   prerequisite).

3. Build calcPeakRiskScore(position, currentSignal, snap) as a 
   standalone pure function — same pattern as calcUnifiedRecommendation(). 
   Test with mock data: a stock at 52-week high with RSI 76 and 
   4 consecutive up days should score well below −40.

4. Wire LOCK IN PROFITS into calcUnifiedRecommendation() — after 
   composite is determined, if composite >= +30 call calcPeakRiskScore() 
   and apply the label override (Change 2).

5. Update buildUnifiedPortfolioBanner() and modal block for new 
   label and styling (Change 3).

6. Update Groq prompt for LOCK IN PROFITS case (Change 4).

7. Show Supabase SQL, wait for confirmation it ran, then add new 
   fields to sold records and writeTradeToSupabase() (Change 5).

8. Update nav badge to include LOCK IN PROFITS (Change 6).

9. Add Winner Exit Timing Analysis to generateClaudeReport() (Change 5).

Confirm with Roman after each step before proceeding to the next.
Version bump to v2.2.0 when all steps are complete.
