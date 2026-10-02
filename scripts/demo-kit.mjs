// Shared recording kit for product demos: a Playwright context with overlays (title/chapter cards, cursor, click
// ripple, keystroke HUD, captions) that exist only in the recording browser, plus pointer-driven helpers.
// Nothing here changes product behaviour or results.
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";

export async function openDemo(out) {
  await mkdir(out, { recursive: true });
  const icon = await readFile(new URL("../web/icon.svg", import.meta.url), "utf8");
  const W = 1440, H = 900;
  // DEMO_GL=gpu renders WebGL on the host GPU through ANGLE/Vulkan (as a user's browser would); the default is
  // software SwiftShader, which is too slow for animated factory-scale scenes on a shared CPU.
  const gl = process.env.DEMO_GL === "gpu" ? ["--use-angle=vulkan", "--enable-features=Vulkan", "--ignore-gpu-blocklist"] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];
  const browser = await chromium.launch({ args: gl });
  // The product CSP forbids inline styles; only this recording context bypasses it to draw overlays.
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: out, size: { width: W, height: H } } });
  await context.addInitScript(([logo]) => {
    localStorage.setItem("pai-theme", "dark"); localStorage.setItem("pai-assistant", "open"); localStorage.setItem("pai-rail", "expanded");
    localStorage.setItem("pai-assistant-mode", "ai"); localStorage.removeItem("pai-cad-code-draft");
    addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `
        #demo-cursor{position:fixed;z-index:99999;width:22px;height:22px;margin:-3px 0 0 -3px;pointer-events:none;transition:transform .08s}
        #demo-cursor svg{filter:drop-shadow(0 2px 4px #000a)}
        .demo-ripple{position:fixed;z-index:99998;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:3px solid #6fe3c1;pointer-events:none;animation:demo-r .6s ease-out forwards}
        @keyframes demo-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.7);opacity:0}}
        #demo-caption{position:fixed;z-index:99997;left:50%;bottom:34px;transform:translateX(-50%) translateY(8px);max-width:960px;padding:14px 22px;border-radius:14px;
          background:linear-gradient(135deg,#0b1417f2,#12302af2);border:1px solid #2f6b5d;color:#fff;font:700 19px/1.45 "Noto Sans SC",Inter,sans-serif;
          box-shadow:0 18px 40px #000a;pointer-events:none;opacity:0;transition:opacity .35s,transform .35s}
        #demo-caption.on{opacity:1;transform:translateX(-50%) translateY(0)}
        #demo-caption small{display:block;font-weight:500;font-size:14px;color:#9fe3cc;margin-top:2px}
        #demo-chapter{position:fixed;z-index:99996;top:64px;left:50%;transform:translateX(-50%);display:flex;gap:10px;align-items:center;padding:7px 16px 7px 8px;border-radius:999px;
          background:#0b1417e6;border:1px solid #2f6b5d;color:#e1ece9;font:700 13px/1 Inter,"Noto Sans SC",sans-serif;letter-spacing:.4px;opacity:0;transition:opacity .35s;pointer-events:none}
        #demo-chapter.on{opacity:1} #demo-chapter b{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#3fb596;color:#06231c;font-size:12px}
        #demo-keys{position:fixed;z-index:99996;right:28px;bottom:34px;display:flex;gap:6px;opacity:0;transition:opacity .25s;pointer-events:none}
        #demo-keys.on{opacity:1} #demo-keys kbd{font:700 15px/1 ui-monospace,monospace;padding:9px 12px;border-radius:8px;background:#e1ece9;color:#0b1417;box-shadow:0 3px 0 #7f9693}
        #demo-card{position:fixed;inset:0;z-index:100000;display:grid;place-content:center;justify-items:center;gap:18px;text-align:center;pointer-events:none;
          background:radial-gradient(1200px 700px at 50% 40%,#16483e 0%,#0b1417 60%,#05090b 100%);color:#e1ece9;font-family:Inter,"Noto Sans SC",sans-serif;opacity:0;transition:opacity .6s}
        #demo-card.on{opacity:1} #demo-card svg{width:112px;height:112px;filter:drop-shadow(0 14px 30px #000c)}
        #demo-card h1{font-size:46px;letter-spacing:-.8px;margin:0;font-weight:800}
        #demo-card p{margin:0;font-size:19px;color:#9fe3cc;font-weight:600}
        #demo-card .chips{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;max-width:980px;margin-top:6px}
        #demo-card .chips span{padding:7px 14px;border-radius:999px;border:1px solid #2f6b5d;background:#0f2a25;color:#cfe1dd;font-size:14px;font-weight:600}
        #demo-card small{color:#7f9693;font-size:14px}
        .demo-spot{outline:3px solid #6fe3c1 !important;outline-offset:3px;border-radius:8px;transition:outline-color .3s}`;
      document.head.append(style);
      const cursor = Object.assign(document.createElement("div"), { id: "demo-cursor",
        innerHTML: '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 2l7 18 2.6-7.4L19 10z" fill="#fff" stroke="#0b1417" stroke-width="1.5"/></svg>' });
      const caption = Object.assign(document.createElement("div"), { id: "demo-caption" });
      const chapter = Object.assign(document.createElement("div"), { id: "demo-chapter" });
      const keys = Object.assign(document.createElement("div"), { id: "demo-keys" });
      const card = Object.assign(document.createElement("div"), { id: "demo-card" });
      document.body.append(cursor, caption, chapter, keys, card);
      addEventListener("mousemove", e => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; }, true);
      addEventListener("mousedown", e => { const r = Object.assign(document.createElement("div"), { className: "demo-ripple" }); r.style.left = `${e.clientX}px`; r.style.top = `${e.clientY}px`;
        document.body.append(r); setTimeout(() => r.remove(), 700); cursor.style.transform = "scale(.85)"; }, true);
      addEventListener("mouseup", () => { cursor.style.transform = ""; }, true);
      window.__caption = (t, s) => { caption.innerHTML = t ? `${t}${s ? `<small>${s}</small>` : ""}` : ""; caption.classList.toggle("on", Boolean(t)); };
      window.__chapter = (n, t) => { chapter.innerHTML = n ? `<b>${n}</b>${t}` : ""; chapter.classList.toggle("on", Boolean(n)); };
      window.__keys = list => { keys.innerHTML = (list ?? []).map(k => `<kbd>${k}</kbd>`).join(""); keys.classList.toggle("on", Boolean(list?.length)); };
      window.__card = (title, sub, chips, foot) => {
        card.innerHTML = title ? `${logo}<h1>${title}</h1><p>${sub ?? ""}</p>${chips ? `<div class="chips">${chips.map(c => `<span>${c}</span>`).join("")}</div>` : ""}${foot ? `<small>${foot}</small>` : ""}` : "";
        card.classList.toggle("on", Boolean(title)); };
    });
  }, [icon]);

  const page = await context.newPage();
  // Fail loudly instead of hanging forever when an expected element never appears.
  page.setDefaultTimeout(120_000);
  const pause = ms => page.waitForTimeout(ms);
  const caption = (t, s = "") => page.evaluate(([a, b]) => window.__caption?.(a, b), [t, s]);
  const chapter = (n, t = "") => page.evaluate(([a, b]) => window.__chapter?.(a, b), [n, t]);
  const keys = list => page.evaluate(l => window.__keys?.(l), list);
  const card = (t, s, chips, foot) => page.evaluate(([a, b, c, d]) => window.__card?.(a, b, c, d), [t, s, chips, foot]);
  async function click(locator, wait = 500) {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await locator.boundingBox();
    if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 }); await pause(220); }
    await locator.click(); await pause(wait);
  }
  async function type(locator, text, delay = 24) {
    await click(locator, 200);
    for (const ch of text) { await page.keyboard.type(ch); await pause(delay); }
  }
  async function orbit(dx, dy) {
    await pause(700);
    const box = await page.locator(".viewport-canvas").boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 10 }); await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 45 }); await page.mouse.up();
    await page.evaluate(() => getSelection()?.removeAllRanges()); await pause(300);
  }
  async function spot(locator, ms = 1800) {
    await locator.evaluate(e => e.classList.add("demo-spot")); await pause(ms); await locator.evaluate(e => e.classList.remove("demo-spot"));
  }
  // Wheel scrolling (as a user would): programmatic smooth scrolls are cancelled by the assistant timeline's own scrolling.
  async function wheelTo(locator, offset = 70) {
    for (let i = 0; i < 30; i++) {
      const box = await locator.boundingBox(); if (!box) return;
      const d = box.y - offset; if (Math.abs(d) < 12) return;
      await page.mouse.move(640, 450); await page.mouse.wheel(0, Math.sign(d) * Math.min(Math.abs(d), 160)); await pause(60);
    }
  }
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  const composer = assistant.locator("#studio-input");
  const marks = [];
  const t0 = Date.now();
  const mark = name => { marks.push({ name, at: Date.now() }); console.log(`[demo] ${name} +${Math.round((Date.now() - t0) / 1000)}s`); };
  const elapsed = () => marks.map(m => ({ name: m.name, seconds: Math.round((m.at - t0) / 100) / 10 }));
  return { browser, context, page, pause, caption, chapter, keys, card, click, type, orbit, spot, wheelTo, assistant, composer, mark, elapsed, t0 };
}
