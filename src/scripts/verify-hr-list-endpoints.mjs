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

const API = (process.argv.find((a) => a.startsWith("--url="))?.slice(6) ?? `http://localhost:${env("PORT") ?? "1500"}`).trim();
const SECRET = env("BACKEND_JWT_SECRET");
const DB_URL = env("DATABASE_URL");
const ORG = process.env.SEED_ORG_ID ?? "aa5627a2-a7de-4dca-97d2-135f3a5f801b";

if (!SECRET || !DB_URL) {
  console.error("BACKEND_JWT_SECRET and DATABASE_URL are required.");
  process.exit(1);
}

const sql = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => {} });
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

async function owner() {
  const [row] = await sql`
    SELECT u.id AS "userId", m.org_id AS "orgId", m.role, m.is_owner AS "isOwner"
    FROM organization_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${ORG} AND m.is_owner = true LIMIT 1`;
  if (row) return row;
  const [fallback] = await sql`
    SELECT u.id AS "userId", m.org_id AS "orgId", m.role, m.is_owner AS "isOwner"
    FROM organization_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${ORG} ORDER BY m.id LIMIT 1`;
  return fallback;
}

async function token(actor) {
  return new SignJWT({
    orgId: actor.orgId,
    branchId: null,
    role: actor.role,
    enabledModules: [],
    plan: null,
    isOrgOwner: actor.isOwner,
    sessionId: "verify-hr-lists",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.userId)
    .setAudience("streamlineos-api")
    .setIssuer("streamlineos-web")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));
}

async function call(pathname, jwt, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body: body?.data ?? body };
}

