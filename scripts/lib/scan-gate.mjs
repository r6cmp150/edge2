// Scheduled-scan gate shared by log-signals-edge.mjs and
// log-signals-warrior.mjs (2026-10-09). Replaces both loggers' fixed-
// target windows (EDGE: open+30/open+140/close-45; Warrior: open+20/
// open+105/close-60, +-10 min, plus Warrior's once-per-target dedup).
//
// WHY THE WINDOWS WENT: GitHub delivers these crons 2.5-7h late (measured
// 2026-10-09 from every run's declared_cron, Sep 15-Oct 8). A ±10-minute
// window around an intended moment almost never contains a delivery, so
// nearly every firing no-op'd with exit 0 -- silently. EDGE had NO
// scan_runs row on 10 of 20 trading days; open+30 and open+140 never fired
// once; Warrior logged 4 scans in three weeks. A scan at a recorded,
// irregular time is data; a no-op is nothing.
//
// THE RULE NOW: a scheduled firing scans iff
//   1. the regular session is open right now (classifySession === 'REGULAR'
//      -- holiday- and early-close-aware, unlike getMarketStatus's fixed
//      1:00pm close), and
//   2. this engine has no scan_runs row started in the last SPACING_MIN
//      minutes. Deliveries arrive bunched 20-40 min apart; without this, one
//      late cluster becomes five scans in an hour.
// The previous windows also absorbed the wrong-season half of each DST-
// paired cron entry; under this rule an off-season firing is just another
// scan if it lands in session (spacing still applies), or a no-op if not.
//
// SAMPLING CONSEQUENCE -- READ BEFORE AGGREGATING: scan time is now
// irregular and varies by day. signal_log keeps the EARLIEST sighting per
// (signal_date, symbol, engine_source, tier), so a later scan only adds
// symbols/tiers not already seen that day. minutes-since-open is derivable
// per row from first_shown_at (no column). See docs/phase-8-report-spec.md
// "Time-of-day bucketing" before pooling any results across a session.

export const SPACING_MIN = 30;

export function minutesSinceOpenPT(pt) {
  return pt.getHours() * 60 + pt.getMinutes() - 390; // 390 = 6:30am PT = 9:30am ET
}

// Pure decision, no I/O -- recentStartedAts is every started_at (ISO) of
// this engine's scan_runs rows for today.
export function decideScheduledScan({ dateStr, hhmm, sessionClass, nowMs, recentStartedAts, spacingMin = SPACING_MIN }) {
  if (sessionClass !== 'REGULAR') {
    return { proceed: false, reason: `scheduled firing at ${dateStr} ${hhmm} PT is outside the regular session (${sessionClass})` };
  }
  const tooClose = recentStartedAts
    .map(iso => (nowMs - new Date(iso).getTime()) / 60000)
    .filter(ageMin => ageMin >= 0 && ageMin < spacingMin);
  if (tooClose.length) {
    return { proceed: false, reason: `an earlier scan_runs row today started ${Math.round(Math.min(...tooClose))} min ago (< ${spacingMin}-min spacing)` };
  }
  return { proceed: true, reason: null };
}

// I/O wrapper used by both loggers. A failed Supabase read THROWS -- it
// never degrades into "no recent scans, proceed" or "assume recent, skip".
export async function scheduledScanGate({ engineSource, getPT, ptDateStr, classifySession, supabaseUrl, anonKey }) {
  const pt = getPT();
  const dateStr = ptDateStr(pt);
  const hhmm = `${String(pt.getHours()).padStart(2, '0')}:${String(pt.getMinutes()).padStart(2, '0')}`;
  const sessionClass = classifySession(dateStr, hhmm);
  const minutesSinceOpen = minutesSinceOpenPT(pt);
  let recentStartedAts = [];
  if (sessionClass === 'REGULAR') {
    const res = await fetch(`${supabaseUrl}/rest/v1/scan_runs?engine_source=eq.${engineSource}&scan_date=eq.${dateStr}&select=started_at`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (res.status >= 300) throw new Error(`scan gate: could not read today's ${engineSource} scan_runs: ${res.status} ${await res.text()}`);
    recentStartedAts = (await res.json()).map(r => r.started_at);
  }
  const decision = decideScheduledScan({ dateStr, hhmm, sessionClass, nowMs: Date.now(), recentStartedAts });
  return { ...decision, minutesSinceOpen, hhmm, dateStr };
}
