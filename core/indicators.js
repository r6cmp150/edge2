// core/indicators.js — owned by neither engine. core/ never imports from engines/.
// Pure technical-indicator functions (RSI, ATR, moving average, volume avg) — no state.
// Moved from app.js's "── 8. TECHNICAL INDICATORS ───" section (Phase 0 extraction).

function calcRSI(closes) {
  if (closes.length < 15) return 50;
  const last15 = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < 15; i++) {
    const d = last15[i] - last15[i-1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcATR(bars) {
  if (bars.length < 15) return 0;
  const last15 = bars.slice(-15);
  let sum = 0;
  for (let i = 1; i < 15; i++) {
    const b = last15[i], prev = last15[i-1];
    const tr = Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
    sum += tr;
  }
  return sum / 14;
}

// Trimmed ATR — drops the single highest True Range day before averaging, so one
// spike (FDA news, short squeeze) doesn't inflate the target/stop for the next 14 days.
// Used ONLY for target/stop (calcEntryTargetStop). Risk Score keeps using calcATR (untrimmed).
function calcTrimmedATR(bars) {
  if (bars.length < 15) return 0;
  const last15 = bars.slice(-15);
  const trueRanges = [];
  for (let i = 1; i < 15; i++) {
    const b = last15[i], prev = last15[i-1];
    trueRanges.push(Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)));
  }
  const sorted = [...trueRanges].sort((a, b) => a - b);
  return sorted.slice(0, 13).reduce((sum, x) => sum + x, 0) / 13;
}

function calcMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1] || 0;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcAvgVolume(volumes, days) {
  if (!volumes.length) return 0;
  const slice = volumes.slice(-Math.min(days, volumes.length));
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}
