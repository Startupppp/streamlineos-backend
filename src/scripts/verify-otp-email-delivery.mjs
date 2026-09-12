#!/usr/bin/env node
/**
 * Closes the last leg of the identity lane that no automated check can reach: a
 * real OTP email, delivered by the configured provider, carrying the code the
 * database is actually holding.
 *
 * Only a human can read the inbox, so this is split. `--send` triggers one real
 * request and reports the row the server stored. `--confirm=<code>` hashes the
 * code that arrived and compares it to that stored hash, which is what proves
 * the delivered mail and the database agree — the code itself is never stored in
 * the clear, so this comparison is the only available proof.
 *
 * A recipient is never defaulted. Mailing a guessed address is an outbound
 * action against a stranger, so --to is required and must be given explicitly.
 */
import postgres from "postgres";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");

export function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    to: get("to"),
    confirm: get("confirm"),
    apiUrl: get("api-url") ?? "http://127.0.0.1:1500",
    send: argv.includes("--send"),
    cleanup: argv.includes("--cleanup"),
  };
}

export function looksLikeEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validate(parsed, env) {
  if (!parsed.to)
    return { ok: false, reason: "--to=<address> is required; a recipient is never defaulted." };
  if (!looksLikeEmail(parsed.to))
    return { ok: false, reason: `--to is not an email address: ${parsed.to}` };
  if (!parsed.send && !parsed.confirm && !parsed.cleanup)
    return { ok: false, reason: "Pass --send, --confirm=<code>, or --cleanup." };
  const db = env.OTP_DELIVERY_PROBE_DATABASE_URL;
  if (!db)
    return {
      ok: false,
      reason:
        "OTP_DELIVERY_PROBE_DATABASE_URL is required. This reads the OTP table; it deliberately does not fall back to DATABASE_URL.",
    };
  return { ok: true, db };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const parsed = parseArgs(args);
  const checked = validate(parsed, process.env);
  if (!checked.ok) {
    console.error(`REFUSED: ${checked.reason}`);
    process.exit(1);
  }

  const email = parsed.to.toLowerCase().trim();
  const sql = postgres(checked.db, { prepare: false, max: 2 });

  try {
    if (parsed.send) {
      console.log(`POST ${parsed.apiUrl}/auth/email-otp  to=${email}`);
      const res = await fetch(`${parsed.apiUrl}/auth/email-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.text();
      console.log(`  status ${res.status}  ${body.slice(0, 160)}`);
      if (!res.ok) {
        console.error("The request did not succeed, so no mail was accepted by the provider.");
        process.exit(1);
      }
    }

    const rows = await sql`
      select c.id, c.code_hash, c.attempts, c.used_at, c.expires_at, c.created_at
      from email_otp_codes c
      join users u on u.id = c.user_id
      where lower(u.email) = ${email}
      order by c.created_at desc
      limit 3`;

    if (rows.length === 0) {
      console.error(`No email_otp_codes row exists for ${email} in this database.`);
      process.exit(1);
    }

    const live = rows[0];
    console.log("\nmost recent stored code:");
    console.log(`  id         ${live.id}`);
    console.log(`  created_at ${live.created_at.toISOString()}`);
    console.log(`  expires_at ${live.expires_at.toISOString()}`);
    console.log(`  attempts   ${live.attempts}`);
    console.log(`  used_at    ${live.used_at === null ? "null (unconsumed)" : live.used_at.toISOString()}`);
    console.log(`  code_hash  ${live.code_hash.slice(0, 16)}…`);
    console.log(`  rows for this address: ${rows.length}`);

    if (parsed.confirm) {
      const candidate = parsed.confirm.trim();
      const matchesLive = sha256(candidate) === live.code_hash;
      const matchesAny = rows.find((r) => sha256(candidate) === r.code_hash);
      console.log("");
      if (matchesLive) {
        console.log(`PASS  the delivered code matches the newest stored hash — real provider delivery confirmed`);
      } else if (matchesAny) {
        console.log(
          `PARTIAL  the delivered code matches an OLDER row (${matchesAny.id}); a newer code has superseded it`,
        );
      } else {
        console.log(`FAIL  sha256(delivered code) matches no stored row for ${email}`);
      }
      if (!matchesLive && !matchesAny) process.exit(1);
    }

    if (parsed.cleanup) {
      const deleted = await sql`
        delete from email_otp_codes
        where user_id in (select id from users where lower(email) = ${email})`;
      console.log(`\ncleanup: removed ${deleted.count} otp row(s) for ${email}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (SELF_TEST) {
  const checks = [
    ["a missing --to is refused", validate(parseArgs(["--send"]), {}).ok === false],
    [
      "a non-email --to is refused",
      validate(parseArgs(["--send", "--to=not-an-address"]), {}).ok === false,
    ],
    [
      "a missing database var is refused even with a valid --to",
      validate(parseArgs(["--send", "--to=a@b.com"]), {}).ok === false,
    ],
    [
      "no action flag is refused",
      validate(parseArgs(["--to=a@b.com"]), { OTP_DELIVERY_PROBE_DATABASE_URL: "x" }).ok === false,
    ],
    [
      "a complete --send invocation is accepted",
      validate(parseArgs(["--send", "--to=a@b.com"]), {
        OTP_DELIVERY_PROBE_DATABASE_URL: "x",
      }).ok === true,
    ],
    [
      "--confirm parses its value",
      parseArgs(["--to=a@b.com", "--confirm=123456"]).confirm === "123456",
    ],
    ["the api url defaults to the local backend", parseArgs([]).apiUrl === "http://127.0.0.1:1500"],
    ["an address with no tld is rejected", looksLikeEmail("a@b") === false],
    ["a plus-addressed recipient is accepted", looksLikeEmail("a+tag@b.co") === true],
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
