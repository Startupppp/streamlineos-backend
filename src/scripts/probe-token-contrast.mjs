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
const AA_MIN = 4.5;

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(2)}s] ${m}`);
const results = [];
let failures = 0;

function record(id, verdict, detail) {
  if (verdict === "FAIL") failures += 1;
  results.push({ id, verdict, detail });
  console.log(`  ${verdict}  [${id}] ${detail}`);
}

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

async function spawnBrowser(debugPort) {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error("No Chrome/Edge found");
  const userDataDir = join(tmpdir(), `cdp-contrast-${randomBytes(4).toString("hex")}`);
  const proc = spawn(
    browserPath,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--no-sandbox",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-first-run",
      "--disable-gpu",
      "--window-size=1280,800",
    ],
    { stdio: "pipe" },
  );
  const wsUrl = await waitForDevTools(debugPort);
  return { proc, wsUrl };
}

async function evaluate(cdp, expression) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.value;
}

const MEASURE = `(() => {
  const srgb = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); };
  const paint = (color, over) => {
    const cv = document.createElement("canvas");
    cv.width = 1; cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = over; ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const opaqueBg = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      const probe = paint(bg, "rgb(255,255,255)");
      const m = bg.match(/rgba?\\(([^)]+)\\)/);
      const alpha = m ? (m[1].split(",")[3] !== undefined ? parseFloat(m[1].split(",")[3]) : 1) : 1;
      if (bg && bg !== "transparent" && alpha > 0.95) return probe;
      n = n.parentElement;
    }
    return [255, 255, 255];
  };
  const out = { kbd: null, danger: null, href: location.href };
  const kbd = document.querySelector("header kbd") || document.querySelector("kbd");
  if (kbd) {
    const bg = opaqueBg(kbd);
    const fg = paint(getComputedStyle(kbd).color, "rgb(" + bg.join(",") + ")");
    out.kbd = { text: (kbd.textContent || "").trim().slice(0, 8), fg, bg, ratio: ratio(fg, bg) };
  }
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-9999px;background:var(--status-danger-fill);color:#fff";
  document.body.appendChild(probe);
  const dbg = paint(getComputedStyle(probe).backgroundColor, "rgb(255,255,255)");
  const dfg = paint(getComputedStyle(probe).color, "rgb(" + dbg.join(",") + ")");
  out.danger = { fg: dfg, bg: dbg, ratio: ratio(dfg, dbg) };
  probe.remove();
  return JSON.stringify(out);
})()`;

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

    browser = await spawnBrowser(9331);
    cdp = await cdpSession(browser.wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await cdp.send("Page.navigate", {
      url: `${FRONTEND_URL}/magic-link?token=${encodeURIComponent(rawToken)}`,
    });
    await sleep(9000);

    const sessionRaw = await evaluate(
      cdp,
      "fetch('/api/auth/session').then(r => r.json()).then(d => JSON.stringify(d))",
    );
    let session = {};
    try {
      session = JSON.parse(sessionRaw ?? "{}");
    } catch {
      /* ignore */
    }
    const landed = await evaluate(cdp, "location.href");
    const authed =
      typeof landed === "string" &&
      !landed.includes("/signin") &&
      !landed.includes("/magic-link") &&
      !landed.includes("/employee-onboarding") &&
      !!session.backendJwt &&
      (session.enabledModules?.length ?? 0) > 0;
    if (!authed) {
      record(
        "PRECONDITION-AUTH",
        "NOT-RUN",
        `landed=${landed} backendJwt=${!!session.backendJwt} modules=${session.enabledModules?.length ?? 0} — not an authenticated shell, so no cell is recordable`,
      );
      return;
    }
    record(
      "PRECONDITION-AUTH",
      "PASS",
      `authenticated shell at ${landed}, backendJwt present, ${session.enabledModules.length} modules`,
    );

    await cdp.send("Page.navigate", { url: `${FRONTEND_URL}/dashboard` });
    await sleep(7000);

    const raw = await evaluate(cdp, MEASURE);
    const measured = JSON.parse(raw);

    if (!measured.kbd) {
      record("KBD-CONTRAST", "NOT-RUN", "no <kbd> element found in the header on /dashboard");
    } else {
      const r = measured.kbd.ratio;
      record(
        "KBD-CONTRAST",
        r >= AA_MIN ? "PASS" : "FAIL",
        `header <kbd> "${measured.kbd.text}" composited fg=rgb(${measured.kbd.fg.join(",")}) on bg=rgb(${measured.kbd.bg.join(",")}) = ${r.toFixed(2)}:1 against the ${AA_MIN}:1 AA minimum (was 3.55:1 at /50 before the /65 source fix)`,
      );
    }

    const dr = measured.danger.ratio;
    record(
      "STATUS-DANGER-FILL-CONTRAST",
      dr >= AA_MIN ? "PASS" : "FAIL",
      `--status-danger-fill resolved to rgb(${measured.danger.bg.join(",")}) with white text = ${dr.toFixed(2)}:1 against the ${AA_MIN}:1 AA minimum (was 3.76:1 at red-500 before the red-600 source fix)`,
    );
  } finally {
    if (cdp) cdp.close();
    if (browser?.proc) browser.proc.kill();
    await sql`DELETE FROM magic_link_tokens WHERE token_hash = ${hashToken(rawToken)}`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => {
    const notRun = results.filter((r) => r.verdict === "NOT-RUN").length;
    console.log(
      `\nRESULT: ${results.filter((r) => r.verdict === "PASS").length} PASS / ${failures} FAIL / ${notRun} NOT-RUN`,
    );
    process.exit(failures > 0 || notRun > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error(`probe crashed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
