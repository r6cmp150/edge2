#!/usr/bin/env node
// Daily movers/most-actives snapshot capture.
//
// WHY THIS EXISTS (2026-09-01): Alpaca's /screener/stocks/movers and
// /screener/stocks/most-actives are live-snapshot-only endpoints -- no
// historical/date query parameter exists (confirmed: neither
// core/universe.js's real calls nor Alpaca's own docs pass or accept
// one; the endpoint resets at market open and serves *today's* movers
// until then, nothing else). That means Warrior's UNIVERSE SELECTION
// step (which symbols the 'movers' strategy would have surfaced on a
// given morning) can never be backtested -- not expensively, structurally.
// Every classifier fix in this project validates "given this symbol, did
// the setup logic fire correctly" -- none of it validates the pipeline
// that CHOOSES which symbols reach the classifiers in live trading. The
// only way that half ever gets validated is forward, and only from data
// captured starting now: every day this doesn't run is a day of universe
// data that can never be recovered or backfilled.
//
// Append-only (data/movers-snapshots/log.jsonl), one JSON object per
// line, RAW API responses (not the app's own filtered/mapped shape,
// core/universe.js's _getMoversUniverse) -- future analysis needs are
// unknown right now, and a raw capture never forecloses a question a
// pre-filtered one might have. Every row is written, market open or not,
// so a gap in the log is never ambiguous between "job didn't run" and
// "market was closed that day."
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG_PATH = path.join(REPO_ROOT, 'data', 'movers-snapshots', 'log.jsonl');

const ALPACA_TRADING_BASE = 'https://paper-api.alpaca.markets';
const ALPACA_SCREENER_BASE = 'https://data.alpaca.markets/v1beta1';

const ALPACA_KEY_ID = process.env.ALPACA_KEY_ID;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;

// Key is read from env and passed only into fetch headers -- never
// interpolated into a logged string, error message, or shell command.
async function alpacaGet(base, urlPath, params = {}) {
  const url = new URL(base + urlPath);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { 'APCA-API-KEY-ID': ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${urlPath}: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY) {
    console.error('capture-movers-snapshot: ALPACA_KEY_ID / ALPACA_SECRET_KEY not set in environment.');
    process.exit(1);
  }

  const capturedAt = new Date().toISOString();
  const clock = await alpacaGet(ALPACA_TRADING_BASE, '/v2/clock');

  let row;
  if (!clock.is_open) {
    row = { capturedAt, marketOpen: false, movers: null, mostActives: null };
    console.log(`capture-movers-snapshot: market closed at ${capturedAt} (next open ${clock.next_open}) -- logging a closed marker, no screener call made.`);
  } else {
    const [movers, mostActives] = await Promise.all([
      alpacaGet(ALPACA_SCREENER_BASE, '/screener/stocks/movers', { top: 50 }),
      alpacaGet(ALPACA_SCREENER_BASE, '/screener/stocks/most-actives', { top: 50 }),
    ]);
    row = { capturedAt, marketOpen: true, movers, mostActives };
    console.log(`capture-movers-snapshot: captured ${movers.gainers?.length ?? 0} gainers, ${movers.losers?.length ?? 0} losers, ${mostActives.most_actives?.length ?? 0} most-actives at ${capturedAt}.`);
  }

  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(row) + '\n');
}

main().catch((err) => {
  console.error('capture-movers-snapshot: FAILED —', err.message);
  process.exit(1);
});
