/**
 * Applies one journalled migration by tag and reports the real error.
 *
 * `drizzle-kit migrate` prints NOTICEs, hides the failing statement behind its
 * spinner and exits 1, so a failure in any pending migration blocks every other
 * pending migration with no way to see which statement died. This applies a
 * single named entry, statement by statement, and names the statement that fails.
 *
 * WHERE IT WRITES — this used to be unanswerable, and the answer was production.
 * The package script runs it with `--env-file=.env`, whose `DATABASE_URL` is the
 * shared remote branch, and the target was resolved silently from that with no
 * label printed. `ssl: "require"` was hardcoded on top, so the one target you
 * could reach safely — a local Postgres, which speaks no TLS — was the one target
 * it refused. The documented way to apply a single migration therefore failed
 * locally and succeeded against shared data. Both halves are fixed here:
 *
 *   1. The target is APPLY_ONE_DATABASE_URL first, so it can be aimed without
 *      touching `.env` and without repointing the whole API.
 *   2. TLS follows the URL instead of being asserted, so `sslmode=disable` works.
 *   3. A non-loopback host is REFUSED (exit 2) unless APPLY_ONE_ALLOW_REMOTE=1.
 *      This writes DDL and a ledger row; it must not do that to a shared database
 *      because someone forgot which shell they were in.
 *   4. The resolved target is printed as host:port/database — never the URL.
 *
 *   node src/scripts/apply-journalled-migration.mjs --tag=0636_... [--dry-run]
 *   node src/scripts/apply-journalled-migration.mjs --self-test
 *
 * Exit codes:
 *   0  applied, or already applied · 1  the migration failed and rolled back
 *   2  refused target / bad arguments (INCONCLUSIVE — nothing was attempted)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sslForConnectionString } from "./lib/repo-roots.mjs";
import postgres from "postgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const REMOTE_OPT_IN = "APPLY_ONE_ALLOW_REMOTE";

/** Errors that mean "the object this statement creates is already there". */
const ALREADY_EXISTS = new Set(["42P07", "42710", "42701", "42P16"]);

function flag(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? true : fallback;
}

/**
 * Precedence is deliberate: a variable that means only this script comes first, so
 * aiming it never requires editing `.env` — editing `.env` repoints the whole API
 * and every seeded e2e spec that boots it.
 */
export function ownerUrl(env = process.env) {
  const own = env.APPLY_ONE_DATABASE_URL;
  if (own) return own;
  const direct = env.DIRECT_DATABASE_URL;
  if (direct) return direct;
  const url = env.DATABASE_URL;
  if (!url) throw new Error("no target: set APPLY_ONE_DATABASE_URL (preferred), DIRECT_DATABASE_URL or DATABASE_URL");
  return url.replace("-pooler.", ".");
}

/** The URL carries a password in every deployed shape, so identity is a label, never the string. */
export function safeLabel(url) {
  try {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "").split("?")[0] || "?";
    return `${u.hostname || "?"}:${u.port || "5432"}/${database}`;
  } catch {
    return "<unparseable url>";
  }
}

export function isLoopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * TLS follows the URL. A hardcoded "require" makes a local Postgres unreachable,
 * which is exactly how the only safe target became the only unusable one. Remote
 * targets keep requiring TLS, so nothing about the previous behaviour is relaxed.
 */
export function sslOption(url) {
  try {
    const params = new URL(url).searchParams;
    const mode = params.get("sslmode") ?? params.get("ssl");
    if (mode === "disable" || mode === "false" || mode === "0") return false;
    if (mode) return "require";
  } catch {
    return "require";
  }
  return isLoopback(url) ? false : "require";
}

/** Returns null when the target is allowed, or the refusal message when it is not. */
export function refusalFor(url, env = process.env) {
  if (isLoopback(url)) return null;
  if (env[REMOTE_OPT_IN] === "1") return null;
  return (
    `refusing to apply a migration to "${safeLabel(url)}" — it is not a loopback host. ` +
    `This writes DDL and a ledger row. Point APPLY_ONE_DATABASE_URL at a local database, ` +
    `or set ${REMOTE_OPT_IN}=1 if you really mean the remote one.`
  );
}

