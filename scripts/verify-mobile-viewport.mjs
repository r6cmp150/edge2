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

const URL = process.argv[2] || 'http://localhost:8791/index.html';
const VIEWPORT = { width: 390, height: 844 }; // iPhone 14/15-class width -- the narrowest common real device, not an arbitrary round number
const TABS = ['signals', 'warrior', 'portfolio', 'sold', 'settings'];
const PIN = '0684'; // default PIN, app.js's own documented fallback

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

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate((pin) => { for (const d of pin) pinPress(d); }, PIN);
  await page.waitForTimeout(2500);

  let failures = 0;
  for (const tab of TABS) {
    await page.evaluate((t) => switchTab(t), tab);
    await page.waitForTimeout(tab === 'warrior' ? 2000 : 1200);
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    const clipped = await page.evaluate(checkClippingScript);
    const ok = !pageOverflow && clipped.length === 0;
    console.log(`[mobile-viewport] ${tab}: ${ok ? 'PASS' : 'FAIL'}${pageOverflow ? ' (page-level horizontal overflow)' : ''}${clipped.length ? ` (${clipped.length} clipped element(s))` : ''}`);
    if (!ok) { failures++; if (clipped.length) console.log(JSON.stringify(clipped, null, 2)); }
  }

  if (pageErrors.length) {
    console.log(`[mobile-viewport] ${pageErrors.length} JS error(s) during the run:`, pageErrors.slice(0, 5));
    failures++;
  }

  console.log(`\n[mobile-viewport] === ${failures === 0 ? 'ALL PASS' : failures + ' CHECK(S) FAILED'} at ${VIEWPORT.width}x${VIEWPORT.height} ===`);
  console.log('[mobile-viewport] NOTE: this covers 5 main tabs, not the stock detail modal -- that needs a live open position or signal card to open, and this script does not fabricate one against real data. Verify the modal by hand (or against a seeded test account) when a change touches it specifically.');

  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('[mobile-viewport] FAILED —', err.message, err.stack); process.exit(1); });
