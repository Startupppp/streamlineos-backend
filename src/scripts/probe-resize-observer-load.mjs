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
const ROUTES = (process.env.PROBE_ROUTES ?? "/dashboard,/build/inbox,/build/my-work,/calendar").split(",");
const IDLE_WINDOW_MS = 6000;

const MOBILE = { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashToken = (raw) => createHash("sha256").update(raw).digest("hex");
const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(2)}s] ${m}`);

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

const INSTRUMENT = `(() => {
  const Native = window.ResizeObserver;
  window.__ro = { constructed: 0, callbacks: 0, observed: 0 };
  window.__rangeCalls = 0;
  const nativeSelect = Range.prototype.selectNodeContents;
  Range.prototype.selectNodeContents = function (...args) {
    window.__rangeCalls += 1;
    return nativeSelect.apply(this, args);
  };
  window.ResizeObserver = class extends Native {
    constructor(cb) {
      window.__ro.constructed += 1;
      super((...a) => { window.__ro.callbacks += 1; return cb(...a); });
    }
    observe(...a) { window.__ro.observed += 1; return super.observe(...a); }
  };
  window.__longTaskMs = 0;
  window.__longTaskCount = 0;
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) { window.__longTaskMs += e.duration; window.__longTaskCount += 1; }
  }).observe({ type: "longtask", buffered: true });
})()`;

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
        "--remote-debugging-port=9333",
        `--user-data-dir=${join(tmpdir(), `cdp-ro-${randomBytes(4).toString("hex")}`)}`,
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
    cdp = await cdpSession(await waitForDevTools(9333));
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
      log("NOT-RUN: unauthenticated shell");
      return;
    }
    log(`authenticated, ${session.enabledModules.length} modules`);

    await cdp.send("Emulation.setDeviceMetricsOverride", MOBILE);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });

    console.log(
      `\n${"route".padEnd(18)} ${"RO built".padStart(9)} ${"RO cbs".padStart(7)} ${"Range".padStart(7)} ${"longtasks".padStart(10)} ${"longtask ms".padStart(12)}`,
    );
    for (const route of ROUTES) {
      await cdp.send("Page.navigate", { url: `${FRONTEND_URL}${route}` });
      await sleep(8000);
      await evaluate(cdp, "window.__longTaskMs = 0; window.__longTaskCount = 0; window.__ro.callbacks = 0; window.__rangeCalls = 0;");
      await sleep(IDLE_WINDOW_MS);
      const snap = JSON.parse(
        (await evaluate(
          cdp,
          "JSON.stringify({ ro: window.__ro, range: window.__rangeCalls, ltMs: Math.round(window.__longTaskMs), ltN: window.__longTaskCount, href: location.href })",
        )) ?? "{}",
      );
      const onRoute = typeof snap.href === "string" && snap.href.includes(route);
      console.log(
        `${route.padEnd(18)} ${String(snap.ro?.constructed ?? "?").padStart(9)} ${String(snap.ro?.callbacks ?? "?").padStart(7)} ${String(snap.range ?? "?").padStart(7)} ${String(snap.ltN ?? "?").padStart(10)} ${String(snap.ltMs ?? "?").padStart(12)}${onRoute ? "" : "   [OFF-ROUTE, discard]"}`,
      );
    }
    console.log(
      `\nCounters are for a ${IDLE_WINDOW_MS}ms window with NO interaction, 8s after navigation, mobile 4x CPU throttle.`,
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
