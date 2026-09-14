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
 *   --org-cookie="<name>=<value>"  session for a user who already has a completed org;
 *                                  required for failed-session-refresh, mismatched-session-refresh
 *                                  and no-replay-dashboard; those scenarios are skipped if absent.
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
const ORG_COOKIE = flag("org-cookie", "");
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

const IMPOSTER_SESSION = {
  user: { id: "99999999-0000-0000-0000-000000000001", name: "Imposter", email: "imposter@bad.test" },
  orgId: "ffffffff-0000-0000-0000-000000000001",
  enabledModules: [],
};

const REQUIRED_SCENARIO_IDS = [
  "background-partial",
  "background-dead",
  "background-invalid",
  "background-suppressed",
  "background-retrying",
  "forbidden-403",
  "malformed-body",
  "network-failure",
  "unauthorized-401",
  "pending-deadline",
  "unmount-poll-stop",
  "double-submit-guard",
  "keyboard-retry",
  "no-resubmit-on-recheck",
  "withheld-token",
  "invalid-token",
  "indeterminate-signin",
  "failed-session-refresh",
  "mismatched-session-refresh",
  "no-replay-dashboard",
  "narrow-partial",
  "zoom200-partial",
];

const KNOWN_ACTIONS = new Set([
  "click-build",
  "triple-click",
  "keyboard-retry",
  "navigate-away",
  "no-action",
  "inject-welcome",
]);

let scenarioCtx = {
  statusCount: 0,
  completeCount: 0,
  sessionCount: 0,
  _countBeforeNav: 0,
  _countAfterNav: 0,
};

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

const SESSION_STUB = {
  id: 1,
  type: "org_setup",
  status: "not_started",
  currentStep: null,
  completedSteps: [],
  skippedSteps: [],
  data: {},
};

