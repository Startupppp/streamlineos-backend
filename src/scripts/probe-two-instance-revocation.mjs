import { readFileSync } from "node:fs";
import postgres from "postgres";
import { SignJWT } from "jose";
import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

const ENV_FILE = process.env.PROBE_ENV_FILE ?? "D:/agent-work/disposable.env";
const INSTANCE_A = process.env.PROBE_INSTANCE_A ?? "http://127.0.0.1:1500";
const INSTANCE_B = process.env.PROBE_INSTANCE_B ?? "http://127.0.0.1:1501";
const USER_ID = "bbbbbbbb-9999-0000-0000-000000000002";
const PROBE_PATH = "/me/access";
const SESSION_PROOF_ISSUER = "streamlineos-web-session-proof";
const SESSION_PROOF_AUDIENCE = "streamlineos-api-exchange";

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

const env = parseEnvFile(ENV_FILE);
const results = [];
const log = (m) => console.log(m);

function record(id, status, detail) {
  results.push({ id, status, detail });
  log(`[${status}] ${id} — ${detail}`);
}

async function probe(base, token) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}${PROBE_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, ms: Date.now() - started };
  } catch (err) {
    return {
      status: 0,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function pollUntilDenied(base, token, budgetMs) {
  const started = Date.now();
  let attempts = 0;
  let lastStatus = 0;
  while (Date.now() - started < budgetMs) {
    attempts += 1;
    const r = await probe(base, token);
    lastStatus = r.status;
    if (r.status === 401)
      return { denied: true, attempts, elapsedMs: Date.now() - started };
    await new Promise((r2) => setTimeout(r2, 250));
  }
  return {
    denied: false,
    attempts,
    elapsedMs: Date.now() - started,
    lastStatus,
  };
}

async function main() {
  const sql = postgres(env.DATABASE_URL, { max: 2, prepare: false });
  const redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });

  const sessionId = randomUUID();
  const tombstoneKey = `revoked:session:${sessionId}`;
  let cleanupNeeded = false;

  try {
    const [reachableA, reachableB] = await Promise.all([
      fetch(`${INSTANCE_A}/health`).then((r) => r.status).catch(() => 0),
      fetch(`${INSTANCE_B}/health`).then((r) => r.status).catch(() => 0),
    ]);
    if (reachableA !== 200 || reachableB !== 200) {
      record(
        "PRECONDITION-TWO-INSTANCES",
        "NOT-RUN",
        `instance A /health=${reachableA}, instance B /health=${reachableB}; both must be 200`,
      );
      return;
    }
    record(
      "PRECONDITION-TWO-INSTANCES",
      "PASS",
      `A=${INSTANCE_A} and B=${INSTANCE_B} both healthy, sharing DB and Redis`,
    );

    const orgRows = await sql`
      SELECT org_id FROM organization_members
      WHERE user_id = ${USER_ID} AND status = 'ACTIVE'
      LIMIT 1`;
    if (orgRows.length === 0) {
      record("PRECONDITION-FIXTURE", "NOT-RUN", `no active membership for ${USER_ID}`);
      return;
    }
    const orgId = orgRows[0].org_id;

    await sql`
      INSERT INTO user_sessions (id, user_id, is_revoked, expires_at)
      VALUES (${sessionId}, ${USER_ID}, false, now() + interval '2 hours')`;
    cleanupNeeded = true;
    await redis.del(tombstoneKey);

    const proof = await new SignJWT({ sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER_ID)
      .setIssuer(SESSION_PROOF_ISSUER)
      .setAudience(SESSION_PROOF_AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(env.NEXTAUTH_SECRET));

    const exchange = await fetch(`${INSTANCE_A}/auth/session-exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": env.INTERNAL_API_SECRET,
        "x-session-proof": proof,
      },
      body: JSON.stringify({ orgId }),
    });
    if (exchange.status !== 200) {
      record(
        "PRECONDITION-EXCHANGE",
        "NOT-RUN",
        `session-exchange returned ${exchange.status}; cannot mint a backend JWT`,
      );
      return;
    }
    const payload = await exchange.json();
    const token = payload?.data?.token ?? payload?.token;
    if (typeof token !== "string" || token.length === 0) {
      record("PRECONDITION-EXCHANGE", "NOT-RUN", "session-exchange returned no token field");
      return;
    }
    record(
      "PRECONDITION-EXCHANGE",
      "PASS",
      `minted a backend JWT for a fresh session on instance A (sessionId withheld)`,
    );

    const baselineA = await probe(INSTANCE_A, token);
    const baselineB = await probe(INSTANCE_B, token);
    if (baselineA.status !== 200 || baselineB.status !== 200) {
      record(
        "BASELINE-BOTH-ACCEPT",
        "FAIL",
        `expected 200 from both before revocation; A=${baselineA.status} B=${baselineB.status}`,
      );
      return;
    }
    record(
      "BASELINE-BOTH-ACCEPT",
      "PASS",
      `A=200 (${baselineA.ms}ms) and B=200 (${baselineB.ms}ms) — the same session is live on both instances`,
    );

    await redis.set(tombstoneKey, true);
    const tombA = await pollUntilDenied(INSTANCE_A, token, 15000);
    const tombB = await pollUntilDenied(INSTANCE_B, token, 15000);
    record(
      "CASE1-SHARED-TOMBSTONE",
      tombA.denied && tombB.denied ? "PASS" : "FAIL",
      tombA.denied && tombB.denied
        ? `tombstone written on the shared cache only (DB flag still false): A denied on request ${tombA.attempts} after ${tombA.elapsedMs}ms, B denied on request ${tombB.attempts} after ${tombB.elapsedMs}ms — the instance that never wrote it denies on its very next request`
        : `A denied=${tombA.denied} (last ${tombA.lastStatus}), B denied=${tombB.denied} (last ${tombB.lastStatus}) within 15000ms`,
    );

    await redis.del(tombstoneKey);
    const restoredA = await probe(INSTANCE_A, token);
    const restoredB = await probe(INSTANCE_B, token);
    record(
      "CASE1-RESTORE",
      restoredA.status === 200 && restoredB.status === 200 ? "PASS" : "FAIL",
      `after deleting the tombstone with the DB flag still false: A=${restoredA.status}, B=${restoredB.status} (expected 200/200 — confirms case 1 was the tombstone and nothing else)`,
    );

    await sql`UPDATE user_sessions SET is_revoked = true WHERE id = ${sessionId}`;
    const dbA = await pollUntilDenied(INSTANCE_A, token, 15000);
    const dbB = await pollUntilDenied(INSTANCE_B, token, 15000);
    const tombstoneAfter = await redis.get(tombstoneKey);
    record(
      "CASE2-FAILED-SHARED-CLEAR",
      dbA.denied && dbB.denied ? "PASS" : "FAIL",
      dbA.denied && dbB.denied
        ? `DB is_revoked=true with NO tombstone present (get=${JSON.stringify(tombstoneAfter)}): A denied on request ${dbA.attempts} after ${dbA.elapsedMs}ms, B denied on request ${dbB.attempts} after ${dbB.elapsedMs}ms — an absent tombstone is a cache MISS that falls through to the DB authority, so a failed shared clear does not extend the window`
        : `A denied=${dbA.denied} (last ${dbA.lastStatus}), B denied=${dbB.denied} (last ${dbB.lastStatus}) within 15000ms`,
    );

    await sql`UPDATE user_sessions SET is_revoked = false WHERE id = ${sessionId}`;
    const finalA = await probe(INSTANCE_A, token);
    const finalB = await probe(INSTANCE_B, token);
    record(
      "CASE2-RESTORE",
      finalA.status === 200 && finalB.status === 200 ? "PASS" : "FAIL",
      `after clearing the DB flag with no tombstone: A=${finalA.status}, B=${finalB.status} (expected 200/200 — confirms case 2 denial came from the DB flag)`,
    );

    const worstAttempts = Math.max(
      tombA.attempts,
      tombB.attempts,
      dbA.attempts,
      dbB.attempts,
    );
    record(
      "OBSERVED-FAILURE-BOUND",
      worstAttempts === 1 ? "PASS" : "FAIL",
      worstAttempts === 1
        ? "maximum observed stale window across both instances and both revocation authorities is ZERO additional accepted requests — every revocation took effect on the next request on the instance that did not perform it"
        : `an instance accepted ${worstAttempts - 1} request(s) after revocation; the stale window is not zero`,
    );
  } finally {
    if (cleanupNeeded) {
      await redis.del(tombstoneKey).catch(() => {});
      await sql`DELETE FROM user_sessions WHERE id = ${sessionId}`.catch(() => {});
    }
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => r.status === "FAIL");
    const notRun = results.filter((r) => r.status === "NOT-RUN");
    console.log(
      `\nRESULT: ${results.filter((r) => r.status === "PASS").length} PASS / ${failed.length} FAIL / ${notRun.length} NOT-RUN`,
    );
    process.exit(failed.length > 0 || notRun.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error(`probe crashed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
