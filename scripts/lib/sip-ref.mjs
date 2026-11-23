// scripts/lib/sip-ref.mjs -- the SIP reference price of scripts/measure-entry-price-gap.mjs (84d161a), shared: the close
// of the latest SIP 1-minute bar starting at or before a minute, looking back 7 days. Imported, not copied, so every
// measurement prices the same way. Adds what a long run needs: a dropped connection is retried (transport only), and
// each answer is cached outside the repository (SIP_REF_CACHE, default the OS temp dir), so a re-run reads the same bars.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickReference, latestSipBar } from '../measure-entry-price-gap.mjs';

export const cacheDir = () => { const d = process.env.SIP_REF_CACHE || path.join(os.tmpdir(), 'edge2-sip-ref-cache'); mkdirSync(d, { recursive: true }); return d; };

export async function sipRef(headers, sym, ms, { wait = ms2 => new Promise(r => setTimeout(r, ms2)) } = {}) {
  const key = path.join(cacheDir(), `${sym}-${ms}.json`);
  if (existsSync(key)) return JSON.parse(readFileSync(key, 'utf8'));
  let bars;
  for (let i = 0; ; i++) {
    try { bars = await latestSipBar(headers, sym, ms); break; }
    catch (e) { if (!(e instanceof TypeError) || i >= 5) throw e; await wait(2000 * (i + 1)); }
  }
  const ref = pickReference(bars, ms);
  writeFileSync(key, JSON.stringify(ref));
  await wait(320); // under the free plan's 200 requests a minute
  return ref;
}
