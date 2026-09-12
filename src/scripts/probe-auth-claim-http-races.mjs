/**
 * HTTP-layer proof of the auth claim races (ID-R2a).
 *
 * The service-level evidence lives in auth-email-verification-consume.spec.ts and the
 * handwritten-SQL evidence in verify-auth-claim-races.mjs. Neither covers the controller
 * round trip, and createE2eApp() cannot: it overrides DRIZZLE so controller specs need no
 * database, so it can never assert "exactly one row exists afterwards".
 *
 * Two concurrent POST /auth/verify-email with the same token  -> one 200, one 400, one row.
 * Two concurrent POST /auth/email-otp/verify with the same code -> one success, one refusal.
 *
 * Neither credential is ever printed. Every row created is removed and the removal asserted.
 *
 *   AUTH_HTTP_RACE_BASE_URL=http://127.0.0.1:1600 \
 *   AUTH_HTTP_RACE_DATABASE_URL=postgresql://neondb_owner@127.0.0.1:5432/scratch_local?sslmode=disable \
 *     node src/scripts/probe-auth-claim-http-races.mjs [--allow-remote]
 *   node src/scripts/probe-auth-claim-http-races.mjs --self-test
 *
 * Pass criteria: exit 0 and every line PASS. Exit 1 on any failure or refusal.
 */
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";

