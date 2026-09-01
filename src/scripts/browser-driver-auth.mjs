/**
 * Authenticated CDP browser driver for Core Web Vitals on gated routes.
 *
 * Unlike browser-driver.mjs (which targets public routes), this script:
 *   1. Navigates to the login page and submits credentials.
 *   2. Waits for the authenticated redirect to complete.
 *   3. Navigates to each target URL and collects LCP / INP / CLS / long tasks.
 *
 * Produces results compatible with .browser-driver-results.json, merged under
 * a `"authenticated"` key so check-web-vitals-budget can read them separately.
 *
 * Requirements:
 *   - System Chrome at one of the BROWSER_CANDIDATES paths.
 *   - Frontend app running at LOGIN_URL and accessible at TARGET_URLS.
 *   - Valid --username and --password for a seeded test account.
 *
 * Run:
 *   node src/scripts/browser-driver-auth.mjs \
 *     --login-url=http://localhost:3000/login \
 *     --username=user@example.com \
 *     --password=testpassword \
 *     --urls=http://localhost:3000/mail,http://localhost:3000/inbox \
 *     --profile=mobile \
 *     --repeat=5
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const LOGIN_URL = flag("login-url", "http://localhost:3000/login");
const TARGET_URLS = flag("urls", "http://localhost:3000/mail").split(",");
const USERNAME = flag("username", "");
const PASSWORD = flag("password", "");
const OUT = resolve(process.cwd(), flag("out", ".browser-driver-auth-results.json"));
const REPEAT = Number(flag("repeat", "5"));
const TIMEOUT_MS = Number(flag("timeout", "20000"));
const DEBUG_PORT = Number(flag("debug-port", "9223"));
const PROFILE = flag("profile", "desktop");

if (!USERNAME || !PASSWORD) {
  console.error("REFUSED: --username and --password are required");
  process.exit(1);
}
if (!new Set(["desktop", "mobile"]).has(PROFILE)) {
  console.error(`REFUSED: --profile must be desktop or mobile, received ${PROFILE}`);
  process.exit(1);
}

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnBrowser(browserPath, debugPort, userDataDir) {
  return spawn(
    browserPath,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--no-sandbox",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
    ],
    { stdio: "pipe" },
  );
}

async function waitForDevTools(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://localhost:${debugPort}/json/version`);
      if (resp.ok) return (await resp.json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`DevTools not ready after ${timeoutMs}ms`);
}

async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  const events = new Map();
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
    } else if (msg.method) {
      const ls = events.get(msg.method);
      if (ls) for (const l of ls) l(msg.params);
    }
  };
  const send = (method, params = {}) => {
    const id = ++msgId;
    return new Promise((res, rej) =>
      pending.set(id, (m) =>
        m.error ? rej(new Error(m.error.message)) : res(m.result),
      ) && ws.send(JSON.stringify({ id, method, params })),
    );
  };
  const on = (event, listener) => {
    if (!events.has(event)) events.set(event, []);
    events.get(event).push(listener);
  };
  const close = () => ws.close();
  return { send, on, close };
}

async function applyThrottle(cdp) {
  if (PROFILE === "mobile") {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 1_600_000 / 8,
      uploadThroughput: 750_000 / 8,
      connectionType: "cellular4g",
    });
  } else {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "none",
    });
  }
}

const VITALS_SCRIPT = `(() => {
  if (window.__streamlineVitals) return;
  const state = { lcp: null, cls: 0, inp: null, longTaskMs: 0 };
  Object.defineProperty(window, '__streamlineVitals', { value: state });
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) state.lcp = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (!entry.hadRecentInput) state.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.interactionId && (state.inp === null || entry.duration > state.inp))
          state.inp = entry.duration;
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTaskMs += entry.duration;
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
})();`;

async function login(cdp, loginUrl, username, password) {
  log(`logging in at: ${loginUrl}`);
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Runtime.enable");

  const loaded = new Promise((res) => cdp.on("Page.loadEventFired", res));
  await cdp.send("Page.navigate", { url: loginUrl });
  await Promise.race([loaded, sleep(TIMEOUT_MS)]);
  await sleep(500);

  const fillResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const emailInput = document.querySelector('input[type="email"], input[name="email"], input[id*="email"], input[placeholder*="email" i]');
      const passwordInput = document.querySelector('input[type="password"]');
      const submitBtn = document.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (!emailInput || !passwordInput || !submitBtn) {
        return JSON.stringify({ ok: false, reason: 'inputs not found', email: !!emailInput, password: !!passwordInput, submit: !!submitBtn });
      }
      emailInput.value = ${JSON.stringify(username)};
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      passwordInput.value = ${JSON.stringify(password)};
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
      submitBtn.click();
      return JSON.stringify({ ok: true });
    })()`,
    returnByValue: true,
  });

  const fillStatus = JSON.parse(fillResult.result.value ?? '{"ok":false}');
  if (!fillStatus.ok) {
    log(`login form not found: ${JSON.stringify(fillStatus)}`);
    return false;
  }

  log("credentials submitted, waiting for redirect...");
  await sleep(3000);

  const currentUrl = await cdp.send("Runtime.evaluate", {
    expression: `window.location.href`,
    returnByValue: true,
  });
  const url = currentUrl.result.value ?? "";
  log(`current URL after login: ${url}`);

  if (url.includes("/login") || url.includes("/auth")) {
    log("WARNING: still on login/auth page — credentials may be wrong or 2FA required");
    return false;
  }

  log("login successful");
  return true;
}

async function measureRoute(cdp, url, timeoutMs) {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: VITALS_SCRIPT });

  const navStart = Date.now();
  const loaded = new Promise((res) => cdp.on("Page.loadEventFired", res));
  await cdp.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(timeoutMs)]);
  await sleep(500);

  const targetEntry = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const element = document.querySelector('button[type="button"], [role="button"], input:not([type="submit"])');
      if (!element) return { x: 1, y: 1 };
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })())`,
    returnByValue: true,
  });
  const target = JSON.parse(targetEntry.result.value ?? '{"x":1,"y":1}');
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(300);

  const wallMs = Date.now() - navStart;

  const navEntries = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(performance.getEntriesByType("navigation").map(e => ({ fetchStart: e.fetchStart, responseStart: e.responseStart, domContentLoadedEventEnd: e.domContentLoadedEventEnd, loadEventEnd: e.loadEventEnd })))`,
    returnByValue: true,
  });
  const paintEntries = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(performance.getEntriesByType("paint").map(e => ({name: e.name, startTime: e.startTime})))`,
    returnByValue: true,
  });
  const vitalsEntry = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(window.__streamlineVitals ?? {})`,
    returnByValue: true,
  });

  const nav = JSON.parse(navEntries.result.value ?? "[]")[0] ?? null;
  const paints = JSON.parse(paintEntries.result.value ?? "[]");
  const vitals = JSON.parse(vitalsEntry.result.value ?? "{}");
  const fcp = paints.find((p) => p.name === "first-contentful-paint");

  return {
    url,
    wallMs,
    ttfbMs: nav ? nav.responseStart - nav.fetchStart : null,
    fcpMs: fcp ? fcp.startTime : null,
    lcpMs: Number.isFinite(vitals.lcp) ? vitals.lcp : null,
    inpMs: Number.isFinite(vitals.inp) ? vitals.inp : null,
    cls: Number.isFinite(vitals.cls) ? vitals.cls : null,
    longTaskMs: Number.isFinite(vitals.longTaskMs) ? vitals.longTaskMs : null,
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function summarise(vals) {
  const sorted = vals.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error(`REFUSED: no browser found at: ${BROWSER_CANDIDATES.join(", ")}`);
    process.exit(1);
  }

  const reachable = await fetch(LOGIN_URL, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.status < 500)
    .catch(() => false);
  if (!reachable) {
    console.error(`REFUSED: login URL not reachable: ${LOGIN_URL}`);
    process.exit(1);
  }

  const userDataDir = join(tmpdir(), `cdp-auth-${randomBytes(6).toString("hex")}`);
  log(`browser: ${browserPath}`);
  log(`profile: ${PROFILE} | repeat: ${REPEAT} | targets: ${TARGET_URLS.join(", ")}`);

  const proc = spawnBrowser(browserPath, DEBUG_PORT, userDataDir);

  try {
    const wsUrl = await waitForDevTools(DEBUG_PORT, 10_000);
    const browserCdp = await cdpSession(wsUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    browserCdp.close();
    await sleep(300);

    const targets = await fetch(`http://localhost:${DEBUG_PORT}/json/list`).then((r) => r.json());
    const target = targets.find((t) => t.id === targetId);
    if (!target) throw new Error(`target ${targetId} not in /json/list`);

    const cdp = await cdpSession(target.webSocketDebuggerUrl);

    try {
      await applyThrottle(cdp);
      const loggedIn = await login(cdp, LOGIN_URL, USERNAME, PASSWORD);
      if (!loggedIn) {
        console.error("REFUSED: login failed — check credentials or auth flow");
        process.exitCode = 1;
        return;
      }

      const routeResults = {};

      for (const url of TARGET_URLS) {
        const routePath = new URL(url).pathname;
        log(`measuring route: ${routePath}`);
        const samples = [];

        for (let i = 0; i < REPEAT; i++) {
          log(`  navigation ${i + 1}/${REPEAT}`);
          const m = await measureRoute(cdp, url, TIMEOUT_MS);
          log(`  lcp=${m.lcpMs?.toFixed(0) ?? "n/a"}ms inp=${m.inpMs?.toFixed(0) ?? "n/a"}ms cls=${m.cls?.toFixed(3) ?? "n/a"} longTask=${m.longTaskMs?.toFixed(0) ?? "0"}ms`);
          samples.push(m);
          await sleep(500);
        }

        routeResults[routePath] = {
          samples,
          summary: {
            lcp: { p75_ms: summarise(samples.map((s) => s.lcpMs))?.p75 ?? null },
            inp: { p75_ms: summarise(samples.map((s) => s.inpMs))?.p75 ?? null },
            cls: { p75: summarise(samples.map((s) => s.cls))?.p75 ?? null },
            fcp: { p75_ms: summarise(samples.map((s) => s.fcpMs))?.p75 ?? null },
            ttfb: { p95_ms: summarise(samples.map((s) => s.ttfbMs))?.p95 ?? null },
            longTasks: { p75_ms: summarise(samples.map((s) => s.longTaskMs))?.p75 ?? null },
          },
        };
      }

      let existing = {};
      if (existsSync(OUT)) {
        try {
          existing = JSON.parse(readFileSync(OUT, "utf8"));
        } catch {
          /* ignore */
        }
      }

      const result = {
        ...existing,
        generatedAtMs: Date.now(),
        profile: PROFILE,
        loginUrl: LOGIN_URL,
        username: USERNAME,
        authenticated: routeResults,
        conditions: {
          note: "Authenticated measurement — driver logs in then navigates to each route. Vitals reflect the authenticated shell, not the public landing page.",
          profile: PROFILE,
          throttle:
            PROFILE === "mobile"
              ? "4x CPU, 1.6 Mbps down, 750 Kbps up, 150ms RTT (loopback, no network cost)"
              : "No throttling",
        },
      };

      writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
      log(`\nResults written to: ${OUT}`);

      console.log("\n=== Authenticated route vitals ===");
      const BUDGETS = { lcp: 2500, inp: 200, cls: 0.1, fcp: 1800 };
      for (const [route, r] of Object.entries(routeResults)) {
        const s = r.summary;
        console.log(`\n${route} (${PROFILE}):`);
        const lcp = s.lcp.p75_ms;
        const inp = s.inp.p75_ms;
        const cls = s.cls.p75;
        console.log(`  LCP p75   ${lcp?.toFixed(0) ?? "n/a"}ms  ${lcp != null ? (lcp <= BUDGETS.lcp ? "OK" : "BREACH") : "no data"} (budget ${BUDGETS.lcp}ms)`);
        console.log(`  INP p75   ${inp?.toFixed(0) ?? "n/a"}ms  ${inp != null ? (inp <= BUDGETS.inp ? "OK" : "BREACH") : "no data"} (budget ${BUDGETS.inp}ms)`);
        console.log(`  CLS p75   ${cls?.toFixed(3) ?? "n/a"}  ${cls != null ? (cls <= BUDGETS.cls ? "OK" : "BREACH") : "no data"} (budget ${BUDGETS.cls})`);
        console.log(`  longTask p75  ${s.longTasks.p75_ms?.toFixed(0) ?? "0"}ms`);
      }
    } finally {
      cdp.close();
    }
  } finally {
    proc.kill("SIGKILL");
    await sleep(500);
  }
}

main().catch((e) => {
  console.error("AUTH DRIVER FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
