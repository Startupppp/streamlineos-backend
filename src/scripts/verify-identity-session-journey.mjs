#!/usr/bin/env node
/**
 * Drives the identity journey end to end over REAL HTTP against a running API and
 * a real PostgreSQL, with no email: the OTP row is seeded directly, so the code
 * is known without a provider send.
 *
 * What only this can prove, which unit tests cannot:
 *   - two device sessions for one account are genuinely distinct sessions,
 *   - each exchanges for a backend JWT carrying ITS OWN sessionId claim (I1),
 *   - revoking one device leaves the other usable,
 *   - a session revoked in the database with NO Redis tombstone is refused at
 *     the mint boundary — the cache-miss fall-through, which is the path that
 *     previously skipped the database entirely.
 *
 * Safety: takes its own JOURNEY_PROBE_DATABASE_URL and never falls back to
 * DATABASE_URL. Refuses a non-loopback database or API. Creates only rows it
 * prefixes with its run id and removes them in a finally.
 */
import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import { SignJWT, decodeJwt } from "jose";

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const RUN = `journey_${Date.now().toString(36)}`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

export function validate(env, argv) {
  const apiUrl = (argv.find((a) => a.startsWith("--api-url=")) ?? "").slice(10) || "http://127.0.0.1:1500";
  const db = env.JOURNEY_PROBE_DATABASE_URL;
  if (!db)
    return {
      ok: false,
      reason:
        "JOURNEY_PROBE_DATABASE_URL is required. This probe writes rows; it deliberately does not fall back to DATABASE_URL.",
    };
  if (!isLoopback(db)) return { ok: false, reason: "Refusing a non-loopback database target." };
  if (!isLoopback(apiUrl)) return { ok: false, reason: "Refusing a non-loopback API target." };
  if (!env.INTERNAL_API_SECRET) return { ok: false, reason: "INTERNAL_API_SECRET is required to call the internal routes." };
  if (!env.NEXTAUTH_SECRET) return { ok: false, reason: "NEXTAUTH_SECRET is required to sign a session proof." };
  return { ok: true, db, apiUrl };
}

