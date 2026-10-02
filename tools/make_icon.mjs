// Render the app icon (desktop/build/icon.png, 1024 px) from an SVG with the pinned Playwright Chromium.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
 <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a8a75"/><stop offset="1" stop-color="#134c40"/></linearGradient></defs>
 <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#g)"/>
 <g fill="none" stroke="#e8f6f1" stroke-width="44" stroke-linejoin="round" stroke-linecap="round">
  <path d="M300 760 V300 h250 a140 140 0 0 1 0 280 H300"/>
  <path d="M600 760 l130-75 v-150 l-130-75 -130 75 v150 z" stroke="#6fe3c1"/>
  <path d="M470 535 L600 610 L730 535 M600 610 V760" stroke="#6fe3c1" stroke-width="30"/>
 </g></svg>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
mkdirSync(new URL("../desktop/build/", import.meta.url), { recursive: true });
const png = await page.locator("svg").screenshot({ omitBackground: true });
writeFileSync(new URL("../desktop/build/icon.png", import.meta.url), png);
writeFileSync(new URL("../web/icon.svg", import.meta.url), svg);
await browser.close();
console.log(JSON.stringify({ icon: "desktop/build/icon.png", bytes: png.length }));
