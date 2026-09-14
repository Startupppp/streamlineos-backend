import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import postgres from "./../../node_modules/postgres/src/index.js";

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const FRONTEND_URL = "http://127.0.0.1:1000";
const SCRATCH_URL = "postgresql://neondb_owner@127.0.0.1:5432/scratch_local?sslmode=disable";
const USER9999 = "bbbbbbbb-9999-0000-0000-000000000002";
const ROUTES = (process.env.PROBE_ROUTES ?? "/dashboard,/calendar").split(",");
const FAB = 'button[aria-label="Open quick actions"]';

const MOBILE = {
  width: 412,
  height: 915,
  deviceScaleFactor: 2.625,
  mobile: true,
};
const CPU_THROTTLE = 4;

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(2)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashToken = (raw) => createHash("sha256").update(raw).digest("hex");

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

async function waitForDevTools(port, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`DevTools not ready on port ${port}`);
}

async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id !== undefined) {
      const cb = pending.get(msg.id);
      if (cb) {
        pending.delete(msg.id);
        cb(msg);
      }
    }
  };
  return {
    send(method, params = {}) {
      const id = ++msgId;
      return new Promise((res, rej) => {
        pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function evaluate(cdp, expression) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.value;
}

function summariseProfile(profile) {
  const byId = new Map();
  for (const node of profile.nodes) byId.set(node.id, node);
  const self = new Map();
  const total = profile.samples?.length ?? 0;
  for (const id of profile.samples ?? []) {
    const node = byId.get(id);
    if (!node) continue;
    const f = node.callFrame;
    const name = `${f.functionName || "(anonymous)"} @ ${(f.url || "").split("/").pop()}:${f.lineNumber}`;
    self.set(name, (self.get(name) ?? 0) + 1);
  }
  const interval = profile.endTime && profile.startTime && total
    ? (profile.endTime - profile.startTime) / total / 1000
    : 0;
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, samples]) => ({
      name,
      samples,
      approxMs: Number((samples * interval).toFixed(1)),
      pct: Number(((samples / total) * 100).toFixed(1)),
    }));
}

async function main() {
  const sql = postgres(SCRATCH_URL, { max: 2, prepare: false });
  const rawToken = randomBytes(24).toString("hex");
  let browser = null;
  let cdp = null;
  try {
    await sql`
      INSERT INTO magic_link_tokens (id, user_id, token_hash, expires_at, created_at)
      VALUES (gen_random_uuid(), ${USER9999}, ${hashToken(rawToken)}, now() + interval '1 hour', now())
      ON CONFLICT DO NOTHING`;

    const browserPath = findBrowser();
    if (!browserPath) throw new Error("No Chrome/Edge found");
    const userDataDir = join(tmpdir(), `cdp-inp-${randomBytes(4).toString("hex")}`);
    const proc = spawn(
      browserPath,
      [
        "--remote-debugging-port=9332",
        `--user-data-dir=${userDataDir}`,
        "--headless=new",
        "--no-sandbox",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
        "--disable-gpu",
        "--window-size=412,915",
      ],
      { stdio: "pipe" },
    );
    browser = { proc };
    const wsUrl = await waitForDevTools(9332);
    cdp = await cdpSession(wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Profiler.enable");

    await cdp.send("Page.navigate", {
      url: `${FRONTEND_URL}/magic-link?token=${encodeURIComponent(rawToken)}`,
    });
    await sleep(9000);
    const session = JSON.parse(
      (await evaluate(cdp, "fetch('/api/auth/session').then(r=>r.json()).then(d=>JSON.stringify(d))")) ?? "{}",
    );
    const landed = await evaluate(cdp, "location.href");
    if (!session.backendJwt || (session.enabledModules?.length ?? 0) === 0) {
      log(`NOT-RUN: unauthenticated shell (landed=${landed})`);
      return;
    }
    log(`authenticated at ${landed}, ${session.enabledModules.length} modules`);

    await cdp.send("Emulation.setDeviceMetricsOverride", MOBILE);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });

    for (const route of ROUTES) {
      await cdp.send("Page.navigate", { url: `${FRONTEND_URL}${route}` });
      await sleep(8000);

      const box = await evaluate(
        cdp,
        `(() => { const el = document.querySelector('${FAB}'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); })()`,
      );
      if (!box) {
        log(`${route}: FAB not found, skipping`);
        continue;
      }
      const { x, y } = JSON.parse(box);

      await evaluate(
        cdp,
        `(() => { window.__longTasks = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push({ dur: Math.round(e.duration), start: Math.round(e.startTime) }); }).observe({ type: 'longtask', buffered: false }); window.__inp = null; new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.interactionId) continue; const d = Math.round(e.duration); if (!window.__inp || d > window.__inp.dur) window.__inp = { dur: d, name: e.name, delay: Math.round(e.processingStart - e.startTime), proc: Math.round(e.processingEnd - e.processingStart), present: Math.round(e.startTime + e.duration - e.processingEnd) }; } }).observe({ type: 'event', durationThreshold: 16, buffered: false }); })()`,
      );

      await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await cdp.send("Profiler.start");
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      }
      await sleep(2500);
      const { profile } = await cdp.send("Profiler.stop");

      const firstInp = JSON.parse((await evaluate(cdp, "JSON.stringify(window.__inp)")) ?? "null");
      await evaluate(cdp, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      await sleep(1200);
      await evaluate(cdp, "window.__inp = null; window.__longTasks = [];");
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      await sleep(2500);
      const secondInp = JSON.parse((await evaluate(cdp, "JSON.stringify(window.__inp)")) ?? "null");
      const secondTasks = JSON.parse((await evaluate(cdp, "JSON.stringify(window.__longTasks ?? [])")) ?? "[]");
      console.log(`\n--- ${route} SECOND click (panel chunk already loaded and rendered once) ---`);
      console.log(
        `  first : ${firstInp ? `${firstInp.dur}ms delay=${firstInp.delay} proc=${firstInp.proc} present=${firstInp.present}` : "none"}`,
      );
      console.log(
        `  second: ${secondInp ? `${secondInp.dur}ms delay=${secondInp.delay} proc=${secondInp.proc} present=${secondInp.present}` : "none"}`,
      );
      console.log(`  second-click long tasks: ${secondTasks.map((t) => `${t.dur}ms`).join(", ") || "none"}`);

      const longTasks = JSON.parse((await evaluate(cdp, "JSON.stringify(window.__longTasks ?? [])")) ?? "[]");
      const inp = JSON.parse((await evaluate(cdp, "JSON.stringify(window.__inp)")) ?? "null");

      console.log(`\n=== ${route} (mobile, ${CPU_THROTTLE}x CPU throttle) ===`);
      console.log(
        `  INP entry: ${inp ? `${inp.dur}ms (${inp.name}) inputDelay=${inp.delay}ms processing=${inp.proc}ms presentation=${inp.present}ms` : "none recorded"}`,
      );
      console.log(`  long tasks: ${longTasks.map((t) => `${t.dur}ms`).join(", ") || "none"}`);
      console.log("  top self-time frames during the click:");
      for (const row of summariseProfile(profile))
        console.log(`    ${String(row.approxMs).padStart(7)}ms ${String(row.pct).padStart(5)}%  ${row.name}`);
    }
  } finally {
    if (cdp) cdp.close();
    if (browser?.proc) browser.proc.kill();
    await sql`DELETE FROM magic_link_tokens WHERE token_hash = ${hashToken(rawToken)}`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`probe crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
