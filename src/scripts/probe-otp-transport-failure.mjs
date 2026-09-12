/**
 * Provider-failure and supersession proof for the email OTP path (ID-R4a(c)).
 *
 * The recorded live ZeptoMail SUCCESS already proves a delivered code matches the stored
 * digest. What was never proved is the failure direction: that a send which does not reach
 * the provider burns the code it could not deliver, so an undelivered credential can never
 * be redeemed. This drives that against a real backend whose ZEPTOMAIL_API_URL points at a
 * dead local port, so the transport genuinely fails and nothing leaves the machine.
 *
 * It also proves the invariant that makes delivery ORDER irrelevant: with two live codes,
 * only the newest verifies. Two emails arriving out of order cannot promote a superseded
 * code, because the older row is already used_at-stamped before the newer one is sent.
 *
 * No credential is printed. Every row created is removed and the removal asserted.
 *
 *   OTP_FAIL_PROBE_BASE_URL=http://127.0.0.1:1600 \
 *   OTP_FAIL_PROBE_DATABASE_URL=postgresql://neondb_owner@127.0.0.1:5432/scratch_local?sslmode=disable \
 *     node src/scripts/probe-otp-transport-failure.mjs [--allow-remote]
 *   node src/scripts/probe-otp-transport-failure.mjs --self-test
 *
 * Pass criteria: exit 0 and every line PASS.
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
}

const hashToken = (raw) => createHash("sha256").update(raw).digest("hex");
const isLoopback = (h) => h === "127.0.0.1" || h === "::1" || h === "localhost";

export function resolveTargets(env, allowRemote) {
  const base = env["OTP_FAIL_PROBE_BASE_URL"];
  const db = env["OTP_FAIL_PROBE_DATABASE_URL"];
  if (!base) throw new Error("OTP_FAIL_PROBE_BASE_URL is required");
  if (!db) throw new Error("OTP_FAIL_PROBE_DATABASE_URL is required; DATABASE_URL is not a fallback");
  const bh = new URL(base).hostname;
  const dh = new URL(db).hostname;
  if (!allowRemote && !isLoopback(bh)) throw new Error(`refusing non-loopback API host ${bh}`);
  if (!allowRemote && !isLoopback(dh)) throw new Error(`refusing non-loopback database host ${dh}`);
  if (bh !== dh) throw new Error(`API host ${bh} and database host ${dh} differ`);
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
  const payload = parsed !== null && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
  return { status: res.status, code: parsed?.code ?? null, ok: payload?.ok === true };
}

function selfTest() {
  const cases = [
    ["missing base url", {}, false],
    ["missing database url", { OTP_FAIL_PROBE_BASE_URL: "http://127.0.0.1:1600" }, false],
    [
      "DATABASE_URL is not a fallback",
      { OTP_FAIL_PROBE_BASE_URL: "http://127.0.0.1:1600", DATABASE_URL: "postgresql://x@127.0.0.1:5432/y" },
      false,
    ],
    [
      "loopback pair accepted",
      {
        OTP_FAIL_PROBE_BASE_URL: "http://127.0.0.1:1600",
        OTP_FAIL_PROBE_DATABASE_URL: "postgresql://u@127.0.0.1:5432/scratch_local",
      },
      true,
    ],
    [
      "remote refused without the flag",
      {
        OTP_FAIL_PROBE_BASE_URL: "https://api.example.com",
        OTP_FAIL_PROBE_DATABASE_URL: "postgresql://u@api.example.com:5432/p",
      },
      false,
    ],
    [
      "mismatched hosts refused",
      {
        OTP_FAIL_PROBE_BASE_URL: "http://127.0.0.1:1600",
        OTP_FAIL_PROBE_DATABASE_URL: "postgresql://u@10.0.0.5:5432/p",
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
}

async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    console.log(results.join("\n"));
    console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }

  const { base, db } = resolveTargets(process.env, process.argv.includes("--allow-remote"));
  const sql = postgres(db, { max: 2, prepare: false });
  const [{ d }] = await sql`select current_database() as d`;
  console.log(`api:      ${base}`);
  console.log(`database: ${d}\n`);

  const userId = randomUUID();
  const email = `s0-otp-fail-${userId.slice(0, 8)}@probe.invalid`;

  try {
    await sql`insert into users (id, email, is_active) values (${userId}, ${email}, true)`;

    const requested = await post(base, "/auth/email-otp", { email });
    check("a send the transport cannot deliver returns 503", requested.status, 503);

    const rows = await sql`select used_at from email_otp_codes where user_id = ${userId}`;
    check("NEUTER the code row really was inserted before the send", rows.length, 1);
    check("the undeliverable code is burned, so it can never be redeemed", rows[0]?.used_at !== null, true);

    const anyCode = await post(base, "/auth/email-otp/verify", { email, code: "123456" });
    check("no code is redeemable after a failed send", anyCode.status, 401);

    await sql`delete from email_otp_codes where user_id = ${userId}`;
    const older = "111111";
    const newer = "222222";
    await sql`insert into email_otp_codes (user_id, code_hash, expires_at, attempts, created_at)
              values (${userId}, ${hashToken(older)}, now() + interval '10 minutes', 0, now() - interval '2 minutes')`;
    await sql`insert into email_otp_codes (user_id, code_hash, expires_at, attempts, created_at)
              values (${userId}, ${hashToken(newer)}, now() + interval '10 minutes', 0, now())`;

    const supersededAttempt = await post(base, "/auth/email-otp/verify", { email, code: older });
    check("a superseded code is refused even though it is unexpired and unused", supersededAttempt.status, 401);

    const newestAttempt = await post(base, "/auth/email-otp/verify", { email, code: newer });
    check("the newest code verifies, so the refusal above is not a blanket rejection", newestAttempt.status, 200);

    const consumed = await sql`select count(*)::int n from email_otp_codes
                               where user_id = ${userId} and used_at is not null`;
    check("exactly one code was consumed", consumed[0].n, 1);
  } finally {
    await sql`delete from magic_link_tokens where user_id = ${userId}`.catch(() => undefined);
    await sql`delete from email_otp_codes where user_id = ${userId}`.catch(() => undefined);
    await sql`delete from users where id = ${userId}`.catch(() => undefined);
    const [{ n }] = await sql`select count(*)::int n from users where id = ${userId}`;
    check("cleanup removed the probe user", n, 0);
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
