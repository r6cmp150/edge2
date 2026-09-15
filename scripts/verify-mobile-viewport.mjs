#!/usr/bin/env node
// Phase 9 §7 (2026-09-15): mobile viewport had NEVER been verified before
// this session -- the extension tool this project's own workflow relies
// on (claude-in-chrome's resize_window) reports success while
// window.innerWidth silently stays at the desktop size (confirmed
// broken, filed as feedback). Playwright launched directly does not have
// this problem. This script exists so "check mobile width" stops being
// a thing anyone has to remember to do by hand -- run it whenever a UI
// change touches app.js/styles.css/index.html, the same way the `run`
// skill's own guidance already expects a real render check before
// calling a UI change done.
//
// Checks TWO things per tab, because a page-level scrollWidth check
// alone misses a real bug class: an inner container can clip content
// (overflow-x: hidden/clip/visible with real overflow) while the page
// itself reports no horizontal scroll at all. Found live building this
// script: the Signals tab's universe-filter pill row LOOKED clipped in a
// static screenshot ("...INDUS" cut off at the edge) -- turned out to be
// `overflow-x: auto`, an intentional swipeable-chips pattern, not a bug.
// Distinguishing the two needs exactly this per-element check, not a
// screenshot read.
//
// 1. Page-level: document.documentElement.scrollWidth > innerWidth
//    (the page itself needs to scroll horizontally -- always a bug here).
// 2. Per-element: any leaf-ish element (<=3 children, to skip large
//    wrapping containers where a false positive is likely) whose own
//    scrollWidth exceeds its clientWidth WITHOUT overflow-x: auto/scroll
//    -- content that's wider than its box and has no way to reach it.
//
// Usage: start the local static server first (node scripts/_static-server.mjs),
// then: node scripts/verify-mobile-viewport.mjs [url]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const URL = process.argv[2] || 'http://localhost:8791/index.html';
const VIEWPORT = { width: 390, height: 844 }; // iPhone 14/15-class width -- the narrowest common real device, not an arbitrary round number
const TABS = ['signals', 'warrior', 'portfolio', 'sold', 'settings'];

// Real end-to-end review (2026-09-15) found this script's first version
// reported "no owned position priced" for a REAL reason but the WRONG
// diagnosis: it never actually had an Alpaca key, so every price-dependent
// fetch 401'd. `core/store.js`'s own comment says why -- API keys are
// "deliberately never sent to Supabase at all," they live ONLY in this
// browser's localStorage (`edge_apiKeys`) -- so a fresh Playwright profile
// with an empty localStorage can never inherit them from the real
// production account no matter how real the Supabase-backed portfolio
// data is. This was already solved once in this repo: scripts/replay-
// scan.mjs seeds both `edge_apiKeys` and the PIN-bypass flag via
// addInitScript before the app's own boot code runs, reading the same
// real keys from .env.local every other probe script in this project
// already uses. Reused verbatim rather than re-derived.
function readEnvLocal() {
  const raw = readFileSync(path.join(REPO_ROOT, '.env.local'), 'utf8');
  const kv = {};
  for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) kv[m[1]] = m[2]; }
  return { alpacaKey: kv.APCA_API_KEY_ID, alpacaSecret: kv.APCA_API_SECRET_KEY };
}
const { alpacaKey, alpacaSecret } = readEnvLocal();

