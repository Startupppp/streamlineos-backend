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

async function call(pathname, jwt, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: res.status, body: body?.data ?? body };
}

async function main() {
  const [actor] = await sql`
    SELECT u.id AS "userId", m.org_id AS "orgId", m.role, m.is_owner AS "isOwner"
    FROM organization_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${ORG} AND m.is_owner = true LIMIT 1`;
  const jwt = await new SignJWT({
    orgId: actor.orgId, branchId: null, role: actor.role, enabledModules: [], plan: null,
    isOrgOwner: actor.isOwner, sessionId: "verify-actor-writes",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.userId)
    .setAudience("streamlineos-api")
    .setIssuer("streamlineos-web")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));

  const [insider] = await sql`
    SELECT m.user_id, m.id AS membership_id FROM organization_members m
    WHERE m.org_id = ${ORG} AND m.status = 'ACTIVE' AND m.user_id <> ${actor.userId} ORDER BY m.id LIMIT 1`;
  const [outsider] = await sql`
    SELECT u.id FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = ${ORG} AND m.user_id = u.id) LIMIT 1`;

  console.log(`API ${API} · org ${ORG} · actor ${actor.userId}`);
  console.log(`insider ${insider.user_id} (membership ${insider.membership_id}) · outsider ${outsider.id}\n`);

  const created = await call("/hr/helpdesk", jwt, {
    method: "POST",
    body: JSON.stringify({ title: `Actor verify ${Date.now()}`, description: "Created by the actor verification script.", category: "other" }),
  });
  const ticketId = created.body?.id;
  check("helpdesk ticket created", created.status === 201 && typeof ticketId === "number", `status=${created.status}`);

  const assigned = await call(`/hr/helpdesk/${ticketId}`, jwt, {
    method: "PATCH",
    body: JSON.stringify({ assigneeId: insider.user_id }),
  });
  const [row] = await sql`SELECT assignee_id, assignee_membership_id FROM helpdesk_tickets WHERE id = ${ticketId}`;
  check(
    "assigning an active member writes the membership beside the legacy user id",
    assigned.status === 200 && row.assignee_id === insider.user_id && row.assignee_membership_id === insider.membership_id,
    `assignee_id=${row?.assignee_id} assignee_membership_id=${row?.assignee_membership_id} expected=${insider.membership_id}`,
  );

  const outsiderAssign = await call(`/hr/helpdesk/${ticketId}`, jwt, {
    method: "PATCH",
    body: JSON.stringify({ assigneeId: outsider.id }),
  });
  const [afterOutsider] = await sql`SELECT assignee_id, assignee_membership_id FROM helpdesk_tickets WHERE id = ${ticketId}`;
  check(
    "assigning a user from outside the organization is refused as 404, never 403",
    outsiderAssign.status === 404,
    `status=${outsiderAssign.status}`,
  );
  check(
    "the refused assignment wrote nothing",
    afterOutsider.assignee_id === insider.user_id && afterOutsider.assignee_membership_id === insider.membership_id,
    `assignee_id=${afterOutsider.assignee_id}`,
  );

  await sql`UPDATE organization_members SET status = 'SUSPENDED' WHERE id = ${insider.membership_id}`;
  const suspendedAssign = await call(`/hr/helpdesk/${ticketId}`, jwt, {
    method: "PATCH",
    body: JSON.stringify({ assigneeId: insider.user_id, status: "IN_PROGRESS" }),
  });
  await sql`UPDATE organization_members SET status = 'ACTIVE' WHERE id = ${insider.membership_id}`;
  check(
    "assigning a suspended member of this organization is refused as 403",
    suspendedAssign.status === 403,
    `status=${suspendedAssign.status}`,
  );

  const [project] = await sql`SELECT id FROM build.projects WHERE org_id = ${ORG} AND deleted_at IS NULL LIMIT 1`;
  if (project) {
    const outsiderMember = await call(`/build/${project.id}/members`, jwt, {
      method: "POST",
      body: JSON.stringify({ userId: outsider.id, role: "CONTRIBUTOR" }),
    });
    const [planted] = await sql`
      SELECT count(*)::int n FROM build.project_members
      WHERE org_id = ${ORG} AND project_id = ${project.id} AND user_id = ${outsider.id}`;
    check(
      "adding a project member from another organization is refused as 404 and writes nothing",
      outsiderMember.status === 404 && planted.n === 0,
      `status=${outsiderMember.status} rows=${planted.n}`,
    );
  } else {
    console.log("SKIP  project member check — no project in the fixture organization");
  }

  await sql`DELETE FROM helpdesk_tickets WHERE id = ${ticketId}`;

  console.log(`\n${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED: ${failures.join(", ")}`}`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("VERIFY FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