const results = [];
function record(name, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      expected ${JSON.stringify(expected)} · got ${JSON.stringify(actual)}`);
}

async function post(apiUrl, path, body, headers = {}) {
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const payload =
    parsed && typeof parsed === "object" && parsed.success === true && "data" in parsed
      ? parsed.data
      : parsed;
  return { status: res.status, payload };
}

async function signProof(userId, sessionId, secret) {
  return new SignJWT({ sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("streamlineos-web-session-proof")
    .setAudience("streamlineos-api-exchange")
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(new TextEncoder().encode(secret));
}

async function main() {
  const checked = validate(process.env, args);
  if (!checked.ok) {
    console.error(`REFUSED: ${checked.reason}`);
    process.exit(1);
  }

  const { db: dbUrl, apiUrl } = checked;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const nextAuthSecret = process.env.NEXTAUTH_SECRET;
  const sql = postgres(dbUrl, { prepare: false, max: 4 });
  const userId = randomUUID();
  const email = `${RUN}@probe.invalid`;

  try {
    const health = await fetch(`${apiUrl}/health`);
    console.log(`api ${apiUrl} health=${health.status}`);
    console.log(`db  ${(await sql`select version()`)[0].version.split(",")[0]}\n`);

    await sql`insert into users (id, email, is_active, email_verified)
              values (${userId}, ${email}, true, now())`;

    // Establish two device sessions the way the product does: seed an OTP, verify
    // it for an auto-login token, then redeem that token for a device session.
    async function establishSession(code) {
      await sql`insert into email_otp_codes (user_id, code_hash, expires_at, attempts)
                values (${userId}, ${sha256(code)}, now() + interval '10 minutes', 0)`;
      const verified = await post(apiUrl, "/auth/email-otp/verify", { email, code });
      if (verified.status !== 200 || typeof verified.payload?.autoLoginToken !== "string")
        throw new Error(`otp verify failed: ${verified.status} ${JSON.stringify(verified.payload)}`);
      const redeemed = await post(apiUrl, "/auth/magic-link/verify", {
        token: verified.payload.autoLoginToken,
      });
      if (redeemed.status !== 200 || typeof redeemed.payload?.sessionId !== "string")
        throw new Error(`magic verify failed: ${redeemed.status} ${JSON.stringify(redeemed.payload)}`);
      return redeemed.payload.sessionId;
    }

    const sessionA = await establishSession("111111");
    const sessionB = await establishSession("222222");

    record("journey: two sign-ins yield two DISTINCT device sessions", true, sessionA !== sessionB);

    const rows = await sql`select id, is_revoked from user_sessions where user_id = ${userId}`;
    record("journey: both device sessions are registered in user_sessions", 2, rows.length);

    // I1 end to end: each session must mint a JWT bound to ITS OWN sessionId.
    async function exchange(sessionId) {
      const proof = await signProof(userId, sessionId, nextAuthSecret);
      return post(
        apiUrl,
        "/auth/session-exchange",
        { orgId: null },
        { "x-internal-secret": internalSecret, "x-session-proof": proof },
      );
    }

    const exA = await exchange(sessionA);
    const exB = await exchange(sessionB);
    record("I1: both sessions mint a backend JWT", [200, 200], [exA.status, exB.status]);

    const claimA = decodeJwt(exA.payload.token);
    const claimB = decodeJwt(exB.payload.token);
    record(
      "I1: each JWT carries its OWN sessionId claim, not the other's",
      [sessionA, sessionB],
      [claimA.sessionId, claimB.sessionId],
    );
    record("I1: the two minted tokens are not the same string", true, exA.payload.token !== exB.payload.token);

    // Revoke A in the database only. No tombstone is written, so this is exactly
    // the cache-miss path that previously skipped the database at the mint boundary.
    await sql`update user_sessions set is_revoked = true where id = ${sessionA}`;

    const afterRevokeA = await exchange(sessionA);
    record(
      "exchange: a session revoked in the DB with NO tombstone is refused (cache-miss fall-through)",
      401,
      afterRevokeA.status,
    );

    const afterRevokeB = await exchange(sessionB);
    record("revocation: revoking device A leaves device B usable", 200, afterRevokeB.status);

    const unknown = await exchange(randomUUID());
    record("exchange: an unregistered session id is refused", 401, unknown.status);

    await sql`update users set is_active = false where id = ${userId}`;
    await new Promise((r) => setTimeout(r, 1_500));
    const afterCacheExpiry = await exchange(sessionB);
    record(
      "exchange: once the membership cache expires, a deactivated account can no longer mint",
      401,
      afterCacheExpiry.status,
    );
  } finally {
    await sql`delete from user_sessions where user_id = ${userId}`.catch(() => undefined);
    await sql`delete from email_otp_codes where user_id = ${userId}`.catch(() => undefined);
    await sql`delete from magic_link_tokens where user_id = ${userId}`.catch(() => undefined);
    await sql`delete from login_history where user_id = ${userId}`.catch(() => undefined);
    await sql`delete from users where id = ${userId}`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} journey invariants held`);
  if (failed.length > 0) process.exit(1);
}

if (SELF_TEST) {
  const checks = [
    ["a missing database var is refused", validate({}, []).ok === false],
    [
      "a remote database is refused",
      validate(
        {
          JOURNEY_PROBE_DATABASE_URL: "postgres://u:p@db.example.com/x",
          INTERNAL_API_SECRET: "s",
          NEXTAUTH_SECRET: "s",
        },
        [],
      ).ok === false,
    ],
    [
      "a remote api is refused",
      validate(
        {
          JOURNEY_PROBE_DATABASE_URL: "postgres://u:p@127.0.0.1/x",
          INTERNAL_API_SECRET: "s",
          NEXTAUTH_SECRET: "s",
        },
        ["--api-url=https://api.example.com"],
      ).ok === false,
    ],
    [
      "a missing internal secret is refused",
      validate({ JOURNEY_PROBE_DATABASE_URL: "postgres://u:p@127.0.0.1/x", NEXTAUTH_SECRET: "s" }, [])
        .ok === false,
    ],
    [
      "a complete loopback invocation is accepted",
      validate(
        {
          JOURNEY_PROBE_DATABASE_URL: "postgres://u:p@127.0.0.1/x",
          INTERNAL_API_SECRET: "s",
          NEXTAUTH_SECRET: "s",
        },
        [],
      ).ok === true,
    ],
    ["a bare word is not loopback", isLoopback("nope") === false],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) bad += 1;
  }
  process.exit(bad === 0 ? 0 : 1);
} else {
  main().catch((error) => {
    console.error(`journey failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
