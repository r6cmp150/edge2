#!/usr/bin/env node
// One-off runner for core/universe.js's reconstructTopMoversUniverse
// against the REAL Alpaca account — not a permanent script, just the
// vehicle for the 2026-09-01 "report the resulting symbol-day list size
// before running the replay half" checkpoint. Loads core/universe.js as
// a classic script (same eval-with-mocked-globals shape tests/_lib.js
// uses), but with a REAL client.alpacaGet hitting the real API instead
// of a mock. Key is read from .env.local and passed only into fetch
// headers — never logged, echoed, or written to any output here.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2];
  }
  if (!kv.APCA_API_KEY_ID || !kv.APCA_API_SECRET_KEY) throw new Error('.env.local missing APCA_API_KEY_ID/APCA_API_SECRET_KEY');
  return { alpacaKeyId: kv.APCA_API_KEY_ID, alpacaSecretKey: kv.APCA_API_SECRET_KEY };
}

async function main() {
  const { alpacaKeyId, alpacaSecretKey } = readEnvLocal();

  global.state = {};
  global.persist = () => {};
  global.chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
  global._coreClient = {
    alpacaGet: async (urlPath, params = {}, base = 'https://data.alpaca.markets/v2') => {
      const url = new URL(base + urlPath);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': alpacaKeyId, 'APCA-API-SECRET-KEY': alpacaSecretKey } });
      if (!res.ok) throw new Error(`${urlPath}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      return res.json();
    },
  };

  const src = readFileSync(path.join(REPO_ROOT, 'core', 'universe.js'), 'utf8');
  const exposeStatements = 'global.reconstructTopMoversUniverse = reconstructTopMoversUniverse;';
  eval(src + '\n' + exposeStatements);

  const t0 = Date.now();
  const result = await global.reconstructTopMoversUniverse({
    startDateStr: '2026-06-01',
    endDateStr: '2026-08-28',
    topN: 10,
    client: global._coreClient,
  });
  const elapsedSec = Math.round((Date.now() - t0) / 1000);

  console.log(`[run-universe-reconstruction] label: ${result.label}`);
  console.log(`[run-universe-reconstruction] eligibleSymbolCount=${result.eligibleSymbolCount} symbolsWithBars=${result.symbolsWithBars} requests=${result.requests} elapsedSec=${elapsedSec}`);
  console.log(`[run-universe-reconstruction] symbol-day list size: ${result.symbolDays.length}`);

  const byDate = {};
  for (const row of result.symbolDays) (byDate[row.date] = byDate[row.date] || []).push(row.symbol);
  const dates = Object.keys(byDate).sort();
  console.log(`[run-universe-reconstruction] trading days covered: ${dates.length} (${dates[0]} .. ${dates[dates.length - 1]})`);
  const counts = dates.map(d => byDate[d].length);
  console.log(`[run-universe-reconstruction] symbols/day: min=${Math.min(...counts)} max=${Math.max(...counts)} mean=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)}`);

  const outPath = path.join(REPO_ROOT, 'artifacts_universe_reconstruction.json');
  const fs = await import('node:fs');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`[run-universe-reconstruction] full result written to ${outPath}`);
}

main().catch((err) => {
  console.error('[run-universe-reconstruction] FAILED —', err.message);
  process.exit(1);
});