const results = [];
let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  results.push(
    `${ok ? "PASS" : "FAIL"}  ${label}` +
      (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`),
  );
  return ok;
}

const hashToken = (raw) => createHash("sha256").update(raw).digest("hex");

function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function resolveTargets(env, allowRemote) {
  const base = env["AUTH_HTTP_RACE_BASE_URL"];
  const db = env["AUTH_HTTP_RACE_DATABASE_URL"];
  if (!base) throw new Error("AUTH_HTTP_RACE_BASE_URL is required");
  if (!db) throw new Error("AUTH_HTTP_RACE_DATABASE_URL is required; DATABASE_URL is not a fallback");
  const baseHost = new URL(base).hostname;
  const dbHost = new URL(db).hostname;
  if (!allowRemote && !isLoopback(baseHost)) throw new Error(`refusing non-loopback API host ${baseHost}`);
  if (!allowRemote && !isLoopback(dbHost)) throw new Error(`refusing non-loopback database host ${dbHost}`);
  if (baseHost !== dbHost) throw new Error(`API host ${baseHost} and database host ${dbHost} differ`);
  return { base: base.replace(/\/$/, ""), db };
}

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, code: parsed?.code ?? null, ok: parsed?.success === true };
}

function selfTest() {
  const cases = [
    ["missing base url", {}, false],
    ["missing database url", { AUTH_HTTP_RACE_BASE_URL: "http://127.0.0.1:1600" }, false],
    [
      "DATABASE_URL is not a fallback",
      { AUTH_HTTP_RACE_BASE_URL: "http://127.0.0.1:1600", DATABASE_URL: "postgresql://x@127.0.0.1:5432/y" },
      false,
    ],
    [
      "loopback pair accepted",
      {
        AUTH_HTTP_RACE_BASE_URL: "http://127.0.0.1:1600",
        AUTH_HTTP_RACE_DATABASE_URL: "postgresql://u@127.0.0.1:5432/scratch_local",
      },
      true,
    ],
    [
      "remote refused without the flag",
      {
        AUTH_HTTP_RACE_BASE_URL: "https://api.example.com",
        AUTH_HTTP_RACE_DATABASE_URL: "postgresql://u@api.example.com:5432/p",
      },
      false,
    ],
    [
      "mismatched hosts refused",
      {
        AUTH_HTTP_RACE_BASE_URL: "http://127.0.0.1:1600",
        AUTH_HTTP_RACE_DATABASE_URL: "postgresql://u@10.0.0.5:5432/p",
      },
      false,
    ],
  ];
  for (const [label, env, shouldPass] of cases) {
    let passed = true;
    try {
      resolveTargets(env, false);
    } catch {
      passed = false;
    }
    check(label, passed, shouldPass);
  }
  let remoteAllowed = true;
  try {
    resolveTargets(
      {
        AUTH_HTTP_RACE_BASE_URL: "https://api.example.com",
        AUTH_HTTP_RACE_DATABASE_URL: "postgresql://u@api.example.com:5432/p",
      },
      true,
    );
  } catch {
    remoteAllowed = false;
  }
  check("remote allowed with --allow-remote", remoteAllowed, true);
}

async function main() {
  const allowRemote = process.argv.includes("--allow-remote");

  if (process.argv.includes("--self-test")) {
    selfTest();
    console.log(results.join("\n"));
    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }

  const { base, db } = resolveTargets(process.env, allowRemote);
  const sql = postgres(db, { max: 4, prepare: false });
  const [{ d }] = await sql`select current_database() as d`;
  console.log(`api:      ${base}`);
  console.log(`database: ${d}\n`);

  const userId = randomUUID();
  const email = `s0-http-race-${userId.slice(0, 8)}@probe.invalid`;

  try {
    await sql`insert into users (id, email, is_active) values (${userId}, ${email}, true)`;

    // --- neuter: the endpoint is not blanket-accepting ---
    const junk = await post(base, "/auth/verify-email", { token: randomUUID() });
    check("NEUTER a junk verification token is refused", junk.status, 400);

    // --- neuter: the endpoint is not blanket-rejecting ---
    const soloRaw = randomUUID();
    await sql`insert into verification_tokens (identifier, token, expires)
              values (${email}, ${hashToken(soloRaw)}, now() + interval '1 hour')`;
    const solo = await post(base, "/auth/verify-email", { token: soloRaw });
    check("NEUTER a single valid verification token succeeds", solo.status, 200);
    await sql`delete from magic_link_tokens where user_id = ${userId}`;

    // --- case 1: two concurrent verify-email with the same token ---
    const raw = randomUUID();
    await sql`insert into verification_tokens (identifier, token, expires)
              values (${email}, ${hashToken(raw)}, now() + interval '1 hour')`;

    const [a, b] = await Promise.all([
      post(base, "/auth/verify-email", { token: raw }),
      post(base, "/auth/verify-email", { token: raw }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    check("two concurrent verify-email yield exactly one 200 and one 400", statuses, [200, 400]);
    const loser = a.status === 400 ? a : b;
    check("the loser reports AUTH_TOKEN_INVALID", loser.code, "AUTH_TOKEN_INVALID");

    const [{ n: mlt }] = await sql`select count(*)::int n from magic_link_tokens where user_id = ${userId}`;
    check("exactly one magic_link_tokens row was minted", mlt, 1);
    const [{ n: leftover }] = await sql`select count(*)::int n from verification_tokens where identifier = ${email}`;
    check("the claimed verification token is gone", leftover, 0);

    // --- case 2: two concurrent otp verify with the same code ---
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await sql`delete from email_otp_codes where user_id = ${userId}`;
    await sql`insert into email_otp_codes (user_id, code_hash, expires_at, attempts)
              values (${userId}, ${hashToken(code)}, now() + interval '10 minutes', 0)`;

    const [c, e] = await Promise.all([
      post(base, "/auth/email-otp/verify", { email, code }),
      post(base, "/auth/email-otp/verify", { email, code }),
    ]);
    const successes = [c, e].filter((r) => r.status === 200).length;
    check("two concurrent otp verifies yield exactly one success", successes, 1);
    const refusals = [c, e].filter((r) => r.status !== 200).length;
    check("and exactly one refusal", refusals, 1);

    const [{ n: consumed }] =
      await sql`select count(*)::int n from email_otp_codes where user_id = ${userId} and used_at is not null`;
    check("the code was consumed exactly once", consumed, 1);
  } finally {
    await sql`delete from email_otp_codes where user_id = ${userId}`.catch(() => undefined);
    await sql`delete from magic_link_tokens where user_id = ${userId}`.catch(() => undefined);
    await sql`delete from verification_tokens where identifier = ${email}`.catch(() => undefined);
    await sql`delete from users where id = ${userId}`.catch(() => undefined);
    const [{ n: residue }] = await sql`select count(*)::int n from users where id = ${userId}`;
    check("cleanup removed the probe user", residue, 0);
    await sql.end();
  }

  console.log(results.join("\n"));
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`ERR ${err.message}`);
  process.exit(1);
});
