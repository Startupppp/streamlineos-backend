/**
 * Proves that the last structural admin cannot be demoted by two concurrent
 * requests, and that the guard's SELECT … FOR UPDATE serialises concurrent
 * two-admin demotions into exactly one winner.
 *
 * Runs entirely on scratch_demote (created and dropped here).  No NestJS app
 * required; the guard logic is implemented directly in SQL to match what
 * assertNotLastStructuralAdmin does in the real service.
 *
 * Usage:
 *   node src/scripts/probe-concurrent-demotion.mjs
 *
 * Exit 0 = guard holds (all assertions passed).
 * Exit 1 = guard broken (real defect) or unexpected error.
 */
import postgres from "./../../node_modules/postgres/src/index.js";

const BASE = "postgresql://neondb_owner@127.0.0.1:5432/postgres?sslmode=disable";
const DEMOTE_DB = "scratch_demote";
const DEMOTE_URL = `postgresql://neondb_owner@127.0.0.1:5432/${DEMOTE_DB}?sslmode=disable`;

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

let failures = 0;
function assert(label, pass, detail = "") {
  if (pass) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

async function createDb() {
  const root = postgres(BASE, { max: 1, prepare: false, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DEMOTE_DB}`);
  await root.unsafe(`CREATE DATABASE ${DEMOTE_DB}`);
  await root.end();
}

async function dropDb() {
  const root = postgres(BASE, { max: 1, prepare: false, onnotice: () => {} });
  await root.unsafe(`DROP DATABASE IF EXISTS ${DEMOTE_DB}`);
  await root.end();
}

async function setupSchema(sql) {
  await sql.unsafe(`
    CREATE TYPE membership_status AS ENUM ('ACTIVE','INACTIVE','SUSPENDED');
  `);
  await sql.unsafe(`
    CREATE TABLE organization_members (
      id      SERIAL PRIMARY KEY,
      org_id  TEXT    NOT NULL,
      user_id TEXT    NOT NULL,
      role    TEXT    NOT NULL DEFAULT 'MEMBER',
      is_owner BOOLEAN NOT NULL DEFAULT false,
      status  membership_status NOT NULL DEFAULT 'ACTIVE',
      UNIQUE (org_id, user_id)
    );
  `);
}

/**
 * Replicates assertNotLastStructuralAdmin using raw SQL.
 * Returns { allowed: boolean, error?: string }
 */
async function runDemoteTransaction(sql, orgId, memberUserId, nextRole) {
  try {
    await sql.begin(async (tx) => {
      const [member] = await tx.unsafe(
        `SELECT id, role FROM organization_members
         WHERE org_id = $1 AND user_id = $2
         FOR UPDATE LIMIT 1`,
        [orgId, memberUserId],
      );
      if (!member) throw new Error("member_not_found");

      if (member.role !== "ORG_ADMIN" || nextRole === "ORG_ADMIN") {
        await tx.unsafe(
          `UPDATE organization_members SET role = $1 WHERE id = $2`,
          [nextRole, member.id],
        );
        return;
      }

      const adminRows = await tx.unsafe(
        `SELECT id FROM organization_members
         WHERE org_id = $1 AND status = 'ACTIVE'
           AND (is_owner = true OR role = 'ORG_ADMIN')
         ORDER BY id
         FOR UPDATE`,
        [orgId],
      );

      const remaining = adminRows.filter((r) => r.id !== member.id).length;

      if (remaining === 0) {
        throw Object.assign(new Error("last_admin"), { code: "GUARD_BLOCKED" });
      }

      await tx.unsafe(
        `UPDATE organization_members SET role = $1 WHERE id = $2`,
        [nextRole, member.id],
      );
    });
    return { allowed: true };
  } catch (e) {
    if (e?.code === "GUARD_BLOCKED") return { allowed: false, error: "last_admin" };
    if (e?.code === "40P01") return { allowed: false, error: "deadlock" };
    if (e?.message === "member_not_found") return { allowed: false, error: "not_found" };
    return { allowed: false, error: String(e?.message ?? e) };
  }
}

async function scenarioOneLastAdmin() {
  log("=== Scenario A: single last structural admin — two concurrent demotion attempts ===");
  log("Setup: org has exactly one ORG_ADMIN (no OWNER).");

  const sql = postgres(DEMOTE_URL, { max: 4, prepare: false, onnotice: () => {} });

  await setupSchema(sql);

  const ORG = "org-a";
  await sql.unsafe(
    `INSERT INTO organization_members (org_id, user_id, role, is_owner, status)
     VALUES ($1, $2, 'ORG_ADMIN', false, 'ACTIVE')`,
    [ORG, "admin-1"],
  );

  log("Issuing two concurrent BEGIN…COMMIT transactions on separate connections.");

  const [r1, r2] = await Promise.all([
    runDemoteTransaction(sql, ORG, "admin-1", "MEMBER"),
    runDemoteTransaction(sql, ORG, "admin-1", "MEMBER"),
  ]);

  log(`  T1 result: allowed=${r1.allowed} error=${r1.error ?? "none"}`);
  log(`  T2 result: allowed=${r2.allowed} error=${r2.error ?? "none"}`);

  assert(
    "A1: neither concurrent demotion succeeds when only one structural admin exists",
    !r1.allowed && !r2.allowed,
    `T1.allowed=${r1.allowed} T2.allowed=${r2.allowed}`,
  );

  const [{ role }] = await sql.unsafe(
    `SELECT role FROM organization_members WHERE org_id = $1 AND user_id = $2`,
    [ORG, "admin-1"],
  );

  assert(
    "A2: the single structural admin retains ORG_ADMIN role after both demotions are blocked",
    role === "ORG_ADMIN",
    `actual role = ${role}`,
  );

  await sql.end();
}

async function scenarioTwoAdminRace() {
  log("=== Scenario B: two structural admins — concurrent cross-demotion (deadlock risk) ===");
  log("Setup: org has A1 and A2, both ORG_ADMIN. T1 demotes A1, T2 demotes A2 simultaneously.");

  const sql = postgres(DEMOTE_URL, { max: 4, prepare: false, onnotice: () => {} });

  const ORG = "org-b";
  await sql.unsafe(
    `INSERT INTO organization_members (org_id, user_id, role, is_owner, status)
     VALUES ($1, $2, 'ORG_ADMIN', false, 'ACTIVE'),
            ($1, $3, 'ORG_ADMIN', false, 'ACTIVE')`,
    [ORG, "admin-a", "admin-b"],
  );

  log("Issuing two concurrent transactions that target different members.");

  const [r1, r2] = await Promise.all([
    runDemoteTransaction(sql, ORG, "admin-a", "MEMBER"),
    runDemoteTransaction(sql, ORG, "admin-b", "MEMBER"),
  ]);

  log(`  T1 (demote admin-a) result: allowed=${r1.allowed} error=${r1.error ?? "none"}`);
  log(`  T2 (demote admin-b) result: allowed=${r2.allowed} error=${r2.error ?? "none"}`);

  const successes = [r1, r2].filter((r) => r.allowed).length;

  assert(
    "B1: exactly one of the two concurrent demotions succeeds (deadlock aborts the other)",
    successes === 1,
    `successes=${successes} (T1=${r1.allowed}, T2=${r2.allowed})`,
  );

  const remaining = await sql.unsafe(
    `SELECT user_id, role FROM organization_members
     WHERE org_id = $1 AND (is_owner = true OR role = 'ORG_ADMIN') AND status = 'ACTIVE'`,
    [ORG],
  );

  assert(
    "B2: org retains exactly one structural admin after the race resolves",
    remaining.length === 1,
    `structural admins after race: ${remaining.map((r) => `${r.user_id}=${r.role}`).join(", ")}`,
  );

  await sql.end();
}

async function main() {
  log(`Creating disposable database ${DEMOTE_DB} …`);
  await createDb();

  try {
    await scenarioOneLastAdmin();
    await scenarioTwoAdminRace();
  } finally {
    log(`Dropping ${DEMOTE_DB} …`);
    await dropDb();
    log("Database dropped.");
  }

  console.log("");
  if (failures === 0) {
    console.log(`RESULT: PASS — guard holds, ${failures} failures. Both scenarios verified.`);
    process.exit(0);
  } else {
    console.error(`RESULT: FAIL — ${failures} assertion(s) failed. Guard has a defect.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
