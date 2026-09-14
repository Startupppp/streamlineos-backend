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
const ROUTES = (process.env.PROBE_ROUTES ?? "/dashboard,/build/inbox,/build/my-work").split(",");
const REPEATS = Number(process.env.PROBE_REPEATS ?? 5);
const FAB = 'button[aria-label="Open quick actions"]';

const PROMOTION_CSS = `
button[aria-label="Close quick actions"] { will-change: opacity; }
[data-slot="mobile-shell-fab-sheet"] { will-change: transform; }
`;

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

const OBSERVER = `(() => {
  window.__samples = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (!e.interactionId) continue;
      window.__samples.push({
        dur: Math.round(e.duration),
        delay: Math.round(e.processingStart - e.startTime),
        proc: Math.round(e.processingEnd - e.processingStart),
        present: Math.round(e.startTime + e.duration - e.processingEnd),
      });
    }
  }).observe({ type: "event", durationThreshold: 16, buffered: false });
})()`;

function p75(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
}

async function measureRoute(cdp, route, promote) {
  await cdp.send("Page.navigate", { url: `${FRONTEND_URL}${route}` });
  await sleep(8000);
  const href = await evaluate(cdp, "location.href");
  if (typeof href !== "string" || !href.includes(route)) return { offRoute: true, href };

  if (promote)
    await evaluate(
      cdp,
      `(() => { const s = document.createElement('style'); s.id='__promote'; s.textContent = ${JSON.stringify(PROMOTION_CSS)}; document.head.appendChild(s); })()`,
    );

  await evaluate(cdp, OBSERVER);
  const box = await evaluate(
    cdp,
    `(() => { const el = document.querySelector('${FAB}'); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); })()`,
  );
  if (!box) return { noFab: true };
  const { x, y } = JSON.parse(box);

  for (let i = 0; i < REPEATS; i += 1) {
    for (const type of ["mousePressed", "mouseReleased"])
      await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    await sleep(1400);
    await evaluate(cdp, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await sleep(1000);
  }

  const samples = JSON.parse((await evaluate(cdp, "JSON.stringify(window.__samples ?? [])")) ?? "[]");
  return {
    n: samples.length,
    inp: p75(samples.map((s) => s.dur)),
    delay: p75(samples.map((s) => s.delay)),
    proc: p75(samples.map((s) => s.proc)),
    present: p75(samples.map((s) => s.present)),
  };
}

async function main() {
  const sql = postgres(SCRATCH_URL, { max: 2, prepare: false });
  const rawToken = randomBytes(24).toString("hex");
  let proc = null;
  let cdp = null;
  try {
    await sql`
      INSERT INTO magic_link_tokens (id, user_id, token_hash, expires_at, created_at)
      VALUES (gen_random_uuid(), ${USER9999}, ${hashToken(rawToken)}, now() + interval '1 hour', now())
      ON CONFLICT DO NOTHING`;

    const browserPath = findBrowser();
    if (!browserPath) throw new Error("No Chrome/Edge found");
    proc = spawn(
      browserPath,
      [
        "--remote-debugging-port=9334",
        `--user-data-dir=${join(tmpdir(), `cdp-promote-${randomBytes(4).toString("hex")}`)}`,
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
    cdp = await cdpSession(await waitForDevTools(9334));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await cdp.send("Page.navigate", {
      url: `${FRONTEND_URL}/magic-link?token=${encodeURIComponent(rawToken)}`,
    });
    await sleep(9000);
    const session = JSON.parse(
      (await evaluate(cdp, "fetch('/api/auth/session').then(r=>r.json()).then(d=>JSON.stringify(d))")) ?? "{}",
    );
    if (!session.backendJwt || (session.enabledModules?.length ?? 0) === 0) {
      console.log("NOT-RUN: unauthenticated shell");
      return;
    }

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 412,
      height: 915,
      deviceScaleFactor: 2.625,
      mobile: true,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    console.log(
      `\n${"route".padEnd(16)} ${"variant".padEnd(10)} ${"n".padStart(3)} ${"INP p75".padStart(8)} ${"delay".padStart(6)} ${"proc".padStart(5)} ${"present".padStart(8)}`,
    );
    for (const route of ROUTES) {
      for (const promote of [false, true]) {
        const r = await measureRoute(cdp, route, promote);
        const label = promote ? "promoted" : "baseline";
        if (r.offRoute || r.noFab) {
          console.log(`${route.padEnd(16)} ${label.padEnd(10)} ${r.offRoute ? "OFF-ROUTE " + r.href : "no FAB"}`);
          continue;
        }
        console.log(
          `${route.padEnd(16)} ${label.padEnd(10)} ${String(r.n).padStart(3)} ${String(r.inp).padStart(8)} ${String(r.delay).padStart(6)} ${String(r.proc).padStart(5)} ${String(r.present).padStart(8)}`,
        );
      }
    }
    console.log(
      `\nEach variant reloads the route fresh; "promoted" injects will-change on the backdrop and sheet only.`,
    );
  } finally {
    if (cdp) cdp.close();
    if (proc) proc.kill();
    await sql`DELETE FROM magic_link_tokens WHERE token_hash = ${hashToken(rawToken)}`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`probe crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
