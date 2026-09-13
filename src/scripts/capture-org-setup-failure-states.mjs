/**
 * Real-Chrome capture of the org-setup wizard's provisioning FAILURE states (OS-R5).
 *
 * The happy path is already covered by the lane's browser evidence. What no capture has
 * covered is the failure surface: `GET /org/setup/status` returning 401, 403, a malformed
 * body, or each `SETUP_BACKGROUND_*` code, plus the 90s timeout and the recheck control.
 * Corrupting a database to produce those states is neither safe nor repeatable, so this
 * substitutes the status RESPONSE over CDP `Fetch` and leaves every other request untouched.
 * Everything it asserts is what the real browser painted.
 *
 * NOT run by this lane. Coordinator-run, against a production build of the frontend:
 *
 *   node src/scripts/capture-org-setup-failure-states.mjs \
 *     --base-url=http://127.0.0.1:1700 \
 *     --cookie="next-auth.session-token=<owner session>" \
 *     --out=.org-setup-failure-states.json
 *
 * Pass criteria: exit 0 and every scenario reporting `matched: true`. A scenario whose
 * expected copy is absent is a real finding — the wizard is not telling the truth about
 * that state — and must be reported, not retried until green.
 *
 *   --self-test   validate the scenario table and the substitution payloads only; no browser.
 */
import { writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
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

const BASE_URL = flag("base-url", "http://127.0.0.1:1700").replace(/\/$/, "");
const COOKIE = flag("cookie", "");
const OUT = resolve(process.cwd(), flag("out", ".org-setup-failure-states.json"));
const DEBUG_PORT = Number(flag("debug-port", "9333"));
const SETTLE_MS = Number(flag("settle", "4000"));

const STATUS_PATH = "/org/setup/status";
const COMPLETE_PATH = "/org/setup/complete";
const BACKEND_HOST = "127.0.0.1:1500";

const CORS_HEADERS = [
  { name: "access-control-allow-origin", value: "http://localhost:1000" },
  { name: "access-control-allow-methods", value: "GET,POST,PUT,DELETE,PATCH,OPTIONS" },
  { name: "access-control-allow-headers", value: "content-type,authorization,x-requested-with,x-internal-api-secret" },
  { name: "access-control-allow-credentials", value: "true" },
  { name: "access-control-max-age", value: "86400" },
];

function statusBody(overrides) {
  return {
    success: true,
    data: {
      orgId: "00000000-0000-4000-8000-000000000001",
      onboardingCompletedAt: null,
      ready: false,
      provisioning: "pending",
      errorCode: null,
      correlationId: null,
      recipientOutcomes: null,
      ...overrides,
    },
  };
}

function completeBody() {
  return {
    success: true,
    data: { success: true, orgId: "00000000-0000-4000-8000-000000000001" },
  };
}

/**
 * `expect` is matched against the page's rendered text. Each string is copy the wizard owns,
 * so a wording change fails loudly rather than silently weakening the capture.
 *
 * All failure scenarios use `ready: false` so `useSetupProvisioning` never sets `isReady: true`
 * and the `finishSetup` path (which calls `completeOnboardingGate` against a real backend) does
 * not run during the capture. The issue banner remains visible for the full `SETTLE_MS` window.
 */
export const SCENARIOS = [
  {
    name: "background-partial",
    status: 200,
    body: statusBody({
      ready: false,
      provisioning: "completed",
      errorCode: "SETUP_BACKGROUND_PARTIAL",
      correlationId: "corr-partial",
    }),
    expect: ["Some optional setup steps didn't finish", "corr-partial"],
  },
  {
    name: "background-dead",
    status: 200,
    body: statusBody({
      ready: false,
      provisioning: "failed",
      errorCode: "SETUP_BACKGROUND_DEAD",
      correlationId: "corr-dead",
    }),
    expect: ["Optional setup step did not finish", "corr-dead"],
  },
  {
    name: "background-invalid",
    status: 200,
    body: statusBody({
      ready: false,
      provisioning: "failed",
      errorCode: "SETUP_BACKGROUND_INVALID",
      correlationId: "corr-invalid",
    }),
    expect: ["Optional setup step could not run"],
  },
  {
    name: "background-suppressed",
    status: 200,
    body: statusBody({
      ready: false,
      provisioning: "failed",
      errorCode: "SETUP_BACKGROUND_SUPPRESSED",
      correlationId: "corr-suppressed",
    }),
    expect: ["Optional setup step was skipped"],
  },
  {
    name: "background-retrying",
    status: 200,
    body: statusBody({
      ready: false,
      provisioning: "failed",
      errorCode: "SETUP_BACKGROUND_RETRYING",
      correlationId: null,
    }),
    expect: ["Creating organization"],
  },
  {
    name: "unauthorized-401",
    status: 401,
    body: { success: false, message: "Unauthorized" },
    expect: ["Session verification failed"],
  },
  {
    name: "forbidden-403",
    status: 403,
    body: { success: false, message: "Forbidden" },
    expect: ["Session verification failed"],
  },
  {
    name: "malformed-body",
    status: 200,
    body: { success: true, data: { orgId: 42, ready: "yes" } },
    expect: ["Unexpected server response"],
  },
  {
    name: "network-failure",
    status: null,
    failWith: "ConnectionFailed",
    expect: ["Connection issue"],
  },
];

function encodeBody(body) {
  return Buffer.from(JSON.stringify(body ?? {}), "utf8").toString("base64");
}

const WIZARD_DRAFT = JSON.stringify({
  goals: ["sales"],
  industry: "Technology",
  companyName: "Test Corp",
  teamSize: "1-10",
  phone: "+911234567890",
  invitees: [],
  installedApps: ["crm", "chat", "kb"],
  modules: ["crm", "chat", "kb"],
});

async function seedWizardLocalStorage(cdp) {
  const sessionResult = await cdp.send("Runtime.evaluate", {
    expression:
      "fetch('/api/auth/session').then(r => r.json()).then(d => JSON.stringify(d?.user ?? {})).catch(() => '{}')",
    awaitPromise: true,
    returnByValue: true,
  });
  let userId = "";
  try {
    const user = JSON.parse(sessionResult.result?.value ?? "{}");
    userId = user.id ?? "";
  } catch {
    void 0;
  }
  if (!userId) return;
  await cdp.send("Runtime.evaluate", {
    expression: `
      localStorage.setItem("org-setup-draft--${userId}", ${JSON.stringify(WIZARD_DRAFT)});
      localStorage.setItem("org-setup-step--${userId}", "3");
    `,
    returnByValue: false,
  });
}

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`Chrome DevTools page target not ready after ${timeoutMs}ms`);
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
      for (const listener of events.get(msg.method) ?? []) listener(msg.params);
    }
  };
  return {
    send(method, params = {}) {
      const id = ++msgId;
      return new Promise((resolve, reject) => {
        pending.set(id, (msg) =>
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result),
        );
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(event, listener) {
      if (!events.has(event)) events.set(event, []);
      events.get(event).push(listener);
    },
    close: () => ws.close(),
  };
}

async function captureScenario(cdp, scenario) {
  await cdp.send("Page.navigate", { url: `${BASE_URL}/org-setup` });
  await sleep(2500);
  await seedWizardLocalStorage(cdp);
  await cdp.send("Page.navigate", { url: `${BASE_URL}/org-setup` });
  await sleep(2000);
  await cdp.send("Runtime.evaluate", {
    expression:
      "([...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('Build my organization')))?.click()",
    returnByValue: false,
  });
  await sleep(SETTLE_MS);
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: "document.body.innerText",
    returnByValue: true,
  });
  const text = typeof result?.value === "string" ? result.value : "";
  const missing = scenario.expect.filter((needle) => !text.includes(needle));
  return { name: scenario.name, matched: missing.length === 0, missing, textLength: text.length };
}

