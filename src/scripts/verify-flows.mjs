import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { SignJWT } from "jose";

function env(key) {
  if (process.env[key]) return process.env[key];
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return null;
  const m = fs.readFileSync(envPath, "utf8").match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

const API = `http://localhost:${env("PORT") ?? "1500"}`;
const SECRET = env("BACKEND_JWT_SECRET");
const DB_URL = env("DATABASE_URL");

if (!SECRET || !DB_URL) {
  console.error("BACKEND_JWT_SECRET and DATABASE_URL are required.");
  process.exit(1);
}

async function mintToken(actor) {
  return new SignJWT({
    orgId: actor.orgId,
    branchId: null,
    role: actor.role,
    enabledModules: [],
    plan: null,
    isOrgOwner: actor.isOwner,
    sessionId: "flow-verify-probe",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.userId)
    .setAudience("streamlineos-api")
    .setIssuer("streamlineos-web")
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(new TextEncoder().encode(SECRET));
}

async function api(method, path, token, body) {
  const opts = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  let json;
  try { json = await res.json(); } catch { json = null; }
  // Unwrap {success, data} envelope if present
  const unwrapped = (json && typeof json === "object" && "success" in json && "data" in json) ? json.data : json;
  return { status: res.status, raw: json, body: unwrapped };
}

function pp(obj) {
  return JSON.stringify(obj, null, 2).slice(0, 2000);
}

async function main() {
  const sql = postgres(DB_URL, { prepare: false, max: 1, onnotice: () => {} });

  console.log("=== Connecting to DB and finding actors ===\n");

  // Find a non-owner active MEMBER actor
  const [actor] = await sql`
    SELECT u.id AS "userId", m.org_id AS "orgId", m.role, m.is_owner AS "isOwner"
    FROM organization_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.is_owner = false
      AND m.status = 'ACTIVE'
      AND m.role <> 'ORG_ADMIN'
    LIMIT 1`;

  if (!actor) {
    console.error("No active non-owner member found.");
    await sql.end().catch(() => {});
    process.exit(1);
  }
  console.log(`Primary actor: ${actor.role} (isOwner=${actor.isOwner}) userId=${actor.userId} orgId=${actor.orgId}`);

  // Find a second actor in the same org for KB cross-user test
  const [actor2] = await sql`
    SELECT u.id AS "userId", m.org_id AS "orgId", m.role, m.is_owner AS "isOwner"
    FROM organization_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.is_owner = false
      AND m.status = 'ACTIVE'
      AND m.user_id <> ${actor.userId}
      AND m.org_id = ${actor.orgId}
    LIMIT 1`;
  if (actor2) {
    console.log(`Secondary actor: ${actor2.role} userId=${actor2.userId} orgId=${actor2.orgId}`);
  }

  // Find org's enabled modules
  const orgModules = await sql`
    SELECT module_key FROM org_modules WHERE org_id = ${actor.orgId} AND enabled = true`;
  const enabledSet = new Set(orgModules.map(r => r.module_key));
  console.log(`Org enabled modules: ${[...enabledSet].join(", ") || "(none)"}`);

  // Find a module that is NOT enabled for this org (inventory preferred)
  const candidateDisabled = ["inventory", "crm", "timesheets", "helpdesk"];
  const disabledModule = candidateDisabled.find(m => !enabledSet.has(m));
  console.log(`Disabled module to test plan-lock: ${disabledModule ?? "(none found)"}`);

  // Get a chat channel ID for this actor
  const [chatChannel] = await sql`
    SELECT cc.id, cc.name
    FROM chat_channels cc
    JOIN chat_channel_members ccm ON ccm.channel_id = cc.id AND ccm.user_id = ${actor.userId}
    WHERE cc.org_id = ${actor.orgId}
      AND cc.is_archived = false
    LIMIT 1`;
  console.log(`Chat channel for actor: ${chatChannel ? `id=${chatChannel.id} name=${chatChannel.name}` : "(none)"}`);

  // Look for ANY chat channel in the org (actor may not be a member)
  const [anyChannel] = await sql`
    SELECT id, name FROM chat_channels
    WHERE org_id = ${actor.orgId} AND is_archived = false
    LIMIT 1`;
  console.log(`Any chat channel in org: ${anyChannel ? `id=${anyChannel.id} name=${anyChannel.name}` : "(none)"}`);

  // KB spaces
  const [kbSpace] = await sql`
    SELECT id, name FROM kb_spaces WHERE org_id = ${actor.orgId} LIMIT 1`;
  console.log(`KB space: ${kbSpace ? `id=${kbSpace.id} name=${kbSpace.name}` : "(none)"}`);

  const token = await mintToken(actor);
  const token2 = actor2 ? await mintToken(actor2) : null;

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n=== FLOW 1: GET /me/access shape ===\n");
  {
    const r = await api("GET", "/me/access", token);
    console.log(`Status: ${r.status}`);
    console.log(`Raw envelope keys: ${r.raw ? Object.keys(r.raw).join(", ") : "(null)"}`);
    console.log(`Unwrapped body keys: ${r.body ? Object.keys(r.body).join(", ") : "(null)"}`);
    const b = r.body;
    const hasPermissions = b && "permissions" in b;
    const hasScopes = b && "scopes" in b;
    const hasModules = b && "modules" in b;
    const hasIsOrgOwner = b && "isOrgOwner" in b;
    const hasMfa = b && "mfa" in b;
    const hasVersion = b && "version" in b;
    console.log(`has scopes: ${hasScopes}`);
    console.log(`has modules: ${hasModules}`);
    console.log(`has isOrgOwner: ${hasIsOrgOwner}`);
    console.log(`has mfa: ${hasMfa}`);
    console.log(`has version: ${hasVersion}`);
    console.log(`has permissions (MUST BE ABSENT): ${hasPermissions}`);
    if (hasScopes && typeof b.scopes === "object") {
      const sampleKeys = Object.keys(b.scopes).slice(0, 6);
      console.log(`Sample scopes keys: ${sampleKeys.join(", ")}`);
      console.log(`Total scope keys: ${Object.keys(b.scopes).length}`);
    }
    if (hasModules && typeof b.modules === "object") {
      console.log(`Module flags: ${pp(b.modules)}`);
    }
    const pass = r.status === 200 && hasScopes && hasModules && hasIsOrgOwner && hasMfa && hasVersion && !hasPermissions;
    console.log(`\nRESULT 1: ${pass ? "PASS" : "FAIL"}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n=== FLOW 2: Plan-locked module response ===\n");
  {
    if (!disabledModule) {
      console.log("BLOCKED: All candidate modules appear enabled for this org.");
    } else {
      // inventory/stock is @RequireModule("inventory") @Controller("inventory/stock")
      const routeMap = {
        inventory: "/inventory/stock",
        crm: "/crm/contacts",
        timesheets: "/timesheets",
        helpdesk: "/support/tickets",
      };
      const testRoute = routeMap[disabledModule] ?? `/${disabledModule}`;
      console.log(`Testing route: GET ${testRoute} with module "${disabledModule}" disabled`);
      const r = await api("GET", testRoute, token);
      console.log(`Status: ${r.status}`);
      console.log(`Raw body: ${pp(r.raw)}`);
      // 402 = plan gate, 403 = module gate, 404 = route not found
      if (r.status === 402) {
        console.log(`\nRESULT 2: PASS (402 — plan reported as reason)`);
      } else if (r.status === 403) {
        const bodyStr = JSON.stringify(r.raw ?? "");
        const mentionsPlan = bodyStr.toLowerCase().includes("plan") || bodyStr.toLowerCase().includes("no_module");
        console.log(`403 body mentions plan/NO_MODULE: ${mentionsPlan}`);
        console.log(`\nRESULT 2: ${mentionsPlan ? "PASS (403 + plan/NO_MODULE in body)" : "PARTIAL (403 but no plan reason in body)"}`);
      } else if (r.status === 404) {
        console.log(`\nRESULT 2: FAIL — 404 means route not registered (module not wired to app), not a plan gate`);
      } else {
        console.log(`\nRESULT 2: FAIL — unexpected status ${r.status}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n=== FLOW 3: Calendar source toggles ===\n");
  {
    const r1 = await api("GET", "/calendar/sources", token);
    console.log(`GET /calendar/sources status: ${r1.status}`);
    console.log(`Unwrapped body: ${pp(r1.body)}`);

    const sources = Array.isArray(r1.body) ? r1.body : [];
    console.log(`Source count: ${sources.length}`);

    if (r1.status === 200 && sources.length > 0) {
      const src = sources[0];
      const sourceKey = src.key;
      const originalEnabled = src.enabled;
      console.log(`\nFirst source: key=${sourceKey}, label=${src.label}, module=${src.module}, enabled=${originalEnabled}`);
      const hasRequiredFields = "key" in src && "label" in src && "module" in src && "enabled" in src;
      console.log(`Source has key/label/module/enabled: ${hasRequiredFields}`);

      // Disable it
      const r2 = await api("PUT", `/calendar/sources/${sourceKey}`, token, { enabled: false });
      console.log(`\nPUT /calendar/sources/${sourceKey} {enabled:false} status: ${r2.status}`);
      console.log(`Body: ${pp(r2.raw)}`);

      // Re-GET to confirm persistence
      const r3 = await api("GET", "/calendar/sources", token);
      console.log(`\nRe-GET /calendar/sources status: ${r3.status}`);
      const sources3 = Array.isArray(r3.body) ? r3.body : [];
      const updated = sources3.find(s => s.key === sourceKey);
      console.log(`Source ${sourceKey} enabled after disable PUT: ${updated?.enabled}`);

      // GET events to confirm source disabled doesn't cause errors
      const now = new Date();
      const start = now.toISOString().split("T")[0];
      const endDate = new Date(now);
      endDate.setDate(endDate.getDate() + 7);
      const end = endDate.toISOString().split("T")[0];
      const r4 = await api("GET", `/calendar/events?start=${start}&end=${end}`, token);
      console.log(`\nGET /calendar/events (source disabled) status: ${r4.status}`);
      console.log(`Unwrapped body keys: ${r4.body ? Object.keys(r4.body).join(", ") : "(null)"}`);

      // Re-enable
      const r5 = await api("PUT", `/calendar/sources/${sourceKey}`, token, { enabled: true });
      console.log(`\nPUT /calendar/sources/${sourceKey} {enabled:true} status: ${r5.status}`);
      const r6 = await api("GET", "/calendar/sources", token);
      const sources6 = Array.isArray(r6.body) ? r6.body : [];
      const reEnabled = sources6.find(s => s.key === sourceKey);
      console.log(`Source ${sourceKey} enabled after re-enable PUT: ${reEnabled?.enabled}`);

      const pass = r1.status === 200 && r2.status === 200 && r3.status === 200 && updated?.enabled === false && r5.status === 200 && reEnabled?.enabled === true;
      console.log(`\nRESULT 3: ${pass ? "PASS" : "FAIL"}`);
    } else {
      console.log(`\nRESULT 3: BLOCKED — no sources available or non-200 status`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n=== FLOW 4: Calendar events { events, failures } shape ===\n");
  {
    const now = new Date();
    const start = now.toISOString().split("T")[0];
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + 7);
    const end = endDate.toISOString().split("T")[0];
    const r = await api("GET", `/calendar/events?start=${start}&end=${end}`, token);
    console.log(`GET /calendar/events status: ${r.status}`);
    console.log(`Raw envelope keys: ${r.raw ? Object.keys(r.raw).join(", ") : "(null)"}`);
    console.log(`Unwrapped body keys: ${r.body ? Object.keys(r.body).join(", ") : "(null)"}`);
    console.log(`Full unwrapped body: ${pp(r.body)}`);
    const b = r.body;
    const hasEvents = b && "events" in b;
    const hasFailures = b && "failures" in b;
    const failuresIsArray = hasFailures && Array.isArray(b.failures);
    const eventsIsArray = hasEvents && Array.isArray(b.events);
    console.log(`has events (array): ${eventsIsArray}`);
    console.log(`has failures (array): ${failuresIsArray}`);
    console.log(`failures content: ${JSON.stringify(b?.failures ?? [])}`);
    const bodyStr = JSON.stringify(r.raw ?? "");
    const hasRawError = bodyStr.includes("Error:") || (bodyStr.includes("stack") && bodyStr.includes("at "));
    console.log(`has raw error text in response: ${hasRawError}`);
    const pass = r.status === 200 && eventsIsArray && failuresIsArray && !hasRawError;
    console.log(`\nRESULT 4: ${pass ? "PASS" : "FAIL"}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n=== FLOW 5: KB private page search ===\n");
  {
    if (!enabledSet.has("kb")) {
      console.log("BLOCKED: kb module is not enabled for this org.");
    } else if (!kbSpace) {
      console.log("BLOCKED: No KB spaces in DB. Cannot create a page.");
    } else {
      // Check actor's scopes
      const accessR = await api("GET", "/me/access", token);
      const scopes = accessR.body?.scopes ?? {};
      const canCreate = "kb:pages:create" in scopes;
      const canViewKb = "kb:pages:view" in scopes || "kb:articles:view" in scopes;
      console.log(`Actor has kb:pages:create: ${canCreate}`);
      console.log(`Actor has kb view permission: ${canViewKb}`);

      // Try getting KB spaces via API
      const spacesR = await api("GET", "/kb/spaces", token);
      console.log(`GET /kb/spaces status: ${spacesR.status}`);
      const spaces = Array.isArray(spacesR.body) ? spacesR.body : (spacesR.body?.spaces ?? spacesR.body?.items ?? []);
      const spaceId = kbSpace.id; // Use DB-sourced space id as fallback
      console.log(`Using KB space id from DB: ${spaceId}`);

      if (!canCreate) {
        console.log("BLOCKED: Actor lacks kb:pages:create permission.");
      } else {
        // Create a private page
        const uniqueToken = `verify-flows-${Date.now()}`;
        const uniqueTitle = `Private Test Page ${uniqueToken}`;
        const createR = await api("POST", "/kb/pages", token, {
          spaceId,
          title: uniqueTitle,
          content: `This is a secret private wiki page with unique token ${uniqueToken}`,
          visibility: "private",
        });
        console.log(`POST /kb/pages status: ${createR.status}`);
        console.log(`Body: ${pp(createR.raw)}`);

        if (createR.status >= 200 && createR.status < 300) {
          const pageId = createR.body?.id ?? createR.body?.page?.id;
          console.log(`Created page id: ${pageId}`);

          // Try trigger indexing
          if (pageId) {
            const indexR = await api("POST", `/kb/pages/${pageId}/index`, token);
            console.log(`POST /kb/pages/${pageId}/index status: ${indexR.status}`);
          }

          // Wait for indexing
          await new Promise(r => setTimeout(r, 3000));

          // Search as author
          const searchR = await api("GET", `/kb/search?q=${encodeURIComponent(uniqueToken)}`, token);
          console.log(`GET /kb/search as author status: ${searchR.status}`);
          console.log(`Search result: ${pp(searchR.body)}`);
          const resultStr = JSON.stringify(searchR.body ?? "");
          const foundByAuthor = resultStr.includes(uniqueTitle) || (pageId && resultStr.includes(String(pageId)));
          console.log(`Found by author: ${foundByAuthor}`);

          if (token2 && actor2.orgId === actor.orgId) {
            const search2R = await api("GET", `/kb/search?q=${encodeURIComponent(uniqueToken)}`, token2);
            console.log(`GET /kb/search as other user (same org) status: ${search2R.status}`);
            const result2Str = JSON.stringify(search2R.body ?? "");
            const foundByOther = pageId ? result2Str.includes(String(pageId)) : result2Str.includes(uniqueTitle);
            console.log(`Found by other user (should be false for private): ${foundByOther}`);
            const pass = foundByAuthor && !foundByOther;
            console.log(`\nRESULT 5: ${pass ? "PASS" : !foundByAuthor ? "FAIL (author could not find it)" : "FAIL (private page visible to other user)"}`);
          } else {
            console.log(`\nRESULT 5: ${foundByAuthor ? "PARTIAL (found by author, no same-org second user to test isolation)" : "FAIL (author could not find it)"}`);
          }
        } else {
          console.log("BLOCKED: Could not create KB page.");
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n=== FLOW 6: Chat message send ===\n");
  {
    const channel = chatChannel ?? anyChannel;
    if (!channel) {
      console.log("BLOCKED: No chat channel found in org.");
    } else {
      // If actor is not a member of the channel, try joining or use a different approach
      const useToken = chatChannel ? token : token; // same token regardless
      const r = await api("POST", `/chat/channels/${channel.id}/messages`, useToken, {
        content: `Verification probe message ${Date.now()}`,
      });
      console.log(`POST /chat/channels/${channel.id}/messages status: ${r.status}`);
      console.log(`Raw body: ${pp(r.raw)}`);
      console.log(`Unwrapped body: ${pp(r.body)}`);

      if (r.status === 201 || r.status === 200) {
        const b = r.body;
        const hasId = b && "id" in b;
        const hasContent = b && "content" in b;
        const hasSender = b && ("senderId" in b || "userId" in b || "sender" in b || "authorId" in b);
        console.log(`Message has id: ${hasId}`);
        console.log(`Message has content: ${hasContent}`);
        console.log(`Message has sender identity: ${hasSender} — fields: ${b ? Object.keys(b).join(", ") : ""}`);
        console.log(`\nRESULT 6: ${hasId ? "PASS" : "FAIL (no id in response)"}`);
      } else {
        console.log(`\nRESULT 6: FAIL — status ${r.status}`);
      }
    }
  }

  await sql.end({ timeout: 5 }).catch(() => {});
  console.log("\n=== Done ===");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
