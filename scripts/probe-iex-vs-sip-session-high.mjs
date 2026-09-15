#!/usr/bin/env node
// Phase 9 §2.0 follow-up (Roman, 2026-09-15): feed choice is an accuracy
// decision, not a plumbing detail. IEX is one venue's volume; SIP is the
// consolidated tape. Quantify the actual session-high divergence on real
// $1-$20 thin names BEFORE deciding whether the UI's "this figure used a
// fallback feed" qualifier should be quiet or loud.
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

async function sessionHigh(symbol, date, feed) {
  const res = await fetch(`${BASE}/stocks/${symbol}/bars?timeframe=1Min&start=${date}T13:30:00Z&end=${date}T20:00:00Z&limit=1000&feed=${feed}&adjustment=all`, { headers });
  const j = await res.json();
  const bars = j.bars || [];
  if (!bars.length) return { high: null, barCount: 0 };
  return { high: Math.max(...bars.map(b => b.h)), barCount: bars.length };
}

// Real $1-$20 names from Roman's own trades, real session dates, all
// confirmed still-active (not delisted -- this is about venue coverage
// on a live name, not the RSLS-class disappearance question).
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
    const [iex, sip] = await Promise.all([sessionHigh(symbol, date, 'iex'), sessionHigh(symbol, date, 'sip')]);
    const diffPct = (iex.high != null && sip.high != null && sip.high > 0)
      ? ((iex.high - sip.high) / sip.high) * 100
      : null;
    results.push({ symbol, date, iex, sip, diffPct });
    console.log(`${symbol},${date},${iex.high},${iex.barCount},${sip.high},${sip.barCount},${diffPct?.toFixed(2)}`);
  }
  const withDiff = results.filter(r => r.diffPct != null);
  const absDiffs = withDiff.map(r => Math.abs(r.diffPct));
  console.log('\n=== Summary ===');
  console.log(`cases with both feeds returning data: ${withDiff.length}/${CASES.length}`);
  console.log(`|diff| min=${Math.min(...absDiffs).toFixed(2)}%, max=${Math.max(...absDiffs).toFixed(2)}%, mean=${(absDiffs.reduce((a,b)=>a+b,0)/absDiffs.length).toFixed(2)}%`);
  console.log(`cases where IEX high < SIP high (IEX would UNDERSTATE the real high Roman could have sold near): ${withDiff.filter(r => r.diffPct < -0.01).length}/${withDiff.length}`);
}

main().catch((err) => { console.error('[probe] FAILED —', err.message, err.stack); process.exit(1); });
