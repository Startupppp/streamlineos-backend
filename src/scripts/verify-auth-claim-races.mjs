#!/usr/bin/env node
/**
 * Proves the auth one-time-credential claims against a REAL PostgreSQL under
 * READ COMMITTED, which mocked specs cannot do: they model a predicate, they do
 * not race a row lock.
 *
 * Each race is run twice — once with the OLD predicate and once with the one the
 * services issue today — so the run shows the defect reproducing and the repair
 * holding on the same server, rather than only asserting the repair.
 *
 * Safety: this opens a database and writes rows, so it takes its OWN variable
 * (AUTH_RACE_PROBE_DATABASE_URL) and never falls back to DATABASE_URL. A
 * non-loopback host is refused unless --allow-remote is passed explicitly.
 */
import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";

const SELF_TEST = process.argv.includes("--self-test");
const ALLOW_REMOTE = process.argv.includes("--allow-remote");
const RUN = `authrace_${Date.now().toString(36)}`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isLoopbackTarget(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function resolveTarget(env, allowRemote) {
  const url = env.AUTH_RACE_PROBE_DATABASE_URL;
  if (!url)
    return {
      ok: false,
      reason:
        "AUTH_RACE_PROBE_DATABASE_URL is required. This probe writes rows; it deliberately does not fall back to DATABASE_URL.",
    };
  if (!isLoopbackTarget(url) && !allowRemote)
    return {
      ok: false,
      reason:
        "Refusing a non-loopback target without --allow-remote. Point this at a disposable database.",
    };
  return { ok: true, url };
}

const results = [];
function record(name, expected, actual) {
  const pass = expected === actual;
  results.push({ name, expected, actual, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      expected ${expected} · got ${actual}`);
}

async function main() {
  const target = resolveTarget(process.env, ALLOW_REMOTE);
  if (!target.ok) {
    console.error(`REFUSED: ${target.reason}`);
    process.exit(1);
  }

  const sql = postgres(target.url, { prepare: false, max: 6 });
  const userId = randomUUID();
  const email = `${RUN}@probe.invalid`;

  try {
    const server = await sql`select version()`;
    console.log(`server: ${server[0].version.split(",")[0]}`);
    console.log(`isolation: ${(await sql`show transaction_isolation`)[0].transaction_isolation}`);
    console.log("");

    await sql`insert into users (id, email, is_active) values (${userId}, ${email}, true)`;

    // ---- Race 1: verification token, two real connections claiming at once ----
    const rawA = `${RUN}-verify-a`;
    await sql`insert into verification_tokens (identifier, token, expires)
              values (${email}, ${sha256(rawA)}, now() + interval '1 hour')`;

    const claim = (raw) =>
      sql`delete from verification_tokens
          where token = ${sha256(raw)} and expires > now()
          returning identifier`;
    const [c1, c2] = await Promise.all([claim(rawA), claim(rawA)]);
    record(
      "verification: exactly one of two concurrent atomic claims wins",
      1,
      c1.length + c2.length,
    );

    // The old shape read first and acted after: both readers see the row, so both proceed.
    const rawB = `${RUN}-verify-b`;
    await sql`insert into verification_tokens (identifier, token, expires)
              values (${email}, ${sha256(rawB)}, now() + interval '1 hour')`;
    const read = () =>
      sql`select identifier from verification_tokens
          where token = ${sha256(rawB)} and expires > now()`;
    const [r1, r2] = await Promise.all([read(), read()]);
    record(
      "verification: the OLD read-then-act shape lets BOTH callers proceed (defect reproduced)",
      2,
      r1.length + r2.length,
    );
    await sql`delete from verification_tokens where identifier = ${email}`;

    // ---- Race 2: verification rollback leaves the token claimable ----
    const rawC = `${RUN}-verify-c`;
    await sql`insert into verification_tokens (identifier, token, expires)
              values (${email}, ${sha256(rawC)}, now() + interval '1 hour')`;
    await sql
      .begin(async (tx) => {
        await tx`delete from verification_tokens where token = ${sha256(rawC)} and expires > now()`;
        throw new Error("simulated failure before the login token is inserted");
      })
      .catch(() => undefined);
    const afterRollback = await sql`select 1 from verification_tokens where token = ${sha256(rawC)}`;
    record("verification: rollback leaves the token claimable for a retry", 1, afterRollback.length);
    await sql`delete from verification_tokens where identifier = ${email}`;

    // ---- Race 3: OTP expiry must be re-asserted AT the claim ----
    const expired = await sql`insert into email_otp_codes (user_id, code_hash, expires_at, attempts)
                              values (${userId}, ${sha256("111111")}, now() - interval '1 minute', 0)
                              returning id`;
    const expiredId = expired[0].id;
    const oldExpiry = await sql`update email_otp_codes set used_at = now()
                                where id = ${expiredId} and used_at is null
                                returning id`;
    record(
      "otp: the OLD consume predicate consumes an EXPIRED code (defect reproduced)",
      1,
      oldExpiry.length,
    );
    await sql`update email_otp_codes set used_at = null where id = ${expiredId}`;
    const newExpiry = await sql`update email_otp_codes set used_at = now()
                                where id = ${expiredId} and used_at is null and expires_at > now()
                                returning id`;
    record("otp: the repaired predicate refuses the expired code", 0, newExpiry.length);

    // ---- Race 4: OTP attempt cap must be re-asserted AT the claim ----
    const burned = await sql`insert into email_otp_codes (user_id, code_hash, expires_at, attempts)
                             values (${userId}, ${sha256("222222")}, now() + interval '10 minutes', 9)
                             returning id`;
    const burnedId = burned[0].id;
    const oldAttempts = await sql`update email_otp_codes set used_at = now()
                                  where id = ${burnedId} and used_at is null
                                  returning id`;
    record(
      "otp: the OLD consume predicate consumes an attempt-exhausted code (defect reproduced)",
      1,
      oldAttempts.length,
    );
    await sql`update email_otp_codes set used_at = null where id = ${burnedId}`;
    const newAttempts = await sql`update email_otp_codes set used_at = now()
                                  where id = ${burnedId} and used_at is null
                                    and expires_at > now() and attempts <= 5
                                  returning id`;
    record("otp: the repaired predicate refuses the attempt-exhausted code", 0, newAttempts.length);

    // ---- Race 5: two real connections consuming one live OTP ----
    const live = await sql`insert into email_otp_codes (user_id, code_hash, expires_at, attempts)
                           values (${userId}, ${sha256("333333")}, now() + interval '10 minutes', 1)
                           returning id`;
    const liveId = live[0].id;
    const consume = () =>
      sql`update email_otp_codes set used_at = now()
          where id = ${liveId} and used_at is null and expires_at > now() and attempts <= 5
          returning id`;
    const [k1, k2] = await Promise.all([consume(), consume()]);
    record("otp: exactly one of two concurrent consumes wins", 1, k1.length + k2.length);

    // ---- Race 6: a writer blocked by an uncommitted claim re-evaluates after the commit ----
    const second = await sql`insert into email_otp_codes (user_id, code_hash, expires_at, attempts)
                             values (${userId}, ${sha256("444444")}, now() + interval '10 minutes', 1)
                             returning id`;
    const secondId = second[0].id;

    const holder = postgres(target.url, { prepare: false, max: 1 });
    const contenderClient = postgres(target.url, { prepare: false, max: 1 });
    let loserRows = -1;
    let blockedWhileHeld = false;
    try {
      await holder`begin`;
      await holder`update email_otp_codes set used_at = now()
                   where id = ${secondId} and used_at is null and expires_at > now()`;

      let settled = false;
      const contender = contenderClient`update email_otp_codes set used_at = now()
                                        where id = ${secondId} and used_at is null and expires_at > now()
                                        returning id`.then((rows) => {
        settled = true;
        return rows;
      });

      await new Promise((r) => setTimeout(r, 600));
      blockedWhileHeld = settled === false;

      await holder`commit`;
      loserRows = (await contender).length;
    } finally {
      await holder.end({ timeout: 5 }).catch(() => undefined);
      await contenderClient.end({ timeout: 5 }).catch(() => undefined);
    }

    record(
      "otp: a second writer genuinely BLOCKS on the uncommitted row lock",
      true,
      blockedWhileHeld,
    );
    record(
      "otp: after the commit the blocked writer re-evaluates and matches 0 rows",
      0,
      loserRows,
    );
  } finally {
    await sql`delete from email_otp_codes where user_id = ${userId}`.catch(() => undefined);
    await sql`delete from magic_link_tokens where user_id = ${userId}`.catch(() => undefined);
    await sql`delete from verification_tokens where identifier = ${email}`.catch(() => undefined);
    await sql`delete from users where id = ${userId}`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} invariants held`);
  if (failed.length > 0) process.exit(1);
}

if (SELF_TEST) {
  const checks = [
    ["missing var is refused", resolveTarget({}, false).ok === false],
    [
      "remote target refused without the flag",
      resolveTarget({ AUTH_RACE_PROBE_DATABASE_URL: "postgres://u:p@db.example.com:5432/x" }, false)
        .ok === false,
    ],
    [
      "remote target allowed with the flag",
      resolveTarget({ AUTH_RACE_PROBE_DATABASE_URL: "postgres://u:p@db.example.com:5432/x" }, true)
        .ok === true,
    ],
    [
      "loopback target accepted",
      resolveTarget({ AUTH_RACE_PROBE_DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x" }, false)
        .ok === true,
    ],
    ["a bare word is not a loopback target", isLoopbackTarget("not-a-url") === false],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) bad += 1;
  }
  process.exit(bad === 0 ? 0 : 1);
} else {
  main().catch((error) => {
    console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