function backendStub(url) {
  if (url.includes("/org/setup/session"))
    return { success: true, data: SESSION_STUB };
  if (url.includes("/organization/archived"))
    return { success: true, data: [] };
  return { success: true, data: null };
}

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
  {
    name: "unauthorized-401",
    status: 401,
    body: { success: false, message: "Unauthorized" },
    expect: ["Session verification failed"],
  },
  {
    name: "pending-deadline",
    action: "click-build",
    settleMs: 10000,
    responseSequence: [
      {
        status: 200,
        body: statusBody({ orgId: "00000000-0000-4000-8000-000000000001", provisioning: "pending" }),
        repeat: 2,
      },
      {
        status: 200,
        body: statusBody({ orgId: "00000000-0000-4000-8000-000000000002", provisioning: "pending" }),
      },
    ],
    expect: ["Setup is taking longer than expected"],
  },
  {
    name: "unmount-poll-stop",
    action: "navigate-away",
    status: 200,
    body: statusBody({ provisioning: "pending" }),
    expect: [],
  },
  {
    name: "double-submit-guard",
    action: "triple-click",
    status: 200,
    body: statusBody({ provisioning: "pending" }),
    expectedCompleteCount: 1,
    expect: ["Creating organization"],
  },
  {
    name: "keyboard-retry",
    action: "keyboard-retry",
    status: null,
    failWith: "ConnectionFailed",
    expect: ["Connection issue"],
  },
  {
    name: "no-resubmit-on-recheck",
    action: "keyboard-retry",
    status: null,
    failWith: "ConnectionFailed",
    expectedCompleteCount: 1,
    expect: ["Connection issue"],
  },
  {
    name: "withheld-token",
    action: "no-action",
    navigateTo: "/magic-link",
    authSessionIntercept: { status: 200, body: {}, skipFirst: 0 },
    settleMs: 5000,
    expect: ["Link expired", "missing its sign-in token"],
  },
  {
    name: "invalid-token",
    action: "no-action",
    navigateTo: "/magic-link?token=definitely-not-a-real-token-xyz",
    authSessionIntercept: { status: 200, body: {}, skipFirst: 0 },
    settleMs: 5000,
    expect: ["Link expired"],
  },
  {
    name: "indeterminate-signin",
    action: "no-action",
    navigateTo: "/magic-link?token=test-token-xyz-indeterminate",
    authCallbackIntercept: { abort: true },
    authSessionIntercept: { status: 200, body: {}, skipFirst: 0 },
    settleMs: 6000,
    expect: ["Sign-in not confirmed"],
  },
  {
    name: "failed-session-refresh",
    action: "no-action",
    navigateTo: "/dashboard",
    cookieOverride: "org",
    skipIf: "no-org-cookie",
    authSessionIntercept: { status: 500, skipFirst: 1 },
    settleMs: 5000,
    expect: ["No data available"],
  },
  {
    name: "mismatched-session-refresh",
    action: "no-action",
    navigateTo: "/dashboard",
    cookieOverride: "org",
    skipIf: "no-org-cookie",
    authSessionIntercept: { status: 200, body: IMPOSTER_SESSION, skipFirst: 1 },
    settleMs: 5000,
    expect: ["Sign in"],
  },
  {
    name: "no-replay-dashboard",
    action: "inject-welcome",
    cookieOverride: "org",
    skipIf: "no-org-cookie",
    settleMs: 3000,
    expect: [],
  },
  {
    name: "narrow-partial",
    viewport: { width: 375, height: 812, deviceScaleFactor: 1 },
    status: 200,
    body: statusBody({
      ready: false,
      provisioning: "completed",
      errorCode: "SETUP_BACKGROUND_PARTIAL",
      correlationId: "corr-narrow",
    }),
    expect: ["Some optional setup steps didn't finish", "corr-narrow"],
  },
  {
    name: "zoom200-partial",
    viewport: { width: 640, height: 900, deviceScaleFactor: 2 },
    status: 200,
    body: statusBody({
      ready: false,
      provisioning: "completed",
      errorCode: "SETUP_BACKGROUND_PARTIAL",
      correlationId: "corr-zoom200",
    }),
    expect: ["Some optional setup steps didn't finish", "corr-zoom200"],
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

function resolveSequenceEntry(sequence, count) {
  let accumulated = 0;
  for (const entry of sequence) {
    accumulated += entry.repeat ?? Infinity;
    if (count <= accumulated) return entry;
  }
  return sequence[sequence.length - 1];
}

async function applyCookieForScenario(cdp, scenario) {
  const raw = scenario.cookieOverride === "org" ? ORG_COOKIE : COOKIE;
  if (!raw) return;
  const eqIdx = raw.indexOf("=");
  const name = raw.slice(0, eqIdx);
  const value = raw.slice(eqIdx + 1);
  await cdp.send("Network.clearBrowserCookies");
  await cdp.send("Network.setCookie", {
    name,
    value,
    url: BASE_URL,
    path: "/",
    sameSite: "Lax",
    httpOnly: true,
  });
}

async function restoreMainCookie(cdp) {
  if (!COOKIE) return;
  const eqIdx = COOKIE.indexOf("=");
  const name = COOKIE.slice(0, eqIdx);
  const value = COOKIE.slice(eqIdx + 1);
  await cdp.send("Network.clearBrowserCookies");
  await cdp.send("Network.setCookie", {
    name,
    value,
    url: BASE_URL,
    path: "/",
    sameSite: "Lax",
    httpOnly: true,
  });
}

async function captureScenario(cdp, scenario) {
  scenarioCtx = { statusCount: 0, completeCount: 0, sessionCount: 0, _countBeforeNav: 0, _countAfterNav: 0 };

  if (scenario.skipIf === "no-org-cookie" && !ORG_COOKIE) {
    console.log(`SKIP ${scenario.name} (no --org-cookie)`);
    return { name: scenario.name, matched: true, skipped: true, missing: [], textLength: 0 };
  }

  if (scenario.cookieOverride) {
    await applyCookieForScenario(cdp, scenario);
  }

  if (scenario.viewport) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: scenario.viewport.width,
      height: scenario.viewport.height,
      deviceScaleFactor: scenario.viewport.deviceScaleFactor,
      mobile: false,
    });
  }

  const action = scenario.action ?? "click-build";
  const settleMs = scenario.settleMs ?? SETTLE_MS;

  try {
    if (action === "no-action") {
      const dest = scenario.navigateTo ? `${BASE_URL}${scenario.navigateTo}` : `${BASE_URL}/org-setup`;
      await cdp.send("Page.navigate", { url: dest });
      await sleep(settleMs);
    } else if (action === "inject-welcome") {
      await cdp.send("Page.navigate", { url: `${BASE_URL}/dashboard` });
      await sleep(1500);
      await cdp.send("Runtime.evaluate", {
        expression: 'try { sessionStorage.setItem("org-setup-welcome-pending","1") } catch(e) {}',
        returnByValue: false,
      });
      await cdp.send("Page.navigate", { url: `${BASE_URL}/dashboard` });
      await sleep(settleMs);
    } else if (action === "navigate-away") {
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
      await sleep(3000);
      scenarioCtx._countBeforeNav = scenarioCtx.statusCount;
      await cdp.send("Page.navigate", { url: `${BASE_URL}/signin` });
      await sleep(6000);
      scenarioCtx._countAfterNav = scenarioCtx.statusCount;
    } else if (action === "triple-click") {
      await cdp.send("Page.navigate", { url: `${BASE_URL}/org-setup` });
      await sleep(2500);
      await seedWizardLocalStorage(cdp);
      await cdp.send("Page.navigate", { url: `${BASE_URL}/org-setup` });
      await sleep(2000);
      await cdp.send("Runtime.evaluate", {
        expression: `(function() {
          const btn = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('Build my organization'));
          if (!btn) return;
          btn.click(); btn.click(); btn.click();
        })()`,
        returnByValue: false,
      });
      await sleep(settleMs);
    } else if (action === "keyboard-retry") {
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
      await sleep(3000);
      await cdp.send("Runtime.evaluate", {
        expression: `(function() {
          const btn = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('Check again'));
          if (!btn) return false;
          btn.focus();
          btn.click();
          return true;
        })()`,
        returnByValue: false,
      });
      await sleep(Math.max(0, settleMs - 3000));
    } else {
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
      await sleep(settleMs);
    }
  } finally {
    if (scenario.viewport) {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
    }
    if (scenario.cookieOverride) {
      await restoreMainCookie(cdp);
    }
  }

  const { result: textResult } = await cdp.send("Runtime.evaluate", {
    expression: "document.body.innerText",
    returnByValue: true,
  });
  const text = typeof textResult?.value === "string" ? textResult.value : "";

  const { result: urlResult } = await cdp.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true,
  });
  const finalUrl = urlResult?.value ?? "";

  const missing = scenario.expect.filter((needle) => !text.includes(needle));

  if (action === "navigate-away") {
    const newRequests = scenarioCtx._countAfterNav - scenarioCtx._countBeforeNav;
    if (newRequests > 1) {
      missing.push(`poll-did-not-stop: ${newRequests} status GETs after unmount`);
    }
  }

  if (action === "inject-welcome") {
    const keyResult = await cdp.send("Runtime.evaluate", {
      expression: 'sessionStorage.getItem("org-setup-welcome-pending")',
      returnByValue: true,
    });
    if (keyResult.result?.value !== null) {
      missing.push("welcome-key-not-consumed: key still present after dashboard load");
    }
    if (!finalUrl.includes("/dashboard")) {
      missing.push(`expected-url-dashboard: got ${finalUrl}`);
    }
  }

  if (scenario.expectedCompleteCount !== undefined && scenarioCtx.completeCount !== scenario.expectedCompleteCount) {
    missing.push(
      `complete-count: expected ${scenario.expectedCompleteCount} got ${scenarioCtx.completeCount}`,
    );
  }

  if (missing.length > 0) {
    const snippet = text.slice(0, 400).replace(/\n+/g, " ").trim();
    console.error(`  [${scenario.name}] url=${finalUrl} text="${snippet}"`);
  }

  return { name: scenario.name, matched: missing.length === 0, missing, textLength: text.length };
}

