import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { SignJWT, importJWK } from "jose";
import { randomUUID } from "node:crypto";

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
const DB_URL = env("DATABASE_URL");

if (!env("AUTH_SIGNING_KEYS")) {
  console.error("AUTH_SIGNING_KEYS is required to mint a test token; the API verifies EdDSA.");
  process.exit(1);
}

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];
export function assertDisposableSmokeTarget(databaseUrl, apiUrl) {
  if (databaseUrl) {
    for (const pattern of PRODUCTION_HOST_PATTERNS)
      if (databaseUrl.includes(pattern))
        return { allowed: false, reason: `DATABASE_URL contains '${pattern}' — a known production host` };
    let host;
    try {
      host = new URL(databaseUrl).hostname;
    } catch {
      return { allowed: false, reason: "DATABASE_URL does not parse" };
    }
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host))
      return { allowed: false, reason: `DATABASE_URL host '${host}' is not loopback` };
  }
  let apiHost;
  try {
    apiHost = new URL(apiUrl).hostname;
  } catch {
    return { allowed: false, reason: "API url does not parse" };
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(apiHost))
    return { allowed: false, reason: `API host '${apiHost}' is not loopback` };
  return { allowed: true, reason: "loopback database and API" };
}

if (args.includes("--self-test")) {
  const cases = [
    [assertDisposableSmokeTarget("postgresql://u:p@127.0.0.1:5432/scratch_local", "http://127.0.0.1:1500"), true],
    [assertDisposableSmokeTarget("postgresql://u:p@prod.cluster.amazonaws.com:5432/app", "http://127.0.0.1:1500"), false],
    [assertDisposableSmokeTarget("postgresql://u:p@db.neon.tech:5432/app", "http://127.0.0.1:1500"), false],
    [assertDisposableSmokeTarget("postgresql://u:p@10.0.0.5:5432/app", "http://127.0.0.1:1500"), false],
    [assertDisposableSmokeTarget("postgresql://u:p@127.0.0.1:5432/scratch_local", "https://api.streamlineos.in"), false],
    [assertDisposableSmokeTarget(null, "http://localhost:1500"), true],
  ];
  let failed = 0;
  for (const [verdict, expected] of cases)
    if (verdict.allowed !== expected) {
      console.error(`FAIL: ${verdict.reason}`);
      failed++;
    }
  if (failed) process.exit(1);
  console.log("PASS: e2e-smoke target refusal, 6 cases, production and remote targets both refused.");
  process.exit(0);
}

const smokeTarget = assertDisposableSmokeTarget(DB_URL, API);
if (!smokeTarget.allowed) {
  console.error(`Refusing to smoke-test: ${smokeTarget.reason}.`);
  console.error("Pass an explicit disposable DATABASE_URL and --url=http://127.0.0.1:<port>.");
  process.exit(2);
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
    const actor = rows[0];
    if (!actor) return null;
    const sessionId = `e2e-smoke-${randomUUID()}`;
    await sql`
      INSERT INTO user_sessions (id, user_id, is_revoked, last_active, expires_at, created_at)
      VALUES (${sessionId}, ${actor.userId}, false, now(), now() + interval '1 hour', now())`;
    return { ...actor, sessionId };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function releaseActor(actor) {
  if (!DB_URL || !actor?.sessionId) return;
  const sql = postgres(DB_URL, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await sql`DELETE FROM user_sessions WHERE id = ${actor.sessionId}`;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function mintToken(actor) {
  const raw = env("AUTH_SIGNING_KEYS");
  if (!raw) throw new Error("AUTH_SIGNING_KEYS is required — the API verifies EdDSA, not HS256");
  const entries = JSON.parse(raw);
  const entry = entries[entries.length - 1];
  const privateKey = await importJWK(entry.privateKey, "EdDSA");
  return new SignJWT({ orgId: actor.orgId, sessionId: actor.sessionId })
    .setProtectedHeader({ alg: "EdDSA", kid: entry.kid })
    .setSubject(actor.userId)
    .setAudience("streamlineos-api")
    .setIssuer("streamlineos-web")
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti(randomUUID())
    .sign(privateKey);
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

let mintedActor = null;

async function main() {
  console.log(`\nAPI      : ${API}`);

  const health = await call("/health", "");
  console.log(`Health   : ${health.status === 200 ? "UP" : `DOWN (${health.status})`}`);
  if (health.status !== 200) {
    console.error("\nAPI is not reachable. Start it with: pnpm -C backend start:dev");
    process.exit(1);
  }

  const actor = await resolveActor();
  mintedActor = actor;
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

  await releaseActor(mintedActor);
  if (counts.PASS === 0) {
    console.error("FAILED SMOKE: no route authenticated. The token was rejected everywhere;");
    console.error("this run proves nothing about route health.");
    process.exit(1);
  }
  process.exit(counts.FAIL > 0 ? 1 : 0);
}

main().catch(async (err) => {
  await releaseActor(mintedActor).catch(() => undefined);
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
