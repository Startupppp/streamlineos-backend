/**
 * CDP browser driver for p95-browser-cached-read and p75-first-useful-view.
 *
 * Launches the system Chrome or Edge in headless mode, connects over the Chrome
 * DevTools Protocol using Node's built-in WebSocket, navigates to the target URL,
 * and measures navigation timing and First Contentful Paint from the browser's own
 * performance timeline.
 *
 * Requirements: a browser at BROWSER_PATH and the target app reachable at TARGET_URL.
 * Writes results to .browser-driver-results.json.
 *
 * Run: node src/scripts/browser-driver.mjs [--self-test] [--url=http://localhost:1000]
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const TARGET_URL = flag("url", "http://localhost:1000");
const OUT = resolve(process.cwd(), flag("out", ".browser-driver-results.json"));
const REPEAT = Number(flag("repeat", "5"));
const TIMEOUT_MS = Number(flag("timeout", "15000"));
const DEBUG_PORT = Number(flag("debug-port", "9222"));

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

function findBrowser() {
  for (const p of BROWSER_CANDIDATES)
    if (existsSync(p)) return p;
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnBrowser(browserPath, debugPort, userDataDir) {
  const args = [
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
  ];
  return spawn(browserPath, args, { stdio: "pipe" });
}

async function waitForDevToolsEndpoint(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://localhost:${debugPort}/json/version`);
      if (resp.ok) {
        const data = await resp.json();
        return data.webSocketDebuggerUrl;
      }
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`Chrome DevTools endpoint not ready after ${timeoutMs}ms`);
}

async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  const events = new Map();

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
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
      const listeners = events.get(msg.method);
      if (listeners) for (const l of listeners) l(msg.params);
    }
  };

  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, (msg) =>
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function on(event, listener) {
    if (!events.has(event)) events.set(event, []);
    events.get(event).push(listener);
  }

  function close() {
    ws.close();
  }

  return { send, on, close };
}

async function navigateAndMeasure(cdp, url, timeoutMs) {
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Runtime.enable");

  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));

  const navStart = Date.now();
  await cdp.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(timeoutMs)]);
  const wallMs = Date.now() - navStart;

  const navEntries = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(performance.getEntriesByType("navigation").map(e => ({
      fetchStart: e.fetchStart, responseStart: e.responseStart,
      domContentLoadedEventEnd: e.domContentLoadedEventEnd,
      loadEventEnd: e.loadEventEnd, transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize
    })))`,
    returnByValue: true,
  });
  const paintEntries = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(performance.getEntriesByType("paint").map(e => ({name: e.name, startTime: e.startTime})))`,
    returnByValue: true,
  });

  const nav = JSON.parse(navEntries.result.value ?? "[]")[0] ?? null;
  const paints = JSON.parse(paintEntries.result.value ?? "[]");
  const fcp = paints.find((p) => p.name === "first-contentful-paint");
  const fp = paints.find((p) => p.name === "first-paint");

  return {
    wallMs,
    ttfbMs: nav ? nav.responseStart - nav.fetchStart : null,
    domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
    loadEventMs: nav ? nav.loadEventEnd : null,
    transferSizeBytes: nav ? nav.transferSize : null,
    fromCache: nav ? nav.transferSize === 0 : null,
    fcpMs: fcp ? fcp.startTime : null,
    fpMs: fp ? fp.startTime : null,
  };
}

async function measureBrowser(browserPath, targetUrl, repeat, timeoutMs) {
  const userDataDir = join(tmpdir(), `cdp-${randomBytes(6).toString("hex")}`);
  log(`launching browser: ${browserPath}`);
  log(`user-data-dir: ${userDataDir}`);

  const proc = spawnBrowser(browserPath, DEBUG_PORT, userDataDir);
  let wsUrl;

  try {
    wsUrl = await waitForDevToolsEndpoint(DEBUG_PORT, 10_000);
    log(`DevTools endpoint: ${wsUrl}`);

    // Create a new page target via CDP (avoids /json/new which Chrome warns about)
    const browserCdp = await cdpSession(wsUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    browserCdp.close();
    await sleep(300);

    // Fetch the target's WebSocket URL from /json/list
    const listResp = await fetch(`http://localhost:${DEBUG_PORT}/json/list`);
    const listText = await listResp.text();
    const targets = JSON.parse(listText);
    const target = targets.find((t) => t.id === targetId);
    if (!target) throw new Error(`target ${targetId} not found in /json/list`);
    const targetWs = target.webSocketDebuggerUrl;
    const cdp = await cdpSession(targetWs);

    try {
      const samples = [];
      for (let i = 0; i < repeat; i++) {
        log(`navigation ${i + 1}/${repeat}: ${targetUrl}`);
        const m = await navigateAndMeasure(cdp, targetUrl, timeoutMs);
        log(`  wall=${m.wallMs}ms ttfb=${m.ttfbMs?.toFixed(0) ?? "n/a"}ms fcp=${m.fcpMs?.toFixed(0) ?? "n/a"}ms cache=${m.fromCache}`);
        samples.push(m);
        await sleep(500);
      }
      return samples;
    } finally {
      cdp.close();
    }
  } finally {
    proc.kill("SIGKILL");
    await sleep(500);
  }
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

function summariseMetric(samples, key) {
  const vals = samples.map((s) => s[key]).filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return null;
  return {
    count: vals.length,
    p50: percentile(vals, 50),
    p75: percentile(vals, 75),
    p95: percentile(vals, 95),
    min: vals[0],
    max: vals[vals.length - 1],
  };
}

async function selfTest() {
  log("self-test: starting a minimal HTTP server on port 9870 and measuring with browser");
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error("SELF-TEST FAIL: no browser found at any candidate path");
    process.exitCode = 1;
    return;
  }

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!DOCTYPE html><html><body><h1>CDPtest</h1><script>performance.mark('app-ready')</script></body></html>");
  });
  server.listen(9870);
  await sleep(200);

  try {
    const samples = await measureBrowser(browserPath, "http://localhost:9870", 3, 5000);
    const ttfbs = samples.map((s) => s.ttfbMs).filter((v) => v !== null && Number.isFinite(v));
    if (ttfbs.length === 0) {
      console.error("SELF-TEST FAIL: no TTFB samples collected");
      process.exitCode = 1;
      return;
    }
    console.log(`SELF-TEST PASS: ${ttfbs.length} navigation(s), min TTFB=${Math.min(...ttfbs).toFixed(1)}ms — the browser driver can measure`);
  } finally {
    server.close();
  }
}

async function main() {
  if (SELF_TEST) return selfTest();

  const browserPath = findBrowser();
  if (!browserPath) {
    const msg = `no browser found at candidate paths: ${BROWSER_CANDIDATES.join(", ")}`;
    console.error(`REFUSED: ${msg}`);
    process.exitCode = 1;
    return;
  }

  log(`target: ${TARGET_URL}`);
  log(`browser: ${browserPath}`);
  log(`repeat: ${REPEAT} navigations`);

  let reachable = false;
  try {
    const r = await fetch(TARGET_URL, { signal: AbortSignal.timeout(3000) });
    reachable = r.status < 500;
  } catch {
    reachable = false;
  }

  if (!reachable) {
    const msg = `target ${TARGET_URL} is not reachable — boot the frontend before running this driver`;
    console.error(`REFUSED: ${msg}`);
    writeFileSync(OUT, JSON.stringify({ error: msg, generatedAtMs: Date.now() }, null, 2), "utf8");
    process.exitCode = 1;
    return;
  }

  const samples = await measureBrowser(browserPath, TARGET_URL, REPEAT, TIMEOUT_MS);

  const wallSummary = summariseMetric(samples, "wallMs");
  const ttfbSummary = summariseMetric(samples, "ttfbMs");
  const fcpSummary = summariseMetric(samples, "fcpMs");

  const cachedSamples = samples.slice(1);
  const cachedWall = summariseMetric(cachedSamples, "wallMs");
  const cachedTtfb = summariseMetric(cachedSamples, "ttfbMs");

  const result = {
    generatedAtMs: Date.now(),
    targetUrl: TARGET_URL,
    browserPath,
    repeat: REPEAT,
    conditions: {
      geography: "localhost — not the PRD reference geography (same-region reference device/network)",
      device: "developer machine running headless Chrome/Edge",
      network: "loopback — not the PRD reference network",
      note: "All measurements are from localhost to a local app server. The PRD's reference is a same-region browser client on a declared device and network. These figures show the product structure (parse time, render time, JS execution) without network cost.",
    },
    samples,
    allNavigations: {
      wallMs: wallSummary,
      ttfbMs: ttfbSummary,
      fcpMs: fcpSummary,
    },
    cachedNavigations: {
      note: "First navigation excluded — subsequent navigations benefit from browser memory cache of static assets",
      count: cachedSamples.length,
      wallMs: cachedWall,
      ttfbMs: cachedTtfb,
    },
    objectives: {
      "p95-browser-cached-read": {
        target: 150,
        unit: "ms same-region reference device",
        measured: cachedTtfb?.p95 ?? cachedWall?.p95 ?? null,
        metric: "TTFB on navigations 2+, or wall time if TTFB unavailable",
        verdict: (() => {
          const v = cachedTtfb?.p95 ?? cachedWall?.p95 ?? null;
          if (v === null) return "NOT_DRIVEN";
          return v <= 150 ? "MET" : "BREACHED";
        })(),
        conditions:
          "localhost loopback — not the PRD's declared reference geography. Zero network cost; this is the product's own processing time for a cached page response.",
      },
      "p75-first-useful-view": {
        target: 1000,
        unit: "ms reference device and network",
        measured: fcpSummary?.p75 ?? wallSummary?.p75 ?? null,
        metric: "First Contentful Paint p75, or wall time to load event if FCP unavailable",
        verdict: (() => {
          const v = fcpSummary?.p75 ?? wallSummary?.p75 ?? null;
          if (v === null) return "NOT_DRIVEN";
          return v <= 1000 ? "MET" : "BREACHED";
        })(),
        conditions:
          "localhost loopback — not the PRD's declared reference geography. Page navigated to login redirect. FCP is the browser's own measurement of when the first pixel was painted.",
      },
    },
  };

  writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");

  console.log("\nBrowser driver results\n");
  for (const [name, obj] of Object.entries(result.objectives)) {
    const m = obj.measured;
    console.log(
      `${obj.verdict.padEnd(11)} ${name.padEnd(38)} ` +
        (m !== null ? `${m.toFixed(1)}ms target=${obj.target}ms` : "no measurement") +
        ` [${obj.conditions.slice(0, 50)}...]`,
    );
  }
  console.log(`\nresults: ${OUT}`);
}

main().catch((e) => {
  console.error("BROWSER DRIVER FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