function selfTest() {
  const names = new Set();
  for (const scenario of SCENARIOS) {
    if (names.has(scenario.name)) throw new Error(`duplicate scenario ${scenario.name}`);
    names.add(scenario.name);

    const action = scenario.action ?? "click-build";
    if (!KNOWN_ACTIONS.has(action))
      throw new Error(`${scenario.name} has unknown action "${action}"`);

    const allowsEmptyExpect = action === "navigate-away" || action === "inject-welcome";
    if (!Array.isArray(scenario.expect) || (scenario.expect.length === 0 && !allowsEmptyExpect && !scenario.skipIf))
      throw new Error(`${scenario.name} asserts nothing`);

    const hasResponseDef =
      scenario.responseSequence !== undefined ||
      scenario.status !== undefined ||
      scenario.authCallbackIntercept !== undefined ||
      scenario.authSessionIntercept !== undefined ||
      scenario.navigateTo !== undefined ||
      scenario.cookieOverride !== undefined;
    if (!hasResponseDef)
      throw new Error(`${scenario.name} has no response definition or navigation target`);

    if (scenario.responseSequence !== undefined) {
      if (!Array.isArray(scenario.responseSequence) || scenario.responseSequence.length === 0)
        throw new Error(`${scenario.name} responseSequence is empty`);
      for (const entry of scenario.responseSequence) {
        if (entry.status === undefined && !entry.failWith)
          throw new Error(`${scenario.name} responseSequence entry missing status and failWith`);
        if (entry.status !== null && entry.status !== undefined) {
          const decoded = JSON.parse(
            Buffer.from(encodeBody(entry.body ?? {}), "base64").toString("utf8"),
          );
          if (typeof decoded !== "object" || decoded === null)
            throw new Error(`${scenario.name} responseSequence entry does not encode to object`);
        }
      }
    }

    if (scenario.status !== null && scenario.status !== undefined && !scenario.responseSequence) {
      const decoded = JSON.parse(Buffer.from(encodeBody(scenario.body), "base64").toString("utf8"));
      if (typeof decoded !== "object" || decoded === null)
        throw new Error(`${scenario.name} does not encode to an object`);
    }

    if (scenario.status === null && !scenario.failWith && !scenario.responseSequence)
      throw new Error(`${scenario.name} has null status but no failWith or responseSequence`);

    if (scenario.viewport !== undefined) {
      const { width, height, deviceScaleFactor } = scenario.viewport;
      if (!Number.isFinite(width) || width <= 0)
        throw new Error(`${scenario.name} viewport.width invalid`);
      if (!Number.isFinite(height) || height <= 0)
        throw new Error(`${scenario.name} viewport.height invalid`);
      if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0)
        throw new Error(`${scenario.name} viewport.deviceScaleFactor invalid`);
    }

    if (scenario.authSessionIntercept !== undefined) {
      const { status } = scenario.authSessionIntercept;
      if (!Number.isFinite(status) || status < 100)
        throw new Error(`${scenario.name} authSessionIntercept.status invalid`);
    }
  }

  for (const id of REQUIRED_SCENARIO_IDS) {
    if (!names.has(id)) throw new Error(`required scenario "${id}" not present in SCENARIOS`);
  }

  for (const code of [
    "SETUP_BACKGROUND_PARTIAL",
    "SETUP_BACKGROUND_DEAD",
    "SETUP_BACKGROUND_INVALID",
    "SETUP_BACKGROUND_SUPPRESSED",
    "SETUP_BACKGROUND_RETRYING",
  ]) {
    const covered =
      SCENARIOS.some((s) => s.body?.data?.errorCode === code) ||
      SCENARIOS.some((s) =>
        s.responseSequence?.some((e) => e.body?.data?.errorCode === code),
      );
    if (!covered) throw new Error(`no scenario covers ${code}`);
  }

  for (const httpStatus of [401, 403]) {
    if (!SCENARIOS.some((s) => s.status === httpStatus))
      throw new Error(`no scenario covers HTTP ${httpStatus}`);
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
      path: "/",
      sameSite: "Lax",
      httpOnly: true,
    });
    await cdp.send("Fetch.enable", {
      patterns: [
        { urlPattern: `*${BACKEND_HOST}*`, requestStage: "Request" },
        { urlPattern: `*${STATUS_PATH}*`, requestStage: "Request" },
        { urlPattern: `*${COMPLETE_PATH}*`, requestStage: "Request" },
        { urlPattern: "*/api/auth/callback/*", requestStage: "Request" },
        { urlPattern: "*/api/auth/session*", requestStage: "Request" },
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

        if (url.includes("/api/auth/callback/") && active.authCallbackIntercept?.abort) {
          await cdp.send("Fetch.failRequest", {
            requestId: params.requestId,
            errorReason: "ConnectionRefused",
          });
          return;
        }

        if (url.includes("/api/auth/session") && active.authSessionIntercept) {
          scenarioCtx.sessionCount++;
          const skip = active.authSessionIntercept.skipFirst ?? 1;
          if (scenarioCtx.sessionCount <= skip) {
            await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
            return;
          }
          const { status, body } = active.authSessionIntercept;
          const isJson = status === 200;
          await cdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: status,
            responseHeaders: [
              { name: "content-type", value: isJson ? "application/json" : "text/plain" },
            ],
            body: isJson && body
              ? encodeBody(body)
              : Buffer.from("Internal Server Error", "utf8").toString("base64"),
          });
          return;
        }

        if (url.includes("/api/auth/")) {
          await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
          return;
        }

        if (url.includes(COMPLETE_PATH)) {
          scenarioCtx.completeCount++;
          await cdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "application/json" }, ...CORS_HEADERS],
            body: encodeBody(completeBody()),
          });
          return;
        }

        if (url.includes(STATUS_PATH)) {
          scenarioCtx.statusCount++;
          if (active.responseSequence) {
            const entry = resolveSequenceEntry(active.responseSequence, scenarioCtx.statusCount);
            if (entry.failWith) {
              await cdp.send("Fetch.failRequest", {
                requestId: params.requestId,
                errorReason: entry.failWith,
              });
            } else {
              await cdp.send("Fetch.fulfillRequest", {
                requestId: params.requestId,
                responseCode: entry.status,
                responseHeaders: [{ name: "content-type", value: "application/json" }, ...CORS_HEADERS],
                body: encodeBody(entry.body),
              });
            }
            return;
          }
          if (active.status === null) {
            await cdp.send("Fetch.failRequest", {
              requestId: params.requestId,
              errorReason: active.failWith,
            });
            return;
          }
          if (active.status !== undefined) {
            await cdp.send("Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: active.status,
              responseHeaders: [{ name: "content-type", value: "application/json" }, ...CORS_HEADERS],
              body: encodeBody(active.body),
            });
            return;
          }
          await cdp.send("Fetch.continueRequest", { requestId: params.requestId });
          return;
        }

        if (url.includes(BACKEND_HOST)) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "application/json" }, ...CORS_HEADERS],
            body: encodeBody(backendStub(url)),
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
  for (const result of results) {
    if (result.skipped) {
      console.log(`SKIP ${result.name}`);
      continue;
    }
    console.log(
      `${result.matched ? "OK  " : "MISS"} ${result.name}` +
        (result.matched ? "" : ` — absent: ${result.missing.join(" | ")}`),
    );
  }
  const decisive = results.filter((r) => !r.skipped);
  process.exitCode = decisive.every((r) => r.matched) ? 0 : 1;
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