function checkClippingScript() {
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length > 3) continue;
    const style = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 2 && style.overflowX !== 'auto' && style.overflowX !== 'scroll') {
      bad.push({
        tag: el.tagName, cls: (el.className || '').toString().slice(0, 60),
        text: el.textContent.trim().slice(0, 50), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      });
    }
  }
  return bad.slice(0, 20);
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.addInitScript(({ alpacaKey, alpacaSecret }) => {
    try {
      sessionStorage.setItem('edge2_pin_verified', 'true');
      localStorage.setItem('edge_apiKeys', JSON.stringify({ alpacaKey, alpacaSecret, groqKey: '' }));
    } catch (e) { /* localStorage unavailable — app's own boot will surface this */ }
  }, { alpacaKey, alpacaSecret });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  let failures = 0;
  for (const tab of TABS) {
    await page.evaluate((t) => switchTab(t), tab);
    await page.waitForTimeout(tab === 'warrior' ? 2000 : 1200);
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    const clipped = await page.evaluate(checkClippingScript);
    const ok = !pageOverflow && clipped.length === 0;
    console.log(`[mobile-viewport] ${tab}: ${ok ? 'PASS' : 'FAIL'}${pageOverflow ? ' (page-level horizontal overflow)' : ''}${clipped.length ? ` (${clipped.length} clipped element(s))` : ''}`);
    if (!ok) { failures++; if (clipped.length) console.log(JSON.stringify(clipped, null, 2)); }

    // Phase 9 §7 (2026-09-15): the stock detail modal is where the new
    // intraday panel lives (the copy this whole feature is FOR — "Roman
    // reads this on a phone"), so it needs the same 390px pass as the 5
    // tabs above, not a separate manual check remembered later. Only
    // possible when a real owned EDGE/legacy position exists this run
    // (state.portfolio reflects Roman's actual live data, same reason
    // this script has never fabricated one) -- when none does, this is
    // reported plainly as NOT COVERED, not silently skipped as if it
    // passed.
    if (tab === 'portfolio') {
      const opened = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.portfolio-card')];
        for (const card of cards) {
          const btn = [...card.querySelectorAll('button')].find(b => b.textContent.includes('View signal'));
          if (btn) { btn.click(); return true; }
        }
        return false;
      });
      if (opened) {
        await page.waitForTimeout(2500);
        const modalIsStockModal = await page.evaluate(() => !!document.getElementById('stock-modal-body'));
        if (modalIsStockModal) {
          const modalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
          const modalClipped = await page.evaluate(checkClippingScript);
          const modalOk = !modalOverflow && modalClipped.length === 0;
          console.log(`[mobile-viewport] portfolio/stock-modal: ${modalOk ? 'PASS' : 'FAIL'}${modalOverflow ? ' (page-level horizontal overflow)' : ''}${modalClipped.length ? ` (${modalClipped.length} clipped element(s))` : ''}`);
          if (!modalOk) { failures++; if (modalClipped.length) console.log(JSON.stringify(modalClipped, null, 2)); }
          const intradayText = await page.evaluate(() => document.querySelector('.intraday-panel, .intraday-panel-failed, .intraday-panel-nodata')?.textContent?.trim() || null);
          console.log(`[mobile-viewport] portfolio/stock-modal intraday panel text: ${intradayText ? JSON.stringify(intradayText) : '(not rendered — no owned position priced, or none held)'}`);
          await page.evaluate(() => { if (typeof closeModal === 'function') closeModal(); });
          await page.waitForTimeout(300);
        } else {
          console.log('[mobile-viewport] portfolio/stock-modal: NOT COVERED (View signal opened a non-EDGE engine snapshot modal, not the stock detail modal)');
        }
      } else {
        console.log('[mobile-viewport] portfolio/stock-modal: NOT COVERED (no owned position open this run to click into)');
      }
    }
  }

  if (pageErrors.length) {
    console.log(`[mobile-viewport] ${pageErrors.length} JS error(s) during the run:`, pageErrors.slice(0, 5));
    failures++;
  }

  console.log(`\n[mobile-viewport] === ${failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED'} at ${VIEWPORT.width}x${VIEWPORT.height} ===`);
  console.log('[mobile-viewport] NOTE: the stock detail modal is now checked too (Phase 9 §7), but only when an owned EDGE/legacy position exists in real production data this run -- this script still never fabricates one, so an empty portfolio means that check reports NOT COVERED above, not a false PASS.');

  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('[mobile-viewport] FAILED —', err.message, err.stack); process.exit(1); });
