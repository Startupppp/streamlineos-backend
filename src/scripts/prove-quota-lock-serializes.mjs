import postgres from "postgres";

const TARGET = process.env.QUOTA_LOCK_PROOF_DATABASE_URL ?? "";

function refuse(reason) {
  console.error(`REFUSED: ${reason}`);
  process.exit(2);
}

if (!TARGET) refuse("QUOTA_LOCK_PROOF_DATABASE_URL is not set");
if (!/scratch/i.test(TARGET)) refuse("target database name must contain 'scratch'");
if (!/(127\.0\.0\.1|localhost)/.test(TARGET)) refuse("target host must be loopback");

const quotaLockKey = (orgId, limitKey) => `quota:${orgId}:${limitKey}`;

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const LIMIT_KEY = "projects";
const CEILING = 3;

const TABLE = "quota_lock_proof_rows";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(sql, orgId, useLock, startedAt, log) {
  return sql.begin(async (tx) => {
    if (useLock) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${quotaLockKey(orgId, LIMIT_KEY)}, 0))`;
    const acquiredAt = Date.now() - startedAt;
    const [{ used }] = await tx`SELECT COUNT(*)::int AS used FROM ${sql(TABLE)} WHERE org_id = ${orgId}`;
    await sleep(120);
    if (used >= CEILING) {
      log.push({ orgId, acquiredAt, used, inserted: false });
      return false;
    }
    await tx`INSERT INTO ${sql(TABLE)} (org_id) VALUES (${orgId})`;
    log.push({ orgId, acquiredAt, used, inserted: true });
    return true;
  });
}

async function runRace(sql, useLock) {
  await sql`TRUNCATE ${sql(TABLE)}`;
  await sql`INSERT INTO ${sql(TABLE)} (org_id) SELECT ${ORG_A} FROM generate_series(1, ${CEILING - 1})`;
  const log = [];
  const startedAt = Date.now();
  const results = await Promise.all([
    attempt(sql, ORG_A, useLock, startedAt, log),
    attempt(sql, ORG_A, useLock, startedAt, log),
    attempt(sql, ORG_A, useLock, startedAt, log),
  ]);
  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM ${sql(TABLE)} WHERE org_id = ${ORG_A}`;
  return { inserted: results.filter(Boolean).length, total, log };
}

async function runCrossOrg(sql) {
  await sql`TRUNCATE ${sql(TABLE)}`;
  const startedAt = Date.now();
  const log = [];
  await Promise.all([
    attempt(sql, ORG_A, true, startedAt, log),
    attempt(sql, ORG_B, true, startedAt, log),
  ]);
  return Math.max(...log.map((entry) => entry.acquiredAt));
}

async function main() {
  const sql = postgres(TARGET, { max: 5, prepare: false, onnotice: () => {} });
  let failures = 0;
  try {
    const [{ current_database: db }] = await sql`SELECT current_database()`;
    console.log(`target database: ${db}`);
    await sql`CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (id bigserial PRIMARY KEY, org_id uuid NOT NULL)`;

    const unlocked = await runRace(sql, false);
    console.log(`\nWITHOUT lock: inserted=${unlocked.inserted} finalRows=${unlocked.total} ceiling=${CEILING}`);
    console.log(JSON.stringify(unlocked.log));
    if (unlocked.total <= CEILING) {
      console.log("  NOTE: control did not oversell on this run; the race is timing dependent");
    } else {
      console.log(`  CONTROL CONFIRMED: oversold by ${unlocked.total - CEILING}`);
    }

    const locked = await runRace(sql, true);
    console.log(`\nWITH lock: inserted=${locked.inserted} finalRows=${locked.total} ceiling=${CEILING}`);
    console.log(JSON.stringify(locked.log));
    if (locked.total > CEILING) {
      console.error(`  FAIL: lock did not prevent oversell (${locked.total} > ${CEILING})`);
      failures += 1;
    } else {
      console.log("  PASS: ceiling held under three concurrent last-slot attempts");
    }

    const serialized = locked.log.every((entry, index) => index === 0 || entry.acquiredAt >= 100);
    if (!serialized) {
      console.error("  FAIL: contenders did not queue on the advisory lock");
      failures += 1;
    } else {
      console.log("  PASS: contenders queued (each later acquire waited for the holder to commit)");
    }

    const crossOrgMaxWait = await runCrossOrg(sql);
    console.log(`\nCROSS-ORG: slowest acquire ${crossOrgMaxWait}ms`);
    if (crossOrgMaxWait >= 100) {
      console.error("  FAIL: a different organisation blocked on the same lock key");
      failures += 1;
    } else {
      console.log("  PASS: a different organisation acquires without waiting");
    }
  } finally {
    await sql`DROP TABLE IF EXISTS ${sql(TABLE)}`;
    await sql.end();
  }
  console.log(failures === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
