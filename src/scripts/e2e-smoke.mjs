import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { SignJWT } from "jose";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const baseUrl = (args.find((a) => a.startsWith("--url="))?.slice("--url=".length) ?? "").trim();

function env(key) {
  if (process.env[key]) return process.env[key];
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return null;
  const m = fs.readFileSync(envPath, "utf8").match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

const API = baseUrl || `http://localhost:${env("PORT") ?? "1500"}`;
const SECRET = env("BACKEND_JWT_SECRET");
const DB_URL = env("DATABASE_URL");

if (!SECRET) {
  console.error("BACKEND_JWT_SECRET is required to mint a test token.");
  process.exit(1);
}

/** GET endpoints grouped by the domain they belong to. */
const SUITE = [
  ["Access", ["/me/access", "/access/org-modules", "/rbac/access-snapshot"]],
  ["RBAC", ["/rbac/permissions", "/rbac/discovery/permissions", "/rbac/discovery/grantable", "/rbac/discovery/templates", "/roles"]],
  ["Module access", ["/module-access/hr/catalog", "/module-access/hr/roles", "/module-access/hr/groups", "/module-access/hr/members", "/module-access/hr/me/permissions", "/module-access/hr/ownership"]],
  ["Invitations", ["/users/invitations"]],
  ["Users", ["/users", "/users/stats"]],
  ["Organization", ["/organization", "/organization/members", "/organization/settings", "/org/members"]],
  ["Org hierarchy", ["/org-hierarchy/overview", "/org-hierarchy/tree", "/org-hierarchy/branches", "/org-hierarchy/departments", "/org-hierarchy/teams", "/org-hierarchy/business-units"]],
  ["People directory", ["/directory/people", "/directory/workers"]],
  ["Business parties", ["/party/parties"]],
  ["Employee onboarding", ["/onboarding", "/onboarding/session", "/onboarding/templates", "/onboarding/tours", "/onboarding/module-checklists"]],
  ["Incoming transfer", ["/ownership/transfers/incoming"]],
  ["Org setup", ["/org/setup/session"]],
];

async function resolveActor() {
  if (!DB_URL) return null;
  const sql = postgres(DB_URL, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const rows = await sql`
      SELECT u.id AS "userId", m.org_id AS "orgId", m.role, m.is_owner AS "isOwner"
      FROM organization_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.is_owner = true
      LIMIT 1`;
    return rows[0] ?? null;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function mintToken(actor) {
  return new SignJWT({
    orgId: actor.orgId,
    branchId: null,
    role: actor.role,
    enabledModules: [],
    plan: null,
    isOrgOwner: actor.isOwner,
    sessionId: "e2e-smoke",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.userId)
    .setAudience("streamlineos-api")
    .setIssuer("streamlineos-web")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(SECRET));
}

async function call(pathname, token) {
  const started = Date.now();
  try {
    const res = await fetch(`${API}${pathname}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    return { status: res.status, body, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, body: { error: err instanceof Error ? err.message : String(err) }, ms: Date.now() - started };
  }
}

function verdict(status) {
  if (status === 200 || status === 204) return "PASS";
  if (status === 401) return "AUTH";
  if (status === 403) return "FORBID";
  if (status === 404) return "404";
  if (status >= 500 || status === 0) return "FAIL";
  return "WARN";
}

function summarise(body) {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body.replace(/\s+/g, " ").slice(0, 90);
  const inner = body.data ?? body;
  if (Array.isArray(inner)) return `array(${inner.length})`;
  if (inner && typeof inner === "object") {
    if (Array.isArray(inner.data)) {
      const total = inner.pagination?.total;
      return `data(${inner.data.length})${total !== undefined ? ` of ${total}` : ""}`;
    }
    if (typeof body.error === "string") return body.error.slice(0, 90);
    return `object{${Object.keys(inner).slice(0, 5).join(",")}}`;
  }
  return String(inner).slice(0, 90);
}

async function main() {
  console.log(`\nAPI      : ${API}`);

  const health = await call("/health", "");
  console.log(`Health   : ${health.status === 200 ? "UP" : `DOWN (${health.status})`}`);
  if (health.status !== 200) {
    console.error("\nAPI is not reachable. Start it with: pnpm -C backend start:dev");
    process.exit(1);
  }

  const actor = await resolveActor();
  if (!actor) {
    console.error("\nNo org owner found in the database — cannot mint a test session.");
    process.exit(1);
  }
  console.log(`Actor    : owner ${actor.userId} in org ${actor.orgId}\n`);

  const token = await mintToken(actor);
  const counts = { PASS: 0, FAIL: 0, FORBID: 0, "404": 0, AUTH: 0, WARN: 0 };
  const failures = [];

  for (const [group, endpoints] of SUITE) {
    console.log(`${group}`);
    for (const endpoint of endpoints) {
      const res = await call(endpoint, token);
      const v = verdict(res.status);
      counts[v] += 1;
      if (v === "FAIL" || v === "FORBID" || v === "404") {
        failures.push({ endpoint, status: res.status, detail: summarise(res.body) });
      }
      const line = `  ${v.padEnd(6)} ${String(res.status).padEnd(4)} ${endpoint}`;
      console.log(verbose || v !== "PASS" ? `${line}  ${summarise(res.body)}` : line);
    }
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `PASS ${counts.PASS}  FAIL ${counts.FAIL}  FORBIDDEN ${counts.FORBID}  NOT-FOUND ${counts["404"]}  UNAUTH ${counts.AUTH}  OTHER ${counts.WARN}`,
  );
  console.log(`${"=".repeat(72)}`);

  if (failures.length > 0) {
    console.log(`\nNot returning data (${failures.length}):`);
    for (const f of failures) console.log(`  ${String(f.status).padEnd(4)} ${f.endpoint}\n       ${f.detail}`);
  }

  console.log(
    `\nThe actor is an ORG OWNER, who bypasses every permission check.`,
  );
  console.log(
    `A 403 here therefore means a MODULE gate or an explicit guard, not a missing role.`,
  );
  console.log(`A 500 means a real server error. A 404 means the route does not exist as written.\n`);

  process.exit(counts.FAIL > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
