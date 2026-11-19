// scripts/probe-supabase-abort.mjs -- re-establish, for the PINNED supabase-js, the properties the app depends on
// (2026-11-19, the reviewer: "A pin freezes a version, not a property. The properties we depend on are re-established
// by a committed probe at each bump, or the pin merely makes an unverified assumption harder to notice changing").
// RUN IT ON EVERY DELIBERATE BUMP of the supabase-js <script> in index.html, before the bump is committed, and quote
// its last line in the record beside the pin (tests/external-scripts-pinned.test.js fails if the record's probed
// version is not the pinned one).
//
// What is depended on, and nothing else (the comment rule: the probe cannot tell "resolves with an error" from
// "throws", because boundedRequest catches both, so that is NOT claimed): .abortSignal() on each builder shape the app
// bounds, and each reaching its outcome at the bound through core/store.js boundedRequest -- FAILED for a read, UNKNOWN
// for a write.
//
// How: a real browser (Playwright's chromium) opens a bare page holding the library exactly as index.html loads it
// (the src is read from index.html, never repeated here) and the real boundedRequest (read from core/store.js). EVERY
// Supabase request is HELD, never answered and NEVER FORWARDED; every other host is aborted except the CDN GET that
// downloads the library. It reads; it writes nothing, to the repository or anywhere else.
// IT CANNOT REACH PRODUCTION BY CONSTRUCTION, not by the route alone: the client points at HOST, a `.invalid` name
// (RFC 6761: never resolves), and this file never names the production URL or key. Remove the route and the requests
// fail to resolve; they still cannot write. tests/production-writes.test.js checks exactly that, and exempts it on it.
//   node scripts/probe-supabase-abort.mjs            (Playwright from this repo's node_modules, or EDGE2_PLAYWRIGHT=<dir>)
// Exit 0 only if the served version is the pinned one and all six shapes reach their outcome within the bound + 1 s.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.EDGE2_PLAYWRIGHT ? path.resolve(process.env.EDGE2_PLAYWRIGHT) : 'playwright');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const store = fs.readFileSync(path.join(ROOT, 'core/store.js'), 'utf8');
const src = (html.match(/<script src="(https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"]+)"><\/script>/) || [])[1];
if (!src) { console.error('PROBE BROKEN: no supabase-js <script> found in index.html'); process.exit(2); }
const pinned = (src.match(/@(\d+\.\d+\.\d+)$/) || [])[1];
if (!pinned) { console.error(`PROBE REFUSED: index.html loads ${src}, which is not an exact version: pin it first`); process.exit(2); }
const HOST = 'supabase.probe.invalid'; // never production: see the header
const fnStart = store.indexOf('async function boundedRequest(');
const helper = store.slice(fnStart, store.indexOf('\n}\n', fnStart) + 3);
const MS = 800, SLACK = 1000;
const SHAPES = [ // [name, kind, builder expression on `c`]: the shapes core/store.js bounds
  ['select().order()  (the portfolio read)', 'read', "c.from('portfolio').select('*', { count: 'exact' }).order('buy_date', { ascending: true })"],
  ['select().order().limit().maybeSingle()  (the settings read)', 'read', "c.from('settings').select('*').order('id', { ascending: false }).limit(1).maybeSingle()"],
  ['delete().eq().select()  (the sale\'s row delete)', 'write', "c.from('portfolio').delete().eq('position_id', 'probe').select('position_id')"],
  ['insert()', 'write', "c.from('portfolio').insert([{ position_id: 'probe' }])"],
  ['insert().select()', 'write', "c.from('trades_v2').insert([{ ticker: 'PROBE' }]).select('id')"],
  ['update().eq().select()', 'write', "c.from('settings').update({ budget: 1 }).eq('id', 0).select('id')"],
];

const browser = await chromium.launch();
let ok = true;
try {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const held = [];
  let served = null;
  await ctx.route('**/*', async route => {
    const r = route.request(), u = new URL(r.url());
    if (u.hostname === 'probe.invalid') return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><script src="${src}"></script>` });
    if (u.hostname === 'cdn.jsdelivr.net' && r.method() === 'GET') {
      const res = await route.fetch(); served = res.headers()['x-jsd-version'] || null; return route.fulfill({ response: res });
    }
    if (u.hostname === HOST) { held.push(`${r.method()} ${u.pathname}`); return; } // HELD: never answered, never forwarded
    return route.abort();
  });
  const page = await ctx.newPage();
  await page.goto('http://probe.invalid/');
  await page.waitForFunction(() => window.supabase && window.supabase.createClient, null, { timeout: 30000 });
  await page.addScriptTag({ content: helper + '\nwindow.__bounded = boundedRequest;' });
  console.log(`index.html pins: ${src}`);
  console.log(`served: x-jsd-version ${served || '(absent)'}`);
  if (served !== pinned) { ok = false; console.log(`MISMATCH: the CDN served ${served}, the pin says ${pinned}`); }
  for (const [name, kind, expr] of SHAPES) {
    // THE PROBE IS BOUNDED TOO (found by its negative control, 2026-11-19: with the abort broken, a held request never
    // settles, and an unbounded probe hung instead of failing). Each shape races a deadline of bound + slack + 2 s.
    const out = await page.evaluate(async ({ expr, kind, MS, host, deadline }) => {
      const c = window.supabase.createClient(`https://${host}`, 'probe-key');
      // eslint-disable-next-line no-new-func
      const builder = new Function('c', `return ${expr};`)(c);
      const t0 = performance.now();
      const res = await Promise.race([window.__bounded(builder, { ms: MS, kind, what: 'probe' }),
        new Promise(r => setTimeout(() => r({ outcome: 'NO OUTCOME', reason: `nothing within ${deadline} ms` }), deadline))]);
      return { outcome: res.outcome, reason: res.reason, ms: Math.round(performance.now() - t0) };
    }, { expr, kind, MS, host: HOST, deadline: MS + SLACK + 2000 });
    const want = kind === 'write' ? 'UNKNOWN' : 'FAILED';
    const pass = out.outcome === want && /no answer within/.test(out.reason || '') && out.ms >= MS && out.ms <= MS + SLACK;
    if (!pass) ok = false;
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}: ${out.outcome} in ${out.ms} ms on a ${MS} ms bound (want ${want})`);
  }
  console.log(`held, never forwarded: ${held.length} request(s)`);
  console.log(`${ok ? 'PROBED' : 'PROBE FAILED'}: supabase-js ${pinned}, ${SHAPES.length} shapes, ${new Date().toISOString()}`);
} finally {
  await browser.close();
}
process.exitCode = ok ? 0 : 1;