async function main() {
  const actor = await owner();
  const jwt = await token(actor);
  console.log(`API ${API} · org ${ORG} · actor ${actor.userId} (owner=${actor.isOwner})\n`);

  const r1 = await call("/hr/performance/reviews?limit=3", jwt);
  check("reviews page 1 returns a cursor envelope", r1.status === 200 && Array.isArray(r1.body?.data) && r1.body.data.length === 3 && typeof r1.body.pagination?.hasMore === "boolean", `status=${r1.status} rows=${r1.body?.data?.length} nextCursor=${r1.body?.pagination?.nextCursor ? "present" : "null"}`);

  const cursor1 = r1.body?.pagination?.nextCursor;
  const r2 = await call(`/hr/performance/reviews?limit=3&cursor=${encodeURIComponent(cursor1 ?? "")}`, jwt);
  const ids1 = new Set((r1.body?.data ?? []).map((r) => r.id));
  const ids2 = (r2.body?.data ?? []).map((r) => r.id);
  check("reviews page 2 walks the cursor without repeating a row", r2.status === 200 && ids2.length === 3 && ids2.every((id) => !ids1.has(id)), `status=${r2.status} page1=${[...ids1].join(",")} page2=${ids2.join(",")}`);

  const rSort = await call("/hr/performance/reviews?limit=2&sortField=periodStart&sortDir=asc", jwt);
  check("reviews accept the allowlisted sort", rSort.status === 200 && rSort.body?.data?.length === 2, `status=${rSort.status}`);

  const rBadSort = await call("/hr/performance/reviews?sortField=overallRating", jwt);
  check("reviews reject a sort field outside the allowlist", rBadSort.status === 400, `status=${rBadSort.status}`);

  const rCap = await call("/hr/performance/reviews?limit=5000", jwt);
  check("reviews clamp the page size to the platform cap", rCap.status === 200 && rCap.body?.pagination?.limit === 100, `limit=${rCap.body?.pagination?.limit}`);

  const h1 = await call("/hr/helpdesk?limit=3", jwt);
  check("helpdesk page 1 returns a cursor envelope", h1.status === 200 && Array.isArray(h1.body?.data) && h1.body.data.length === 3, `status=${h1.status} rows=${h1.body?.data?.length}`);

  const h2 = await call(`/hr/helpdesk?limit=3&cursor=${encodeURIComponent(h1.body?.pagination?.nextCursor ?? "")}`, jwt);
  const hIds1 = new Set((h1.body?.data ?? []).map((r) => r.id));
  const hIds2 = (h2.body?.data ?? []).map((r) => r.id);
  check("helpdesk page 2 walks the cursor without repeating a row", h2.status === 200 && hIds2.length === 3 && hIds2.every((id) => !hIds1.has(id)), `status=${h2.status} page2=${hIds2.join(",")}`);

  const hSearch = await call("/hr/helpdesk?limit=5&q=provident", jwt);
  const allMatch = (hSearch.body?.data ?? []).every((t) => `${t.title} ${t.description ?? ""}`.toLowerCase().includes("provident"));
  check("helpdesk search returns only matching rows", hSearch.status === 200 && hSearch.body?.data?.length > 0 && allMatch, `status=${hSearch.status} rows=${hSearch.body?.data?.length}`);

  const hMiss = await call("/hr/helpdesk?limit=5&q=zzzznomatchzzzz", jwt);
  check("helpdesk search returns nothing for a term with no match", hMiss.status === 200 && hMiss.body?.data?.length === 0, `status=${hMiss.status} rows=${hMiss.body?.data?.length}`);

  const title = `Verify run ${Date.now()}`;
  const created = await call("/hr/helpdesk", jwt, {
    method: "POST",
    body: JSON.stringify({ title, description: "Created by the endpoint verification script.", category: "other", priority: "LOW" }),
  });
  check("helpdesk create returns the ticket", created.status === 201 && typeof created.body?.id === "number", `status=${created.status}`);

  const ticketId = created.body?.id;
  const [createdEvent] = ticketId
    ? await sql`SELECT event_type, delivery_state FROM outbox_events
                WHERE organization_id = ${ORG} AND aggregate_type = 'helpdesk_ticket'
                  AND aggregate_id = ${String(ticketId)} AND event_type = 'hr.helpdesk.ticket_created' LIMIT 1`
    : [];
  check("create committed an outbox row in the same transaction", Boolean(createdEvent), createdEvent ? `state=${createdEvent.delivery_state}` : "no row");

  const [assignee] = await sql`
    SELECT user_id FROM organization_members WHERE org_id = ${ORG} AND user_id <> ${actor.userId} ORDER BY id LIMIT 1`;
  const patched = ticketId
    ? await call(`/hr/helpdesk/${ticketId}`, jwt, {
        method: "PATCH",
        body: JSON.stringify({ assigneeId: assignee.user_id, status: "IN_PROGRESS" }),
      })
    : { status: 0 };
  check("helpdesk update succeeds", patched.status === 200, `status=${patched.status}`);

  const events = ticketId
    ? await sql`SELECT event_type FROM outbox_events
                WHERE organization_id = ${ORG} AND aggregate_type = 'helpdesk_ticket'
                  AND aggregate_id = ${String(ticketId)} ORDER BY event_type`
    : [];
  const types = events.map((e) => e.event_type);
  check("assignment and status change each committed an outbox row",
    types.includes("hr.helpdesk.ticket_assigned") && types.includes("hr.helpdesk.ticket_status_changed"),
    types.join(", ") || "none");

  const conflict = await call("/hr/helpdesk", jwt, {
    method: "POST",
    body: JSON.stringify({ title, description: "Duplicate title, should be rejected.", category: "other" }),
  });
  const [afterConflict] = await sql`
    SELECT count(*)::int n FROM outbox_events
    WHERE organization_id = ${ORG} AND aggregate_type = 'helpdesk_ticket'
      AND aggregate_id = ${String(ticketId)} AND event_type = 'hr.helpdesk.ticket_created'`;
  check("a rejected create writes no outbox row", conflict.status === 409 && afterConflict.n === 1, `status=${conflict.status} created_events=${afterConflict.n}`);

  console.log(`\n${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED: ${failures.join(", ")}`}`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("VERIFY FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