async function main() {
  const tag = flag("tag");
  if (typeof tag !== "string") {
    console.error("--tag=<journal tag> is required");
    process.exitCode = 2;
    return;
  }

  const url = ownerUrl();
  const refusal = refusalFor(url);
  if (refusal) {
    console.error(`REFUSED: ${refusal}`);
    process.exitCode = 2;
    return;
  }
  console.log(`target ${safeLabel(url)}`);

  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  );
  const entry = journal.entries.find((e) => e.tag === tag);
  if (!entry) throw new Error(`tag not in journal: ${tag}`);

  const sqlText = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  const hash = createHash("sha256").update(sqlText).digest("hex");
  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const sql = postgres(url, { prepare: false, max: 1, ssl: sslOption(url), onnotice: () => {} });

  const [already] = await sql`
    SELECT 1 AS present FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1
  `;
  if (already) {
    console.log(`ALREADY APPLIED ${tag}`);
    await sql.end();
    return;
  }

  const skipExisting = flag("skip-existing") === true;
  const skipped = [];
  console.log(
    `applying ${tag}: ${statements.length} statement(s)` +
      (skipExisting ? " (--skip-existing: reconciling schema-ahead-of-bookkeeping)" : ""),
  );
  if (flag("dry-run")) {
    statements.forEach((s, i) => console.log(`  [${i + 1}] ${s.split("\n")[0]}`));
    await sql.end();
    return;
  }

  try {
    await sql.begin(async (tx) => {
      for (const [i, statement] of statements.entries()) {
        // A failed statement aborts the whole transaction in PostgreSQL, so
        // skipping one means unwinding to a savepoint first: without this,
        // statement 2 onwards dies with 25P02 and the skip is worthless.
        // It has to be the driver's own savepoint() -- postgres.js tracks
        // transaction state itself, and a raw "SAVEPOINT" string leaves that
        // state marked failed, so the commit still rolls back.
        try {
          if (skipExisting) await tx.savepoint(async (sp) => sp.unsafe(statement));
          else await tx.unsafe(statement);
          console.log(
            `  OK   [${i + 1}/${statements.length}] ${statement.split("\n")[0].slice(0, 90)}`,
          );
        } catch (error) {
          if (skipExisting && ALREADY_EXISTS.has(error.code)) {
            skipped.push(`[${i + 1}] ${error.code} ${error.message}`);
            console.log(
              `  SKIP [${i + 1}/${statements.length}] ${error.code} ${error.message} ` +
                `— already present, not re-created`,
            );
            continue;
          }
          console.error(
            `  FAIL [${i + 1}/${statements.length}] ${error.code ?? "?"} ${error.message}`,
          );
          console.error(`  statement: ${statement.slice(0, 400)}`);
          throw error;
        }
      }
      await tx`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
    });
  } catch (error) {
    // Never swallow this. A rollback with no reason is how a broken apply reads
    // as "just didn't work" instead of naming the statement that killed it.
    console.error(
      `ROLLED BACK ${tag} — nothing was applied and no migration row was recorded` +
        `\n  cause: ${error.code ?? "?"} ${error.message ?? String(error)}`,
    );
    await sql.end();
    process.exitCode = 1;
    return;
  }

  if (skipped.length > 0) {
    console.log(
      `RECONCILED ${tag} at created_at=${entry.when} — ${skipped.length} statement(s) skipped ` +
        `as already present:`,
    );
    for (const s of skipped) console.log(`    ${s}`);
  } else {
    console.log(`RECORDED ${tag} at created_at=${entry.when}`);
  }
  await sql.end();
}

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, cond) => (cond ? passed++ : failures.push(label));

  const local = "postgresql://tarunchintakunta@127.0.0.1:5432/scratch_x?sslmode=disable";
  const remote = "postgresql://neondb_owner:hunter2@ep-orange-mode-a1b2.us-east-2.aws.neon.tech/neondb";

  // Target precedence — the point is that aiming this script never needs .env edited.
  assert(
    "APPLY_ONE_DATABASE_URL wins over DIRECT_DATABASE_URL and DATABASE_URL",
    ownerUrl({ APPLY_ONE_DATABASE_URL: local, DIRECT_DATABASE_URL: remote, DATABASE_URL: remote }) === local,
  );
  assert("DIRECT_DATABASE_URL is used when the dedicated variable is unset", ownerUrl({ DIRECT_DATABASE_URL: local }) === local);
  assert("DATABASE_URL is the last resort", ownerUrl({ DATABASE_URL: local }) === local);
  assert("a pooler host is rewritten to its direct form", ownerUrl({ DATABASE_URL: "postgres://u@h-pooler.x.neon.tech/db" }) === "postgres://u@h.x.neon.tech/db");
  assert("no target at all throws rather than guessing", (() => { try { ownerUrl({}); return false; } catch { return true; } })());

  // The defect this script shipped with: a remote target reached in silence.
  assert("a remote target is refused by default", refusalFor(remote, {}) !== null);
  assert("the refusal names the target without its credentials", !String(refusalFor(remote, {})).includes("hunter2"));
  assert("the refusal names host and database", String(refusalFor(remote, {})).includes("ep-orange-mode-a1b2.us-east-2.aws.neon.tech:5432/neondb"));
  assert("a remote target is allowed only on explicit opt-in", refusalFor(remote, { [REMOTE_OPT_IN]: "1" }) === null);
  assert("a truthy-looking opt-in that is not exactly 1 still refuses", refusalFor(remote, { [REMOTE_OPT_IN]: "true" }) !== null);
  assert("a loopback target is allowed with no opt-in", refusalFor(local, {}) === null);
  assert("localhost by name is loopback", isLoopback("postgres://localhost:5432/x"));
  assert("::1 is loopback", isLoopback("postgres://[::1]:5432/x"));
  assert("a remote host is not loopback", !isLoopback(remote));
  assert("an unparseable url is not treated as loopback", !isLoopback("not a url"));

  // The other half: TLS asserted rather than derived made the safe target unusable.
  assert("sslmode=disable turns TLS off", sslOption(local) === false);
  assert("a loopback url with no sslmode still turns TLS off", sslOption("postgres://127.0.0.1:5432/x") === false);
  assert("a remote url still requires TLS", sslOption(remote) === "require");
  assert("an explicit sslmode=require is honoured", sslOption("postgres://127.0.0.1:5432/x?sslmode=require") === "require");

  assert("safeLabel never returns the connection string", !safeLabel(remote).includes("hunter2"));
  assert("safeLabel survives an unparseable url", safeLabel("nonsense") === "<unparseable url>");

  if (failures.length > 0) {
    console.error(`apply-journalled-migration self-tests: ${failures.length} FAILED`);
    for (const f of failures) console.error(`  FAIL  ${f}`);
    process.exit(1);
  }
  console.log(`apply-journalled-migration self-tests: ${passed} passed`);
  process.exit(0);
}

if (flag("self-test")) runSelfTest();

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
});
