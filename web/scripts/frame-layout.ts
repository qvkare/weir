/**
 * Layout pass for the application frame, run by scripts/smoke.ts: opens each view in headless
 * Chrome at short laptop windows, scrolls the frame's main area, its sidebar and the page to the
 * bottom, and checks the end of the content is on screen and not clipped by the frame. It would
 * have caught the frame of 13 Nov 2026, whose grid row grew with its content, so the frame cut
 * off everything below its own height. Speaks the DevTools protocol over Node's own WebSocket; no
 * package. Returns null when no Chrome is found (CHROME=<path> names one).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

export interface LayoutRow {
  size: string;
  path: string;
  ok: boolean;
  detail: string;
}

// Runs in the page. The end of the main area's content and of the sidebar must be inside the
// frame, inside its own scroll area and inside the window, once everything is scrolled down.
const PROBE = `(() => {
  const main = document.querySelector('[data-frame-main]');
  if (!main) return { ok: false, detail: 'no frame main area' };
  const frame = main.closest('[data-app-frame]');
  const shown = (el) => getComputedStyle(el).display !== 'none';
  // Content inside a box that clips or scrolls on its own (a long list with its own scroll bar)
  // counts as that box: it is reached by scrolling the box, so the box is what must be reachable.
  // The body of a closed <details> keeps boxes but is not drawn; it is reached by opening it.
  const boxed = (e, root) => { for (let a = e.parentElement; a && a !== root; a = a.parentElement) { if (getComputedStyle(a).overflowY !== 'visible') return true; if (a.tagName === 'DETAILS' && !a.open && !e.closest('summary')) return true; } return false; };
  const bottomOf = (root) => Math.max(...[...root.querySelectorAll('*')].filter((e) => !boxed(e, root)).map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.bottom));
  main.scrollTop = main.scrollHeight;
  const aside = frame.querySelector('aside');
  if (aside && shown(aside)) aside.scrollTop = aside.scrollHeight;
  window.scrollTo(0, document.documentElement.scrollHeight);
  const fb = frame.getBoundingClientRect().bottom;
  const cutMain = Math.round(bottomOf(main) - Math.min(fb, main.getBoundingClientRect().bottom, innerHeight));
  const cutAside = aside && shown(aside) ? Math.round(bottomOf(aside) - Math.min(fb, aside.getBoundingClientRect().bottom, innerHeight)) : 0;
  const scrolls = /(auto|scroll)/.test(getComputedStyle(main).overflowY);
  const keys = !scrolls || main.tabIndex >= 0;
  const ok = cutMain <= 2 && cutAside <= 2 && keys;
  return { ok, detail: 'main ' + (cutMain > 2 ? 'cut by ' + cutMain + ' px' : 'reachable') + (scrolls ? ' (scrolls inside, ' + main.clientHeight + ' of ' + main.scrollHeight + ' px)' : ' (page scrolls)') + ', sidebar ' + (cutAside > 2 ? 'cut by ' + cutAside + ' px' : 'reachable') + (keys ? '' : ', main area not reachable by Tab') };
})()`;

export async function frameLayout(base: string, paths: string[], sizes: [number, number][]): Promise<LayoutRow[] | null> {
  const bin = CANDIDATES.find((c): c is string => !!c && existsSync(c));
  if (!bin) return null;
  const profile = mkdtempSync(join(tmpdir(), "weir-layout-"));
  const port = 9400 + Math.floor(Math.random() * 400);
  const chrome = spawn(bin, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    let tabs: { type: string; webSocketDebuggerUrl: string }[] | undefined;
    for (let i = 0; i < 75 && !tabs; i++) {
      try {
        tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      } catch {
        await sleep(200);
      }
    }
    const target = tabs?.find((t) => t.type === "page");
    if (!target) throw new Error("headless Chrome did not open a page");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    let id = 0;
    const pending = new Map<number, (v: unknown) => void>();
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as { id?: number; result?: unknown };
      if (d.id && pending.has(d.id)) {
        pending.get(d.id)!(d.result);
        pending.delete(d.id);
      }
    };
    const send = <T>(method: string, params: object = {}) =>
      new Promise<T>((r) => {
        const i = ++id;
        pending.set(i, r as (v: unknown) => void);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    await send("Page.enable");
    const rows: LayoutRow[] = [];
    for (const [w, h] of sizes) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
      for (const path of paths) {
        await send("Page.navigate", { url: base + path });
        // Wait for the load event, then two frames for the views' first layout.
        for (let i = 0; i < 50; i++) {
          const r = await send<{ result: { value: string } }>("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
          if (r.result.value === "complete") break;
          await sleep(100);
        }
        await sleep(600);
        const r = await send<{ result: { value?: { ok: boolean; detail: string } } }>("Runtime.evaluate", { expression: PROBE, returnByValue: true });
        const v = r.result.value ?? { ok: false, detail: "probe failed" };
        rows.push({ size: `${w}x${h}`, path, ok: v.ok, detail: v.detail });
      }
    }
    ws.close();
    return rows;
  } finally {
    chrome.kill();
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  }
}
