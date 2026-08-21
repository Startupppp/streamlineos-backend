import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { SignJWT } from "jose";

const args = process.argv.slice(2);
const baseUrl = (args.find((a) => a.startsWith("--url="))?.slice("--url=".length) ?? "").trim();
const repeats = Number(args.find((a) => a.startsWith("--repeats="))?.slice("--repeats=".length) ?? 100);
const concurrency = Number(args.find((a) => a.startsWith("--concurrency="))?.slice("--concurrency=".length) ?? 10);

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
const INTERNAL_SECRET = env("INTERNAL_API_SECRET");

if (!SECRET || !DB_URL || !INTERNAL_SECRET) {
  console.error("BACKEND_JWT_SECRET, DATABASE_URL and INTERNAL_API_SECRET are required.");
  process.exit(1);
}

/**
 * Ceilings are set from measured reality with headroom, not from a target: a warm
 * request costs about one tenant transaction, and `/organization` costs well under
 * one because most of its reads are served from cache. A regression to two would
 * mean something started opening a second transaction per request, which is exactly
 * what this pins.
 *
 * Measure as a NON-OWNER member. `authorize` short-circuits an organisation owner to
 * scope "all" before permission resolution runs, so an owner never exercises this path
 * at all — measuring as one reports the cost of a code path that is not the one under
 * test.
 */
const ENDPOINTS = [
  { path: "/me", ceiling: 1.5 },
  { path: "/me/access", ceiling: 1.5 },
  { path: "/organization", ceiling: 1.0 },
];

async function readBorrows(token) {
  const res = await fetch(`${API}/health/db`, {
    headers: { "x-internal-secret": INTERNAL_SECRET ?? "", accept: "application/json" },
  });
  if (res.status !== 200) throw new Error(`/health/db returned ${res.status}`);
  const body = await res.json();
  const pool = body.pool ?? body.data?.pool;
  if (!pool || typeof pool.borrows !== "number")
    throw new Error(`/health/db did not report pool.borrows: ${JSON.stringify(body).slice(0, 200)}`);
  return pool.borrows;
}

async function mintToken(actor) {
  return new SignJWT({
    orgId: actor.orgId,
    branchId: null,
    role: actor.role,
    enabledModules: [],
    plan: null,
    isOrgOwner: actor.isOwner,
    sessionId: "txn-cost-probe",
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
  const res = await fetch(`${API}${pathname}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  await res.text();
  return res.status;
}

const COUNTER_READ_BORROWS = 2;

async function measureIdle(token, ms) {
  const before = await readBorrows(token);
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  const after = await readBorrows(token);
  const elapsed = (Date.now() - started) / 1000;
  return (after - before - COUNTER_READ_BORROWS) / elapsed;
}

async function measure(pathname, token, idlePerSecond) {
  await call(pathname, token);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const before = await readBorrows(token);
  const started = Date.now();
  const statuses = new Set();
  let issued = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (issued < repeats) {
        issued += 1;
        statuses.add(await call(pathname, token));
      }
    }),
  );
  const elapsed = (Date.now() - started) / 1000;
  const after = await readBorrows(token);

  const raw = after - before - COUNTER_READ_BORROWS;
  const background = idlePerSecond * elapsed;

  return {
    path: pathname,
    statuses: [...statuses],
    xactPerRequest: (raw - background) / repeats,
    rawXactPerRequest: raw / repeats,
    backgroundSubtracted: Number(background.toFixed(1)),
  };
}

async function main() {
  const sql = postgres(DB_URL, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const [actor] = await sql`
      SELECT u.id AS "userId", m.org_id AS "orgId", m.role, m.is_owner AS "isOwner"
      FROM organization_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.is_owner = false
        AND m.status = 'ACTIVE'
        AND m.role <> 'ORG_ADMIN'
      LIMIT 1`;
    if (!actor) {
      console.error("No active non-owner member found; measuring as an owner would bypass permission resolution entirely.");
      process.exit(1);
    }
    console.log(`Actor: ${actor.role} (isOwner=${actor.isOwner}) in org ${actor.orgId}`);

    const token = await mintToken(actor);
    const health = await fetch(`${API}/health`).then((r) => r.status).catch(() => 0);
    if (health !== 200) {
      console.error(`API is not answering at ${API} (/health returned ${health}). Boot it first.`);
      process.exit(1);
    }

    const idlePerSecond = await measureIdle(token, 6000);
    console.log(`Background: ${idlePerSecond.toFixed(2)} tenant transactions/s (subtracted)`);

    const results = [];
    for (const endpoint of ENDPOINTS) {
      const measured = await measure(endpoint.path, token, idlePerSecond);
      results.push({ ...measured, ceiling: endpoint.ceiling });
    }

    console.log(`\nTransactions per request over ${repeats} warm requests (${API})\n`);
    let failed = false;
    for (const r of results) {
      const ok = r.rawXactPerRequest <= r.ceiling;
      if (!ok) failed = true;
      console.log(
        `${ok ? "PASS" : "FAIL"}  ${r.path.padEnd(16)} ${r.xactPerRequest.toFixed(2).padStart(6)} txn/req` +
          ` (ceiling ${r.ceiling})  status ${r.statuses.join(",")}` +
          `  [raw ${r.rawXactPerRequest.toFixed(2)}/req, background ${r.backgroundSubtracted} removed]`,
      );
    }

    if (failed) {
      console.error("\nA request cost more transactions than its ceiling.");
      process.exit(1);
    }
    console.log("\nEvery endpoint stayed under its ceiling.");
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
