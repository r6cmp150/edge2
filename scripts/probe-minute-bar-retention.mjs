#!/usr/bin/env node
// Phase 9 §2 architecture question (2026-09-15): if Alpaca's minute bars
// are retrievable for an arbitrary past window on demand, position_bars
// (the table, the capture workflow, the scoped write role, db/023) may
// not need to exist at all -- the app could compute a position's full
// intraday path at RENDER TIME instead of needing something to have been
// watching. This script answers that empirically, not by inference.
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

async function get(pathAndQuery) {
  const res = await fetch(`${BASE}${pathAndQuery}`, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  console.log('=== 1. How far back do IEX minute bars go? ~60 calendar days, real symbol (BITO) ===');
  const start60 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const end60 = new Date(Date.now() - 58 * 86400000).toISOString().slice(0, 10); // 2-day window, plenty of minutes to inspect
  {
    const r = await get(`/stocks/BITO/bars?timeframe=1Min&start=${start60}T00:00:00Z&end=${end60}T23:59:59Z&limit=10000&feed=iex&adjustment=all`);
    console.log(`status=${r.status}, bars returned=${r.json?.bars?.length ?? 'N/A'}`);
    if (r.json?.bars?.length) {
      console.log('first bar:', JSON.stringify(r.json.bars[0]));
      console.log('last bar:', JSON.stringify(r.json.bars[r.json.bars.length - 1]));
    } else {
      console.log('full response:', r.text.slice(0, 500));
    }
  }

  console.log('\n=== 1b. Same window, feed=sip (for comparison -- is IEX materially different from SIP historically) ===');
  {
    const r = await get(`/stocks/BITO/bars?timeframe=1Min&start=${start60}T00:00:00Z&end=${end60}T23:59:59Z&limit=10000&feed=sip&adjustment=all`);
    console.log(`status=${r.status}, bars returned=${r.json?.bars?.length ?? 'N/A'}`);
    if (r.status >= 300) console.log('body:', r.text.slice(0, 300));
  }

  console.log('\n=== 2a. Weekend/holiday boundary -- window spanning a real weekend ===');
  // Find the most recent Friday->Monday boundary before today for a clean test.
  const now = new Date();
  const dow = now.getUTCDay(); // 0=Sun
  const daysSinceLastFriday = ((dow + 2) % 7) + 7; // go back to a Friday at least a week ago
  const friday = new Date(now.getTime() - daysSinceLastFriday * 86400000);
  const monday = new Date(friday.getTime() + 3 * 86400000);
  const fridayStr = friday.toISOString().slice(0, 10);
  const mondayStr = monday.toISOString().slice(0, 10);
  {
    const r = await get(`/stocks/BITO/bars?timeframe=1Min&start=${fridayStr}T00:00:00Z&end=${mondayStr}T23:59:59Z&limit=10000&feed=iex&adjustment=all`);
    const bars = r.json?.bars || [];
    console.log(`window ${fridayStr} -> ${mondayStr}, status=${r.status}, bars=${bars.length}`);
    const dates = [...new Set(bars.map(b => b.t.slice(0, 10)))];
    console.log('distinct trading dates present:', dates);
  }

  console.log('\n=== 2b. Thin-volume symbol -- missing minutes expected, not interpolated ===');
  // A known thin/microcap name from tonight's trade set.
  {
    const r = await get(`/stocks/RSLS/bars?timeframe=1Min&start=${start60}T00:00:00Z&end=${end60}T23:59:59Z&limit=10000&feed=iex&adjustment=all`);
    const bars = r.json?.bars || [];
    console.log(`RSLS status=${r.status}, bars=${bars.length} over a 2-day/~780-min regular-session window (390min/day x2=780 if fully populated)`);
    if (bars.length) console.log('sample bars:', JSON.stringify(bars.slice(0, 3)), '...', JSON.stringify(bars.slice(-3)));
  }

  console.log('\n=== 3. Recency embargo -- how close to "now" can a minute-bar request reach? ===');
  const nowIso = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
  const twentyMinAgo = new Date(Date.now() - 20 * 60000).toISOString();
  for (const [label, endTime] of [['end=now', nowIso], ['end=5 min ago', fiveMinAgo], ['end=20 min ago', twentyMinAgo]]) {
    const startTime = new Date(Date.now() - 60 * 60000).toISOString();
    const r = await get(`/stocks/BITO/bars?timeframe=1Min&start=${startTime}&end=${endTime}&limit=1000&feed=iex&adjustment=all`);
    console.log(`${label}: status=${r.status}${r.status >= 300 ? ', body=' + r.text.slice(0, 200) : ', bars=' + (r.json?.bars?.length ?? 0)}`);
  }

  console.log('\n=== 4. Cost estimate: multi-symbol single request, 5 symbols x how many days ===');
  const symbols = ['BITO', 'TENX', 'KEEL', 'BTDR', 'NEOG'];
  for (const days of [1, 5, 20]) {
    const startD = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const t0 = Date.now();
    const r = await fetch(`${BASE}/stocks/bars?symbols=${symbols.join(',')}&timeframe=1Min&start=${startD}T00:00:00Z&limit=10000&feed=iex&adjustment=all`, { headers });
    const json = await r.json();
    const elapsed = Date.now() - t0;
    const totalBars = Object.values(json.bars || {}).reduce((s, arr) => s + arr.length, 0);
    console.log(`${days}-day window, 5 symbols, 1 request: status=${r.status}, total bars=${totalBars}, next_page_token=${json.next_page_token ?? 'null'}, ${elapsed}ms`);
  }
}

main().catch((err) => { console.error('[probe] FAILED —', err.message, err.stack); process.exit(1); });
