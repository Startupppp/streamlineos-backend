#!/usr/bin/env node
import postgres from "postgres";
import { createHash, randomUUID } from "node:crypto";
import { importJWK, SignJWT } from "jose";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const ENV_FILE = "D:/agent-work/disposable.env";
const HARNESS = "D:/projects/personal/Streamlineos/backend/src/scripts/people-request-capture.mjs";
const OUT = "D:/projects/personal/Streamlineos/backend/people-request-capture-v2.json";

function readEnvFile(path) {
  const content = fs.readFileSync(path, "utf8");
  const env = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return env;
}

const disposableEnv = readEnvFile(ENV_FILE);
const DB_URL = disposableEnv.DATABASE_URL;
const AUTH_SIGNING_KEYS_RAW = disposableEnv.AUTH_SIGNING_KEYS;

if (!DB_URL || !AUTH_SIGNING_KEYS_RAW)
  throw new Error("disposable.env missing DATABASE_URL or AUTH_SIGNING_KEYS");

for (const marker of ["prod", "neon.tech", "aurora", "rds.amazonaws.com"])
  if (DB_URL.toLowerCase().includes(marker))
    throw new Error(`Refusing: DB_URL looks like production (${marker})`);

const sql = postgres(DB_URL, { prepare: false, max: 1, onnotice: () => {} });

async function mintToken(userId, sessionId, orgId) {
  const entries = JSON.parse(AUTH_SIGNING_KEYS_RAW);
  const latest = entries[entries.length - 1];
  const privateKey = await importJWK(latest.privateKey, "EdDSA");
  return new SignJWT({ orgId, sessionId })
    .setProtectedHeader({ alg: "EdDSA", kid: latest.kid })
    .setSubject(userId)
    .setAudience("streamlineos-api")
    .setIssuer("streamlineos-web")
    .setIssuedAt()
    .setExpirationTime("20m")
    .setJti(randomUUID())
    .sign(privateKey);
}

let sessionId = null;
let enterpriseQuoteId = null;

try {
  const actors = await sql`
    SELECT
      u.id AS user_id,
      m1.org_id AS org1_id,
      o1.name AS org1_name,
      m2.org_id AS org2_id,
      o2.name AS org2_name
    FROM users u
    JOIN organization_members m1 ON m1.user_id = u.id AND m1.status = 'ACTIVE' AND m1.is_owner = true
    JOIN organization_members m2 ON m2.user_id = u.id AND m2.status = 'ACTIVE' AND m2.org_id != m1.org_id
    JOIN organizations o1 ON o1.id = m1.org_id AND o1.status = 'ACTIVE' AND o1.deleted_at IS NULL
    JOIN organizations o2 ON o2.id = m2.org_id AND o2.status = 'ACTIVE' AND o2.deleted_at IS NULL
    LIMIT 1
  `;

  if (!actors.length) {
    console.error("run-c1-setup: no actor with two org memberships found in scratch_local");
    process.exit(1);
  }

  const { user_id: userId, org1_id: org1Id, org1_name: org1Name, org2_id: org2Id, org2_name: org2Name } = actors[0];
  const salt = randomUUID();
  const mask = (v) => createHash("sha256").update(`${salt}:${String(v)}`).digest("hex").slice(0, 8);
  console.log(`Actor: ${mask(userId)} ORG1: ${org1Name} (${mask(org1Id)}) ORG2: ${org2Name} (${mask(org2Id)})`);

  const existingQuote = await sql`
    SELECT id FROM enterprise_quotes
    WHERE org_id = ${org1Id} AND status = 'ACCEPTED' AND negotiated_seats >= 500
    LIMIT 1
  `;

  if (!existingQuote.length) {
    const quoteRef = `C1-TEST-${Date.now()}`;
    const [quote] = await sql`
      INSERT INTO enterprise_quotes
        (org_id, quote_ref, subject, negotiated_seats, requested_seats, plan_tier, status,
         valid_until, created_by_id, approved_at, created_at, updated_at)
      VALUES
        (${org1Id}, ${quoteRef}, 'C1 measurement fixture', 600, 600, 'ENTERPRISE', 'ACCEPTED',
         (now() + interval '30 days')::date, ${userId}, now(), now(), now())
      RETURNING id
    `;
    if (quote) {
      enterpriseQuoteId = quote.id;
      console.log(`Created enterprise_quotes seat-wall fixture id=${enterpriseQuoteId}`);
    }
  } else {
    console.log(`Existing ACCEPTED enterprise_quotes row covers ORG1`);
  }

  sessionId = `c1-capture-${randomUUID()}`;
  await sql`
    INSERT INTO user_sessions (id, user_id, is_revoked, last_active, expires_at, created_at)
    VALUES (${sessionId}, ${userId}, false, now(), now() + interval '20 minutes', now())
  `;
  console.log(`Created session ${mask(sessionId)}`);

  const token1 = await mintToken(userId, sessionId, org1Id);
  const token2 = await mintToken(userId, sessionId, org2Id);

  const captureEnv = {
    ...process.env,
    PEOPLE_CAPTURE_API_URL: "http://127.0.0.1:1500",
    PEOPLE_CAPTURE_TOKEN: token1,
    PEOPLE_CAPTURE_ORG_ID: org1Id,
    PEOPLE_CAPTURE_SECOND_ORG_ID: org2Id,
    PEOPLE_CAPTURE_SECOND_ORG_TOKEN: token2,
    PEOPLE_CAPTURE_DATABASE_URL: DB_URL,
    PEOPLE_CAPTURE_OUT: OUT,
  };

  console.log("\nRunning people-request-capture.mjs ...");
  const result = spawnSync("node", [HARNESS], {
    env: captureEnv,
    stdio: "inherit",
    cwd: "D:/projects/personal/Streamlineos/backend",
  });

  console.log(`\nHarness exit code: ${result.status}`);
} catch (err) {
  console.error("run-c1-setup failed:", err instanceof Error ? err.message : err);
} finally {
  if (enterpriseQuoteId !== null) {
    await sql`DELETE FROM enterprise_quotes WHERE id = ${enterpriseQuoteId}`.catch(() => undefined);
    const rem = await sql`SELECT count(*) AS n FROM enterprise_quotes WHERE id = ${enterpriseQuoteId}`.catch(() => [{ n: "?" }]);
    console.log(`enterprise_quotes fixture deleted, remaining=${rem[0].n}`);
  }
  if (sessionId !== null) {
    await sql`DELETE FROM user_sessions WHERE id = ${sessionId}`.catch(() => undefined);
    const rem = await sql`SELECT count(*) AS n FROM user_sessions WHERE id = ${sessionId}`.catch(() => [{ n: "?" }]);
    console.log(`Session deleted, remaining=${rem[0].n}`);
  }
  await sql.end({ timeout: 5 }).catch(() => undefined);
}
