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

import { writeFileSync, readFileSync, existsSync } from "node:fs";
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
const PROFILE = flag("profile", "desktop");

if (!new Set(["desktop", "mobile"]).has(PROFILE)) {
  console.error(`REFUSED: --profile must be desktop or mobile, received ${PROFILE}`);
  process.exit(1);
}

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
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      if (window.__streamlineVitals) return;
      const state = { lcp: null, cls: 0, inp: null, longTaskMs: 0 };
      Object.defineProperty(window, "__streamlineVitals", { value: state });
      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) state.lcp = last.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            if (!entry.hadRecentInput) state.cls += entry.value;
        }).observe({ type: "layout-shift", buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            if (entry.interactionId && (state.inp === null || entry.duration > state.inp))
              state.inp = entry.duration;
        }).observe({ type: "event", buffered: true, durationThreshold: 16 });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) state.longTaskMs += entry.duration;
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    })();`,
  });

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

  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));

  const navStart = Date.now();
  await cdp.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(timeoutMs)]);
  await sleep(250);
  const targetEntry = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const element = document.querySelector('button[type="button"], [role="button"], input:not([type="submit"])');
      if (!element) return { x: 1, y: 1 };
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })())`,
    returnByValue: true,
  });
  const interactionTarget = JSON.parse(targetEntry.result.value ?? '{"x":1,"y":1}');
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: interactionTarget.x, y: interactionTarget.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: interactionTarget.x, y: interactionTarget.y, button: "left", clickCount: 1 });
  await sleep(250);
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

  const resourceEntries = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(performance.getEntriesByType("resource").map(e => ({
      name: e.name, duration: e.duration, transferSize: e.transferSize,
      decodedBodySize: e.decodedBodySize
    })))`,
    returnByValue: true,
  });
  const vitalsEntry = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(window.__streamlineVitals ?? {})`,
    returnByValue: true,
  });

  const nav = JSON.parse(navEntries.result.value ?? "[]")[0] ?? null;
  const resources = JSON.parse(resourceEntries.result.value ?? "[]");
  const cachedResources = resources.filter(
    (r) => r.transferSize === 0 && r.decodedBodySize > 0,
  );
  const paints = JSON.parse(paintEntries.result.value ?? "[]");
  const vitals = JSON.parse(vitalsEntry.result.value ?? "{}");
  const fcp = paints.find((p) => p.name === "first-contentful-paint");
  const fp = paints.find((p) => p.name === "first-paint");
  const resourceTotals = resources.reduce((totals, resource) => {
    const kind = resource.name.includes("/_next/static/") && resource.name.includes(".js")
      ? "javascript"
      : resource.name.includes(".woff")
        ? "font"
        : /\.(?:png|jpe?g|webp|avif|gif|svg)(?:\?|$)/i.test(resource.name)
          ? "image"
          : "other";
    totals[kind].transferSizeBytes += resource.transferSize ?? 0;
    totals[kind].decodedBodySizeBytes += resource.decodedBodySize ?? 0;
    totals[kind].durationMs += resource.duration ?? 0;
    totals[kind].count++;
    return totals;
  }, {
    javascript: { count: 0, transferSizeBytes: 0, decodedBodySizeBytes: 0, durationMs: 0 },
    font: { count: 0, transferSizeBytes: 0, decodedBodySizeBytes: 0, durationMs: 0 },
    image: { count: 0, transferSizeBytes: 0, decodedBodySizeBytes: 0, durationMs: 0 },
    other: { count: 0, transferSizeBytes: 0, decodedBodySizeBytes: 0, durationMs: 0 },
  });

  return {
    wallMs,
    ttfbMs: nav ? nav.responseStart - nav.fetchStart : null,
    domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
    loadEventMs: nav ? nav.loadEventEnd : null,
    transferSizeBytes: nav ? nav.transferSize : null,
    fromCache: nav ? nav.transferSize === 0 : null,
    cachedResourceCount: cachedResources.length,
    cachedResourceMaxMs: cachedResources.length
      ? Math.max(...cachedResources.map((r) => r.duration))
      : null,
    fcpMs: fcp ? fcp.startTime : null,
    fpMs: fp ? fp.startTime : null,
    lcpMs: Number.isFinite(vitals.lcp) ? vitals.lcp : null,
    inpMs: Number.isFinite(vitals.inp) ? vitals.inp : null,
    cls: Number.isFinite(vitals.cls) ? vitals.cls : null,
    longTaskMs: Number.isFinite(vitals.longTaskMs) ? vitals.longTaskMs : null,
    renderAfterFcpMs: nav && fcp ? Math.max(0, nav.loadEventEnd - fcp.startTime) : null,
    resources: resourceTotals,
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
    res.end("<!DOCTYPE html><html><body><h1>CDPtest</h1><button type=\"button\">Measure</button><script>document.querySelector('button').onclick=()=>{const end=performance.now()+20;while(performance.now()<end){}};performance.mark('app-ready')</script></body></html>");
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
    const lcps = samples.map((s) => s.lcpMs).filter((v) => v !== null && Number.isFinite(v));
    const inps = samples.map((s) => s.inpMs).filter((v) => v !== null && Number.isFinite(v));
    if (lcps.length !== samples.length || inps.length !== samples.length) {
      console.error(`SELF-TEST FAIL: vital coverage lcp=${lcps.length}/${samples.length} inp=${inps.length}/${samples.length}`);
      process.exitCode = 1;
      return;
    }
    console.log(`SELF-TEST PASS: ${ttfbs.length} navigation(s), LCP and INP captured, min TTFB=${Math.min(...ttfbs).toFixed(1)}ms`);
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
  const lcpSummary = summariseMetric(samples, "lcpMs");
  const inpSummary = summariseMetric(samples, "inpMs");
  const clsSummary = summariseMetric(samples, "cls");
  const longTaskSummary = summariseMetric(samples, "longTaskMs");
  const renderAfterFcpSummary = summariseMetric(samples, "renderAfterFcpMs");

  const cachedSamples = samples
    .slice(1)
    .filter((s) => s.fromCache === true || (s.cachedResourceCount ?? 0) > 0);
  const cachedWall = summariseMetric(cachedSamples, "wallMs");
  const cachedTtfb = summariseMetric(cachedSamples, "ttfbMs");
  const cachedResourceReplays = cachedSamples.reduce(
    (total, s) => total + (s.cachedResourceCount ?? 0),
    0,
  );

  let previous = {};
  if (existsSync(OUT)) {
    try {
      previous = JSON.parse(readFileSync(OUT, "utf8"));
    } catch {
      previous = {};
    }
  }

  const profileResult = {
    lcp: { p75_ms: lcpSummary?.p75 ?? null },
    inp: { p75_ms: inpSummary?.p75 ?? null },
    cls: { p75: clsSummary?.p75 ?? null },
    fcp: { p75_ms: fcpSummary?.p75 ?? null },
    ttfb: { p95_ms: ttfbSummary?.p95 ?? null },
    longTasks: { p75_ms: longTaskSummary?.p75 ?? null },
    renderAfterFcp: { p75_ms: renderAfterFcpSummary?.p75 ?? null },
  };

  const result = {
    ...previous,
    generatedAtMs: Date.now(),
    targetUrl: TARGET_URL,
    browserPath,
    repeat: REPEAT,
    [PROFILE]: profileResult,
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
      note: "A sample counts as cached only when the browser reported it as cached — the navigation document had transferSize 0, or the navigation replayed at least one subresource from cache (transferSize 0 with a non-zero decoded body). Being the second navigation is not evidence of caching and is not accepted as such.",
      count: cachedSamples.length,
      documentServedFromCache: cachedSamples.some((s) => s.fromCache === true),
      cachedResourceReplays,
      wallMs: cachedWall,
      ttfbMs: cachedTtfb,
    },
    objectives: {
      "p95-browser-cached-read": {
        target: 150,
        unit: "ms same-region reference device",
        measured: cachedTtfb?.p95 ?? null,
        metric: `browser-visible TTFB on warm-cache navigations, corroborated by ${cachedResourceReplays} subresource replays the browser itself reported as cached (transferSize 0, non-zero decoded body). The authenticated navigation document is deliberately no-store, so it is never HTTP-cached and its TTFB is a server read with warm caches rather than a cache replay. Subresource replay durations are not used as the figure: they round to 0 ms and would report a meaninglessly favourable number.`,
        verdict: (() => {
          const v = cachedTtfb?.p95 ?? null;
          if (v === null) return "NOT_DRIVEN";
          return v <= 150 ? "MET" : "BREACHED";
        })(),
        conditions:
          "localhost loopback — not the PRD's declared reference geography, so this carries zero network cost and is a floor rather than a comparable figure. Reported only from samples the browser itself marked cached.",
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
