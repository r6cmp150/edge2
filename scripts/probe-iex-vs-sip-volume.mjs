// scripts/probe-iex-vs-sip-volume.mjs -- how much of a stock's volume the
// IEX feed sees (2026-10-22, phase-10 spec §7.3 confound on §3.4).
//
//   node scripts/probe-iex-vs-sip-volume.mjs [YYYY-MM-DD] [SYM,SYM,...]
//
// The EDGE pre-filter (app.js runScreener; scripts/log-signals-edge.mjs)
// tests "volume so far today >= 100,000" against a /stocks/snapshots
// dailyBar fetched with feed:'iex' (core/market-data.js fetchSnapshots).
// IEX is one venue, so that's IEX volume, not the consolidated tape.
// This compares a completed day's daily-bar volume on both feeds (SIP is
// readable for days past its 15-minute embargo) and prints each symbol's
// IEX share, and which symbols clear 100k on the consolidated tape but not
// on IEX: real, liquid names the filter drops because of the feed.
// Read-only Alpaca requests: two.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const DATE = process.argv[2] || '2026-10-21';
const SYMBOLS = process.argv[3] || 'ACNT,ALOY,SOUN,RR,TDAY,GO,CXM,HTZ,VISN,GPGI,KEEL,PGEN,BTDR,TENX,NUVB';
const THRESHOLD = 100000;

async function dayBars(feed) {
  const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${SYMBOLS}&timeframe=1Day&start=${DATE}&end=${DATE}&feed=${feed}&limit=1000`;
  const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': env.APCA_API_KEY_ID, 'APCA-API-SECRET-KEY': env.APCA_API_SECRET_KEY } });
  const body = await res.json();
  if (!res.ok || !body.bars) throw new Error(`${feed}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  return body.bars;
}

const [iex, sip] = await Promise.all([dayBars('iex'), dayBars('sip')]);
const rows = Object.keys(sip).map(s => [s, iex[s]?.[0]?.v, sip[s]?.[0]?.v]).filter(([, a, b]) => a != null && b).map(([s, a, b]) => [s, a, b, a / b]);
if (!rows.length) { console.error('FAILED: no symbol has a bar on both feeds for', DATE); process.exit(1); }
rows.sort((x, y) => x[3] - y[3]);
console.log(`${DATE} full-day volume, IEX vs SIP (consolidated):`);
for (const [s, a, b, r] of rows) {
  console.log(`  ${s.padEnd(6)} IEX ${String(a).padStart(10)} | SIP ${String(b).padStart(11)} | IEX share ${(r * 100).toFixed(1).padStart(5)}% | clears ${THRESHOLD / 1000}k: IEX ${String(a >= THRESHOLD).padEnd(5)} SIP ${b >= THRESHOLD}`);
}
const shares = rows.map(r => r[3]).sort((x, y) => x - y);
const median = shares[Math.floor(shares.length / 2)];
console.log(`\n${rows.length} symbols: median IEX share ${(median * 100).toFixed(1)}%, range ${(shares[0] * 100).toFixed(1)}%..${(shares[shares.length - 1] * 100).toFixed(1)}%`);
console.log(`so ${THRESHOLD.toLocaleString()} IEX shares ~ ${Math.round(THRESHOLD / median).toLocaleString()} consolidated at the median IEX share`);
console.log(`clear ${THRESHOLD / 1000}k on SIP but not on IEX: ${rows.filter(r => r[2] >= THRESHOLD && r[1] < THRESHOLD).map(r => r[0]).join(', ') || 'none'}`);