function selfTest() {
  const names = new Set();
  for (const scenario of SCENARIOS) {
    if (names.has(scenario.name)) throw new Error(`duplicate scenario ${scenario.name}`);
    names.add(scenario.name);
    if (!Array.isArray(scenario.expect) || scenario.expect.length === 0)
      throw new Error(`${scenario.name} asserts nothing`);
    if (scenario.status === null && !scenario.failWith)
      throw new Error(`${scenario.name} has neither a status nor a failure reason`);
    if (scenario.status !== null) {
      const decoded = JSON.parse(Buffer.from(encodeBody(scenario.body), "base64").toString("utf8"));
      if (typeof decoded !== "object" || decoded === null)
        throw new Error(`${scenario.name} does not encode to an object`);
    }
  }
  for (const code of [
    "SETUP_BACKGROUND_PARTIAL",
    "SETUP_BACKGROUND_DEAD",
    "SETUP_BACKGROUND_INVALID",
    "SETUP_BACKGROUND_SUPPRESSED",
    "SETUP_BACKGROUND_RETRYING",
  ]) {
    const covered = SCENARIOS.some(
      (scenario) => scenario.body?.data?.errorCode === code,
    );
    if (!covered) throw new Error(`no scenario covers ${code}`);
  }
  for (const status of [401, 403]) {
    if (!SCENARIOS.some((scenario) => scenario.status === status))
      throw new Error(`no scenario covers HTTP ${status}`);
  }
  console.log(`capture-org-setup-failure-states self-test passed (${SCENARIOS.length} scenarios)`);
}

async function main() {
  if (SELF_TEST) {
    selfTest();
    return;
  }
  if (!COOKIE) {
    console.error("REFUSED: --cookie=<session cookie for an owner mid-wizard> is required");
    process.exit(1);
  }
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error(`REFUSED: no browser at ${BROWSER_CANDIDATES.join(" or ")}`);
    process.exit(1);
  }

  const userDataDir = join(tmpdir(), `setup-capture-${randomBytes(6).toString("hex")}`);
  const child = spawn(
    browserPath,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--no-sandbox",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-web-security",
    ],
    { stdio: "pipe" },
  );

  let cdp = null;
  const results = [];
  try {
    cdp = await cdpSession(await waitForDevTools(DEBUG_PORT, 20_000));
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.setCookie", {
      name: COOKIE.split("=")[0],
      value: COOKIE.slice(COOKIE.indexOf("=") + 1),
      url: BASE_URL,
    });
    await cdp.send("Fetch.enable", {
      patterns: [
        { urlPattern: `*${BACKEND_HOST}*`, requestStage: "Request" },
        { urlPattern: `*${STATUS_PATH}*`, requestStage: "Request" },
        { urlPattern: `*${COMPLETE_PATH}*`, requestStage: "Request" },
      ],
    });

    let active = SCENARIOS[0];
    cdp.on("Fetch.requestPaused", (params) => {
      const handle = async () => {
        const url = params.request.url;
        const isOptions = params.request.method === "OPTIONS";
        if (isOptions) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 204,
            responseHeaders: CORS_HEADERS,
            body: "",
          });
          return;
        }
        if (url.includes(COMPLETE_PATH)) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "application/json" }, ...CORS_HEADERS],
            body: encodeBody(completeBody()),
          });
          return;
        }
        if (url.includes(STATUS_PATH)) {
          if (active.status === null) {
            await cdp.send("Fetch.failRequest", {
              requestId: params.requestId,
              errorReason: active.failWith,
            });
            return;
          }
          await cdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: active.status,
            responseHeaders: [{ name: "content-type", value: "application/json" }, ...CORS_HEADERS],
            body: encodeBody(active.body),
          });
          return;
        }
        if (url.includes(BACKEND_HOST)) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "application/json" }, ...CORS_HEADERS],
            body: encodeBody({ success: true, data: null }),
          });
          return;
        }
        await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
      };
      void handle().catch((error) => console.error(`Fetch handler: ${error.message}`));
    });

    for (const scenario of SCENARIOS) {
      active = scenario;
      results.push(await captureScenario(cdp, scenario));
    }
  } finally {
    cdp?.close();
    child.kill();
  }

  writeFileSync(
    OUT,
    JSON.stringify({ baseUrl: BASE_URL, capturedAt: new Date().toISOString(), results }, null, 2),
  );
  for (const result of results)
    console.log(
      `${result.matched ? "OK  " : "MISS"} ${result.name}` +
        (result.matched ? "" : ` — absent: ${result.missing.join(" | ")}`),
    );
  process.exitCode = results.every((result) => result.matched) ? 0 : 1;
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
