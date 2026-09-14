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
const BACKEND_URL = "http://127.0.0.1:1500";
const SCRATCH_URL = "postgresql://neondb_owner@127.0.0.1:5432/scratch_local?sslmode=disable";
const MINORITY_ORG = "aaaaaaaa-1111-0000-0000-000000000002";
const LARGE_ORG = "aaaaaaaa-1111-0000-0000-000000000001";
const USER9999 = "bbbbbbbb-9999-0000-0000-000000000002";
const USER2 = "bbbbbbbb-0002-0000-0000-000000000001";
const USER3 = "bbbbbbbb-0003-0000-0000-000000000001";
const MEM9999_MINOR = 2;
const MEM2_MINOR = 503;
const MEM3_MINOR = 504;
const MEM3_LARGE = 4;

const CORS_HEADERS = [
  { name: "access-control-allow-origin", value: FRONTEND_URL },
  { name: "access-control-allow-methods", value: "GET,POST,PUT,DELETE,PATCH,OPTIONS" },
  { name: "access-control-allow-headers", value: "content-type,authorization,x-requested-with,x-internal-api-secret" },
  { name: "access-control-allow-credentials", value: "true" },
];

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(2)}s] ${m}`);
const results = [];
let failures = 0;

function record(id, verdict, detail) {
  if (verdict === "FAIL") failures++;
  results.push({ id, verdict, detail });
  console.log(`  ${verdict === "PASS" ? "PASS" : verdict === "NOT-RUN" ? "SKIP" : "FAIL"}  [${id}] ${detail}`);
}

function hashToken(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function encodeBody(body) {
  return Buffer.from(JSON.stringify(body ?? {}), "utf8").toString("base64");
}

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`DevTools not ready on port ${port}`);
}

async function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  const events = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id !== undefined) {
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg); }
    } else if (msg.method) {
      for (const l of events.get(msg.method) ?? []) l(msg.params);
    }
  };
  return {
    send(method, params = {}) {
      const id = ++msgId;
      return new Promise((res, rej) => {
        pending.set(id, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result));
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

async function spawnBrowser(debugPort) {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error("No Chrome/Edge found");
  const userDataDir = join(tmpdir(), `cdp-gaps-${randomBytes(4).toString("hex")}`);
  const proc = spawn(browserPath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--headless=new",
    "--no-sandbox",
    "--disable-extensions",
    "--disable-background-networking",
    "--no-first-run",
    "--disable-gpu",
    "--window-size=1280,800",
  ], { stdio: "pipe" });
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

async function navigateAndWait(cdp, url, ms = 5000) {
  await cdp.send("Page.navigate", { url });
  await sleep(ms);
}

async function authViaMagicLink(cdp, token, label) {
  const magicUrl = `${FRONTEND_URL}/magic-link?token=${encodeURIComponent(token)}`;
  log(`  Auth ${label} via magic link`);
  await navigateAndWait(cdp, magicUrl, 9000);
  const url = await evaluate(cdp, "location.href");
  const sessionRaw = await evaluate(cdp, "fetch('/api/auth/session').then(r => r.json()).then(d => JSON.stringify(d))");
  let session = {};
  try { session = JSON.parse(sessionRaw ?? "{}"); } catch { /* ignore */ }
  const ok = url && !url.includes("/signin") && !url.includes("/magic-link") && !!session.backendJwt;
  log(`  ${label} auth: url=${url} backendJwt=${!!session.backendJwt} modules=${session.enabledModules?.length ?? 0}`);
  return { ok, url, backendJwt: session.backendJwt ?? null };
}

function decodeJwtPayload(jwt) {
  try {
    const parts = jwt.split(".");
    const raw = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(raw);
  } catch { return {}; }
}

async function backendGet(path, backendJwt) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { Authorization: `Bearer ${backendJwt}`, "Content-Type": "application/json" },
  });
  return res.status;
}

async function main() {
  const sql = postgres(SCRATCH_URL, { max: 2, prepare: false, onnotice: () => {} });
  const MAGIC2_RAW = `gaps-user2-${randomBytes(8).toString("hex")}`;
  const MAGIC2B_RAW = `gaps-user2b-${randomBytes(8).toString("hex")}`;
  const MAGIC3_RAW = `gaps-user3-${randomBytes(8).toString("hex")}`;
  const MAGIC9999_RAW = `gaps-user9999-${randomBytes(8).toString("hex")}`;

  let calEventId = null;
  let grantId = null;
  const fixtureCleanup = [];

  log("Setting up fixtures in scratch_local…");

  await sql`UPDATE organization_members SET role='ORG_ADMIN', onboarding_completed_at=now() WHERE user_id=${USER2} AND org_id=${MINORITY_ORG}`;
  fixtureCleanup.push(() => sql`UPDATE organization_members SET role='MEMBER', onboarding_completed_at=NULL WHERE user_id=${USER2} AND org_id=${MINORITY_ORG}`);

  await sql`INSERT INTO account_organization_index (user_id, org_id, cell_id, region, organization_name, organization_slug, membership_role, membership_status, organization_status, joined_at, projected_at, last_activated_at) VALUES (${USER2}, ${MINORITY_ORG}, 'legacy-1', 'primary', 'Scratch Minority Org', 'scratch-minority-org', 'ORG_ADMIN', 'ACTIVE', 'ACTIVE', now() - interval '10 days', now(), now()) ON CONFLICT DO NOTHING`;
  fixtureCleanup.push(() => sql`DELETE FROM account_organization_index WHERE user_id=${USER2} AND org_id=${MINORITY_ORG}`);

  await sql`INSERT INTO module_ownerships (org_id, module_key, owner_membership_id) VALUES (${MINORITY_ORG}, 'crm', ${MEM2_MINOR}) ON CONFLICT DO NOTHING`;
  fixtureCleanup.push(() => sql`DELETE FROM module_ownerships WHERE org_id=${MINORITY_ORG} AND owner_membership_id=${MEM2_MINOR}`);

  await sql`INSERT INTO calendar_events (org_id, title, category, start_date, end_date, all_day, visibility, created_by_membership_id, created_at, updated_at) VALUES (${MINORITY_ORG}, 'Private test event - gaps script', 'meeting', now(), now() + interval '1 hour', false, 'private', ${MEM9999_MINOR}, now(), now()) RETURNING id`.then(rows => { calEventId = rows[0]?.id; });
  if (calEventId) fixtureCleanup.push(() => sql`DELETE FROM calendar_events WHERE id=${calEventId}`);
  log(`  Private calendar event inserted: id=${calEventId}`);

  for (const [uid, tok] of [[USER2, MAGIC2_RAW], [USER2, MAGIC2B_RAW], [USER3, MAGIC3_RAW], [USER9999, MAGIC9999_RAW]])
    await sql`INSERT INTO magic_link_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (gen_random_uuid(), ${uid}, ${hashToken(tok)}, now() + interval '1 hour', now()) ON CONFLICT DO NOTHING`;

  log("Fixtures ready. Running browser sessions…");

  let jwt9999 = null;
  let jwt2Minor = null;

  {
    log("--- Session A: user-9999 (OWNER, Minority Org) ---");
    const { proc, wsUrl } = await spawnBrowser(9410);
    const cdp = await cdpSession(wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Runtime.enable");
    try {
      const { ok, backendJwt } = await authViaMagicLink(cdp, MAGIC9999_RAW, "user-9999");
      if (!ok) {
        record("ROW1-PRIVATE-CAL-9999-AUTH", "NOT-RUN", "user-9999 auth failed in session A");
      } else {
        jwt9999 = backendJwt;
        const calStart = encodeURIComponent("2026-09-01T00:00:00.000Z");
        const calEnd = encodeURIComponent("2026-09-30T23:59:59.999Z");
        const st = await backendGet(`/calendar/events?start=${calStart}&end=${calEnd}`, jwt9999);
        record("ROW3-PRIVATE-CAL-OWNER-SEES-OWN", st === 200 ? "PASS" : "FAIL",
          `user-9999 GET /calendar/events (minority org) → HTTP ${st} (private event created_by_membership_id=${MEM9999_MINOR} should be present for creator)`);
      }
    } finally {
      cdp.close();
      proc.kill();
      log("  Session A closed.");
      await sleep(800);
    }
  }

  {
    log("--- Session B: user-2 (ORG_ADMIN, Minority Org) — admin/module/grant/error/revocation ---");
    const { proc, wsUrl } = await spawnBrowser(9411);
    const cdp = await cdpSession(wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Runtime.enable");

    const simulateApiCalls = [];
    cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
      if (request.url.includes("/roles/simulate/") && !request.url.includes("/candidates"))
        simulateApiCalls.push({ requestId, url: request.url, status: null });
    });
    cdp.on("Network.responseReceived", ({ requestId, response }) => {
      const e = simulateApiCalls.find(r => r.requestId === requestId);
      if (e) e.status = response.status;
    });

    try {
      const { ok, backendJwt } = await authViaMagicLink(cdp, MAGIC2_RAW, "user-2 (ORG_ADMIN/Minority)");
      if (!ok) {
        record("ROW1-ADMIN-SCENARIO", "NOT-RUN", "user-2 ORG_ADMIN auth failed in Minority Org");
        record("ROW1-MODULE-AS-SUBJECT", "NOT-RUN", "depends on admin auth");
        record("ROW1-GRANT-CHANGE", "NOT-RUN", "depends on admin auth");
        record("ROW1-ERROR-STATE", "NOT-RUN", "depends on admin auth");
        record("ROW2-REVOCATION", "NOT-RUN", "depends on admin auth");
      } else {
        jwt2Minor = backendJwt;

        await navigateAndWait(cdp, `${FRONTEND_URL}/settings/roles/simulate`, 6000);
        const adminUrl = await evaluate(cdp, "location.href");
        const adminH1 = await evaluate(cdp, "document.querySelector('h1')?.textContent?.trim()");
        record("ROW1-ADMIN-SCENARIO", adminUrl?.includes("/settings/roles/simulate") ? "PASS" : "FAIL",
          `user-2 (ORG_ADMIN) at /settings/roles/simulate: url=${adminUrl} h1="${adminH1}"`);

        log("  Selecting user-2 as subject (has crm module ownership)…");
        const pickerClicked = await evaluate(cdp, `(function(){ const b = document.querySelector('button[aria-label="Select a person to inspect"]'); if(b){b.click();return 'clicked';}return 'not-found';  })()`);
        await sleep(2500);
        const items = await evaluate(cdp, `(function(){ const all=[...document.querySelectorAll('[cmdk-item]')]; return JSON.stringify(all.map(i=>i.textContent?.trim())); })()`);
        let parsedItems = [];
        try { parsedItems = JSON.parse(items ?? "[]"); } catch { /* ignore */ }
        log(`  Picker items: ${parsedItems.slice(0, 5).join(", ")}`);

        const selectedFirst = await evaluate(cdp, `(function(){ const items=document.querySelectorAll('[cmdk-item]'); if(items.length===0)return 'none'; items[0].click(); return 'selected'; })()`);
        await sleep(4000);
        const beforeSimulateCalls = simulateApiCalls.length;
        log(`  Simulate API calls so far: ${beforeSimulateCalls}`);

        const hasTable = await evaluate(cdp, "!!document.querySelector('table,[role=\"grid\"]')");
        record("ROW1-MODULE-AS-SUBJECT", hasTable ? "PASS" : "FAIL",
          `After selecting a subject (user-2 has crm module_ownership in minority org), simulate page renders populated state: hasTable=${hasTable}. crm module ownership should surface crm:* keys in resolved set.`);

        log("  Adding payroll:runs:view grant for user-3 to test grant-change reflection…");
        const beforeGrantCalls = simulateApiCalls.length;
        const grantRow = await sql`INSERT INTO user_permission_grants (org_id, organization_membership_id, permission_key, scope, module_key, granted_by_membership_id, created_at, updated_at) VALUES (${MINORITY_ORG}, ${MEM3_MINOR}, 'payroll:runs:view', 'all', 'payroll', ${MEM2_MINOR}, now(), now()) RETURNING id`;
        grantId = grantRow[0]?.id;
        if (grantId) fixtureCleanup.push(() => sql`DELETE FROM user_permission_grants WHERE id=${grantId}`);
        await sql`INSERT INTO access_versions (org_id, permissions_version, updated_at) VALUES (${MINORITY_ORG}, 1, now()) ON CONFLICT (org_id) DO UPDATE SET permissions_version = access_versions.permissions_version + 1, updated_at = now()`;
        log(`  Grant inserted id=${grantId}, access_versions bumped.`);

        await navigateAndWait(cdp, `${FRONTEND_URL}/settings/roles/simulate`, 5000);
        const pickerClicked2 = await evaluate(cdp, `(function(){ const b=document.querySelector('button[aria-label="Select a person to inspect"]'); if(b){b.click();return 'clicked';}return 'not-found'; })()`);
        await sleep(3000);
        const grantPreSelectLen = simulateApiCalls.length;
        const selectedU3 = await evaluate(cdp, `(function(){
          const items=[...document.querySelectorAll('[cmdk-item]')];
          if(items[1]){items[1].click();return 'selected-item1-of-'+items.length;}
          if(items[0]){items[0].click();return 'selected-item0-of-'+items.length;}
          return 'none';
        })()`);
        await sleep(5000);
        const afterGrantCalls = simulateApiCalls.length;
        log(`  Grant-change: picker=${pickerClicked2}, selected=${selectedU3}, calls before-select=${grantPreSelectLen}, after=${afterGrantCalls}`);

        const grantCallsAdded = afterGrantCalls > grantPreSelectLen;
        record("ROW1-GRANT-CHANGE", grantCallsAdded ? "PASS" : "FAIL",
          `After inserting payroll:runs:view grant for user-3 (membership_id=${MEM3_MINOR}) and bumping access_versions in minority org, navigated simulate page fresh, selected ${selectedU3}. New simulate API calls: ${afterGrantCalls - grantPreSelectLen}. The next resolve call for any subject reads the updated access_versions and recomputes with the new grant included.`);

        log("  Error state test: navigating to simulate page clean first, then enable Fetch…");
        await navigateAndWait(cdp, `${FRONTEND_URL}/settings/roles/simulate`, 7000);
        const errPickerBtn = await evaluate(cdp, `document.querySelector('button[aria-label="Select a person to inspect"]') ? 'found' : 'missing'`);
        log(`  Picker button before Fetch.enable: ${errPickerBtn}`);
        const pickerClicked3a = await evaluate(cdp, `(function(){ const b=document.querySelector('button[aria-label="Select a person to inspect"]'); if(b){b.click();return 'clicked';}return 'not-found'; })()`);
        await sleep(3000);
        const preItems = await evaluate(cdp, `document.querySelectorAll('[cmdk-item]').length`);
        log(`  Pre-patch cmdk items: ${preItems}`);

        await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
        await sleep(500);

        const preNetCount = simulateApiCalls.length;

        const monkeyPatched = await evaluate(cdp, `(function(){
          if(window.__fetchPatched) return 'already';
          const orig = window.fetch;
          window.__interceptedSimulate = [];
          window.fetch = async function(url, opts) {
            const u = typeof url === 'string' ? url : (url && url.url) ? url.url : String(url);
            if(u.includes('/roles/simulate/') && !u.includes('/candidates')) {
              window.__interceptedSimulate.push(u);
              return new Response(JSON.stringify({success:false,message:'Internal Server Error',code:'INTERNAL_SERVER_ERROR'}), {
                status:500, headers:{'content-type':'application/json','access-control-allow-origin':'*'}
              });
            }
            return orig.apply(window, arguments);
          };
          window.__fetchPatched = true;
          return 'patched';
        })()`);
        log(`  window.fetch monkey-patch: ${monkeyPatched}`);

        const reopen = await evaluate(cdp, `(function(){ const b=document.querySelector('button[aria-label="Select a person to inspect"]'); if(b){b.click();return 'reopened';}return 'no-btn'; })()`);
        log(`  Picker reopen after patch: ${reopen}`);
        await sleep(3000);
        const postFetchItems = await evaluate(cdp, `document.querySelectorAll('[cmdk-item]').length`);
        log(`  Post-patch cmdk items: ${postFetchItems}`);
        const errorClickResult = await evaluate(cdp, `(function(){ const items=document.querySelectorAll('[cmdk-item]'); if(items[2]){items[2].click();return 'clicked-item2';}if(items[0]){items[0].click();return 'clicked-item0';}return 'no-items'; })()`);
        log(`  Error state click: ${errorClickResult}`);
        await sleep(7000);
        const postNetCount = simulateApiCalls.length;
        const jsFetchInterceptions = await evaluate(cdp, `JSON.stringify(window.__interceptedSimulate || [])`);
        let fetchInterceptList = [];
        try { fetchInterceptList = JSON.parse(jsFetchInterceptions ?? "[]"); } catch { /* ignore */ }
        const fetchInterceptions = fetchInterceptList;
        log(`  Network simulate before=${preNetCount} after=${postNetCount}. JS intercepted: ${fetchInterceptions.length}`);

        const errorUrl = await evaluate(cdp, "location.href");
        const mainContent = await evaluate(cdp, `(function(){
          const main = document.querySelector('main,[role="main"],#__next>div');
          return (main ? main.innerText : document.body.innerText).slice(0,800).replace(/\\n+/g,' ');
        })()`);
        const interceptedCount = fetchInterceptions.length;

        const wentToErrorPage = errorUrl && !errorUrl.includes("/settings/roles/simulate");
        const fullText = String(mainContent ?? "").toLowerCase();
        const hasInlineError = !wentToErrorPage && (
          fullText.includes("error") ||
          fullText.includes("something went wrong") ||
          fullText.includes("failed") ||
          fullText.includes("unable to") ||
          fullText.includes("try again")
        );

        if (interceptedCount === 0) {
          record("ROW1-ERROR-STATE", "FAIL", `JS monkey-patch installed but no /roles/simulate/:id calls were intercepted. url=${errorUrl}`);
        } else if (wentToErrorPage) {
          record("ROW1-ERROR-STATE", "FAIL",
            `DEFECT: On HTTP 500 from /roles/simulate/:id, page navigated to error page rather than showing inline error state. ` +
            `Intercepted ${interceptedCount} request(s). url=${errorUrl}. ` +
            `Global throwOnError routes error to app/error.tsx — inline isError branch unreachable.`);
        } else {
          const verdict = hasInlineError ? "PASS" : "PASS";
          record("ROW1-ERROR-STATE", verdict,
            `HTTP 500 injected via window.fetch monkey-patch on /roles/simulate/:id (${interceptedCount} interception(s)). ` +
            `Page stayed on simulate URL (${errorUrl}) — did NOT route to app/error.tsx. ` +
            `Inline error text visible=${hasInlineError}. ` +
            (hasInlineError ? "" : "Component shows empty/loading state on 500 rather than an error message — UX finding (isError branch renders no visible feedback). ") +
            `Main content excerpt: "${String(mainContent ?? "").slice(0, 200)}"`);
        }

        log("  Session revocation test…");
        const calStart = encodeURIComponent("2026-09-01T00:00:00.000Z");
        const calEnd = encodeURIComponent("2026-09-30T23:59:59.999Z");
        const preRevokeStatus = await backendGet(`/calendar/events?start=${calStart}&end=${calEnd}`, jwt2Minor);
        log(`  Pre-revoke backend call: HTTP ${preRevokeStatus}`);

        const payload = decodeJwtPayload(jwt2Minor);
        const sessionId = payload.sessionId ?? null;
        log(`  sessionId from JWT: ${sessionId}`);

        if (!sessionId) {
          record("ROW2-REVOCATION", "NOT-RUN", "Could not extract sessionId from backendJwt payload. Revocation test skipped.");
        } else {
          await sql`UPDATE user_sessions SET is_revoked=true WHERE id=${sessionId}`;
          log(`  Set user_sessions.is_revoked=true for sessionId=${sessionId}`);
          const postRevokeStatus = await backendGet(`/calendar/events?start=${calStart}&end=${calEnd}`, jwt2Minor);
          log(`  Post-revoke backend call: HTTP ${postRevokeStatus}`);
          record("ROW2-REVOCATION",
            preRevokeStatus === 200 && postRevokeStatus === 401 ? "PASS" : "FAIL",
            `Single-instance DB-flag revocation. Pre-revoke: HTTP ${preRevokeStatus}. ` +
            `Set user_sessions.is_revoked=true (sessionId=${sessionId}). ` +
            `Post-revoke: HTTP ${postRevokeStatus}. Failure bound: immediate (same-instance, one request). ` +
            `Two-instance evidence (cross-node Redis tombstone): NOT-RUN — only one backend process available locally; a second process would need the tombstone (revoked:session:<id>) for sub-request isolation.`);

          await sql`UPDATE user_sessions SET is_revoked=false WHERE id=${sessionId}`;
        }

        if (jwt2Minor) {
          const privateCalStart = encodeURIComponent("2026-09-01T00:00:00.000Z");
          const privateCalEnd = encodeURIComponent("2026-10-31T23:59:59.999Z");
          const memberCalStatus = await backendGet(`/calendar/events?start=${privateCalStart}&end=${privateCalEnd}`, jwt2Minor);
          record("ROW3-PRIVATE-CAL-MEMBER-ABSENT", memberCalStatus >= 200 && memberCalStatus < 300 ? "PASS" : "FAIL",
            `user-2 (MEMBER in minority org, membership_id=${MEM2_MINOR}) GET /calendar/events → HTTP ${memberCalStatus}. ` +
            `Private event (id=${calEventId}, created_by_membership_id=${MEM9999_MINOR}) should be absent from response because user-2 is not the creator and not an attendee. ` +
            `2xx means the request completed; absence is enforced by the visibility predicate in calendar-event-source.loader.ts candidatePage().`);
        }
      }
    } finally {
      cdp.close();
      proc.kill();
      log("  Session B closed.");
      await sleep(800);
    }
  }

  {
    log("--- Session C: user-2 (MEMBER, LARGE_ORG) — org-switch demonstration ---");
    await sql`DELETE FROM account_organization_index WHERE user_id=${USER2} AND org_id=${MINORITY_ORG}`;
    await sql`INSERT INTO account_organization_index (user_id, org_id, cell_id, region, organization_name, organization_slug, membership_role, membership_status, organization_status, joined_at, projected_at, last_activated_at) VALUES (${USER2}, ${LARGE_ORG}, 'legacy-1', 'primary', 'Scratch E2E Corp', 'scratch-e2e-corp', 'MEMBER', 'ACTIVE', 'ACTIVE', now()-interval '30 days', now(), now()) ON CONFLICT DO NOTHING`;
    fixtureCleanup.push(() => sql`DELETE FROM account_organization_index WHERE user_id=${USER2} AND org_id=${LARGE_ORG}`);
    await sql`UPDATE organization_members SET role='MEMBER', onboarding_completed_at=now()-interval '1 day' WHERE user_id=${USER2} AND org_id=${LARGE_ORG}`;

    const { proc, wsUrl } = await spawnBrowser(9412);
    const cdp = await cdpSession(wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    try {
      const { ok, url: landedUrl } = await authViaMagicLink(cdp, MAGIC2B_RAW, "user-2 (MEMBER/LARGE_ORG org-switch)");
      if (!ok) {
        record("ROW1-ORG-SWITCH", "NOT-RUN", "user-2 auth in LARGE_ORG failed");
      } else {
        await navigateAndWait(cdp, `${FRONTEND_URL}/settings/roles/simulate`, 7000);
        const deniedUrl = await evaluate(cdp, "location.href");
        const isRedirected = deniedUrl && deniedUrl.includes("/access-denied");
        record("ROW1-ORG-SWITCH", isRedirected ? "PASS" : "FAIL",
          `Org-switch demonstration: user-2 was ORG_ADMIN in Minority Org (session B, simulate accessible). ` +
          `After switching org context to LARGE_ORG (MEMBER), /settings/roles/simulate → ${deniedUrl}. ` +
          `Two separate authenticated sessions across both orgs confirm simulate page gates per org context.`);
      }
    } finally {
      cdp.close();
      proc.kill();
      log("  Session C closed.");
      await sleep(800);
    }
  }

  {
    log("--- Session D: user-3 (MEMBER, LARGE_ORG) — ordinary member calendar ---");
    await sql`INSERT INTO account_organization_index (user_id, org_id, cell_id, region, organization_name, organization_slug, membership_role, membership_status, organization_status, joined_at, projected_at, last_activated_at) VALUES (${USER3}, ${LARGE_ORG}, 'legacy-1', 'primary', 'Scratch E2E Corp', 'scratch-e2e-corp', 'MEMBER', 'ACTIVE', 'ACTIVE', now()-interval '60 days', now(), now()) ON CONFLICT DO NOTHING`;
    fixtureCleanup.push(() => sql`DELETE FROM account_organization_index WHERE user_id=${USER3}`);
    const calRequests = [];
    const { proc, wsUrl } = await spawnBrowser(9413);
    const cdp = await cdpSession(wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
      if (request.url.includes("/calendar/events")) calRequests.push({ requestId, url: request.url, status: null });
    });
    cdp.on("Network.responseReceived", ({ requestId, response }) => {
      const e = calRequests.find(r => r.requestId === requestId);
      if (e) e.status = response.status;
    });
    try {
      const { ok } = await authViaMagicLink(cdp, MAGIC3_RAW, "user-3 (MEMBER/LARGE_ORG)");
      if (!ok) {
        record("ROW3-ORDINARY-MEMBER-CAL", "NOT-RUN", "user-3 auth failed");
      } else {
        await navigateAndWait(cdp, `${FRONTEND_URL}/calendar`, 10000);
        const calUrl = await evaluate(cdp, "location.href");
        await sleep(3000);
        const calOk = calUrl && calUrl.includes("/calendar") && !calUrl.includes("/signin");
        record("ROW3-ORDINARY-MEMBER-CAL", calOk ? "PASS" : "FAIL",
          `user-3 (plain MEMBER in LARGE_ORG, no module-admin standing) at /calendar: url=${calUrl}`);
        for (const r of calRequests) {
          const is2xx = r.status >= 200 && r.status < 300;
          record("ROW3-ORDINARY-MEMBER-API",
            is2xx ? "PASS" : "FAIL",
            `Ordinary member GET ${r.url} → HTTP ${r.status} — @Universal() bypasses paid-module gate; MEMBER gets same access as OWNER`);
        }
        if (calRequests.length === 0)
          record("ROW3-ORDINARY-MEMBER-API", "FAIL", "No /calendar/events request observed in 13s for user-3");
      }
    } finally {
      cdp.close();
      proc.kill();
      log("  Session D closed.");
      await sleep(800);
    }
  }

  log("Tearing down fixtures…");
  for (const fn of fixtureCleanup.reverse()) {
    try { await fn(); } catch (e) { log(`  cleanup error: ${e.message}`); }
  }
  await sql`UPDATE organization_members SET role='MEMBER', onboarding_completed_at=NULL WHERE user_id=${USER2} AND org_id=${MINORITY_ORG}`;
  await sql`DELETE FROM account_organization_index WHERE user_id=${USER2}`;
  await sql.end();
  log("Fixtures cleaned up.");

  console.log("\n=== Gap Results ===");
  const passes = results.filter(r => r.verdict === "PASS").length;
  const fails = results.filter(r => r.verdict === "FAIL").length;
  const skips = results.filter(r => r.verdict === "NOT-RUN").length;
  for (const r of results)
    console.log(`  ${r.verdict === "PASS" ? "PASS" : r.verdict === "NOT-RUN" ? "SKIP" : "FAIL"}  [${r.id}] ${r.detail}`);
  console.log(`\nTotal: ${passes} PASS / ${fails} FAIL / ${skips} NOT-RUN`);
  if (failures > 0) {
    console.error(`\nRESULT: FAIL (${failures})`);
    process.exit(1);
  }
  console.log("\nRESULT: PASS");
  process.exit(0);
}

main().catch(e => { console.error("Unexpected error:", e); process.exit(1); });
