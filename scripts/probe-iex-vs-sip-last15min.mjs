#!/usr/bin/env node
// Phase 9 display-copy follow-up (Roman, 2026-09-15): the session-high
// probe (probe-iex-vs-sip-session-high.mjs) measured IEX vs SIP over a
// WHOLE session. It does not answer the actual question State 3 of the
// intraday-panel design depends on: how far apart are IEX and SIP
// specifically over the LAST 15 MINUTES of a session -- the one window
// where the render-time design (§2.0) would show IEX because SIP's
// recency embargo makes SIP unavailable live.
//
// Can't measure this live (that's the whole reason for the embargo), but
// CAN measure it on closed historical sessions, where SIP for that same
// final-15-minute window is now freely available (no longer inside the
// embargo). Real thin $1-$20 names, same list as the session-high probe.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) kv[m[1]] = m[2]; }
  return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
}
const { alpacaKeyId, alpacaSecretKey } = readEnvLocal();
const headers = { 'APCA-API-KEY-ID': alpacaKeyId, 'APCA-API-SECRET-KEY': alpacaSecretKey };
const BASE = 'https://data.alpaca.markets/v2';

// Last 15 minutes of the regular session, in UTC, for the EDT dates used
// here (all Aug/Sep 2026 -- still EDT, DST doesn't end until November):
// 19:45:00 -> 20:00:00 UTC = 15:45 -> 16:00 ET.
async function last15MinHigh(symbol, date, feed) {
  const res = await fetch(`${BASE}/stocks/${symbol}/bars?timeframe=1Min&start=${date}T19:45:00Z&end=${date}T20:00:00Z&limit=100&feed=${feed}&adjustment=all`, { headers });
  const j = await res.json();
  const bars = j.bars || [];
  if (!bars.length) return { high: null, barCount: 0 };
  return { high: Math.max(...bars.map(b => b.h)), barCount: bars.length };
}

// Same real $1-$20 names/dates as probe-iex-vs-sip-session-high.mjs.
const CASES = [
  ['DAMD', '2026-09-03'],
  ['DJT', '2026-08-28'],
  ['PGEN', '2026-08-27'],
  ['TENX', '2026-08-26'],
  ['KEEL', '2026-08-18'],
  ['NEOG', '2026-08-20'],
  ['BTDR', '2026-08-18'],
];

async function main() {
  console.log('symbol,date,iex_high,iex_bars,sip_high,sip_bars,diff_pct');
  const results = [];
  for (const [symbol, date] of CASES) {
    const [iex, sip] = await Promise.all([last15MinHigh(symbol, date, 'iex'), last15MinHigh(symbol, date, 'sip')]);
    const diffPct = (iex.high != null && sip.high != null && sip.high > 0)
      ? ((iex.high - sip.high) / sip.high) * 100
      : null;
    results.push({ symbol, date, iex, sip, diffPct });
    console.log(`${symbol},${date},${iex.high},${iex.barCount},${sip.high},${sip.barCount},${diffPct?.toFixed(2)}`);
  }
  const withDiff = results.filter(r => r.diffPct != null);
  const missingIex = results.filter(r => r.iex.high == null);
  const missingSip = results.filter(r => r.sip.high == null);
  const absDiffs = withDiff.map(r => Math.abs(r.diffPct));
  console.log('\n=== Summary (last 15 minutes of session only) ===');
  console.log(`cases with both feeds returning data: ${withDiff.length}/${CASES.length}`);
  if (missingIex.length) console.log(`IEX returned NO bars in the last-15-min window for: ${missingIex.map(r => `${r.symbol}/${r.date}`).join(', ')}`);
  if (missingSip.length) console.log(`SIP returned NO bars in the last-15-min window for: ${missingSip.map(r => `${r.symbol}/${r.date}`).join(', ')}`);
  if (absDiffs.length) {
    console.log(`|diff| min=${Math.min(...absDiffs).toFixed(2)}%, max=${Math.max(...absDiffs).toFixed(2)}%, mean=${(absDiffs.reduce((a,b)=>a+b,0)/absDiffs.length).toFixed(2)}%`);
    console.log(`cases where IEX high < SIP high (IEX would UNDERSTATE the real last-15-min high): ${withDiff.filter(r => r.diffPct < -0.01).length}/${withDiff.length}`);
  } else {
    console.log('no case had both feeds returning bars -- cannot compute a diff at all.');
  }
}

main().catch((err) => { console.error('[probe] FAILED —', err.message, err.stack); process.exit(1); });
