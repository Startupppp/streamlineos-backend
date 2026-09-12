/**
 * Applies `0278_drop_legacy_identity_tables` for real, deliberately.
 *
 * `apply-journalled-migration.mjs` cannot do this on its own: `0278` reads
 * `current_setting('app.allow_legacy_identity_drop', true)` and skips unless
 * it is `'on'`, and that has to be set in the SAME session/transaction as the
 * migration's own statements. Editing the flag into `0278.sql` itself would
 * "work" but changes the file's content hash — which `apply-journalled-
 * migration.mjs` and every cold build key on — so a hardcoded `SET ... = 'on'`
 * makes the drop unconditional for every OTHER database that ever runs this
 * migration fresh (a new dev branch, CI, a future staging environment), none
 * of which have had their own data checked against the two guards below.
 * `0278.sql` stays byte-for-byte what it already is; this script sets the GUC
 * only for its own session, then runs the file's real, unmodified statements.
 *
 * Two independent checks before anything destructive runs, both read-only,
 * both against the target this script is about to write to — not asserted,
 * MEASURED, because the two guards inside `0278` itself only report a COUNT on
 * failure, not which rows:
 *   1. Every legacy row must have a party (the same query `0278`'s own first
 *      guard runs) — reported here with actual ids so a failure is actionable
 *      instead of a bare number.
 *   2. `leads.dm_lead_id` must be empty everywhere — same reason.
 * Both are READ ONLY and run whether or not `--apply` is passed, so this
 * script is also the safe way to ask "would this succeed" without touching
 * anything.
 *
 * Usage:
 *   node src/scripts/apply-0278-legacy-identity-drop.mjs                 # check only
 *   node src/scripts/apply-0278-legacy-identity-drop.mjs --apply         # check, then run for real
 *
 * Same target/safety conventions as apply-journalled-migration.mjs:
 * APPLY_ONE_DATABASE_URL (preferred) / DIRECT_DATABASE_URL / DATABASE_URL,
 * and a non-loopback host is refused unless APPLY_ONE_ALLOW_REMOTE=1.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const TAG = "0278_drop_legacy_identity_tables";
const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const REMOTE_OPT_IN = "APPLY_ONE_ALLOW_REMOTE";

/*
 * Inlined rather than imported from apply-journalled-migration.mjs: that file
 * calls its own main() unconditionally at module scope (no
 * `import.meta.url === process.argv[1]` guard), so importing it for these
 * five pure helpers would also run ITS migrate-one flow against whatever
 * --tag happens to be on argv. Small enough to duplicate safely; keep both
 * copies in sync if the target-resolution rules ever change.
 */
function ownerUrl(env = process.env) {
  const own = env.APPLY_ONE_DATABASE_URL;
  if (own) return own;
  const direct = env.DIRECT_DATABASE_URL;
  if (direct) return direct;
  const url = env.DATABASE_URL;
  if (!url) throw new Error("no target: set APPLY_ONE_DATABASE_URL (preferred), DIRECT_DATABASE_URL or DATABASE_URL");
  return url.replace("-pooler.", ".");
}

function safeLabel(url) {
  try {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "").split("?")[0] || "?";
    return `${u.hostname || "?"}:${u.port || "5432"}/${database}`;
  } catch {
    return "<unparseable url>";
  }
}

function isLoopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function sslOption(url) {
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

function refusalFor(url, env = process.env) {
  if (isLoopback(url)) return null;
  if (env[REMOTE_OPT_IN] === "1") return null;
  return (
    `refusing to touch "${safeLabel(url)}" — it is not a loopback host. ` +
    `This drops tables. Point APPLY_ONE_DATABASE_URL at a local database, ` +
    `or set ${REMOTE_OPT_IN}=1 if you really mean the remote one.`
  );
}

async function main() {
  const url = ownerUrl();
  const refusal = refusalFor(url);
  if (refusal) {
    console.error(`REFUSED: ${refusal}`);
    process.exitCode = 2;
    return;
  }
  console.log(`target ${safeLabel(url)}${isLoopback(url) ? "" : " (REMOTE)"}`);

  const sql = postgres(url, { prepare: false, max: 1, ssl: sslOption(url), onnotice: (n) => console.log(`  NOTICE: ${n.message}`) });

  console.log("\n-- guard 1: legacy rows with no party map row --");
  const stranded = await sql`
    SELECT 'leads' AS table, l.id::text AS id FROM leads l
      WHERE NOT EXISTS (SELECT 1 FROM lead_party_map m WHERE m.lead_id = l.id)
    UNION ALL
    SELECT 'clients', c.id::text FROM clients c
      WHERE NOT EXISTS (SELECT 1 FROM client_party_map m WHERE m.client_id = c.id)
    UNION ALL
    SELECT 'contacts', k.id::text FROM contacts k
      WHERE NOT EXISTS (SELECT 1 FROM contact_party_map m WHERE m.contact_id = k.id)
    UNION ALL
    SELECT 'crm_organizations', o.id::text FROM crm_organizations o
      WHERE NOT EXISTS (SELECT 1 FROM crm_org_party_map m WHERE m.crm_organization_id = o.id)
    LIMIT 50
  `;
  console.log(stranded.length === 0 ? "  none" : `  ${stranded.length} row(s) (showing up to 50):`);
  for (const row of stranded) console.log(`    ${row.table}#${row.id}`);

  console.log("\n-- guard 2: leads.dm_lead_id populated --");
  const [{ dm_values: dmValues }] = await sql`SELECT count(dm_lead_id) AS dm_values FROM leads`;
  console.log(`  ${dmValues} row(s) with a value`);

  const willFail = stranded.length > 0 || Number(dmValues) > 0;
  console.log(`\n${willFail ? "0278 WOULD REFUSE to run" : "0278's own guards would pass"} against this target.`);

  if (!process.argv.includes("--apply")) {
    console.log("\n(check only — pass --apply to run the migration for real)");
    await sql.end();
    process.exitCode = willFail ? 1 : 0;
    return;
  }

  if (willFail) {
    console.error("\nREFUSING to apply: the guard check above would fail inside the migration too.");
    await sql.end();
    process.exitCode = 1;
    return;
  }

  const sqlText = readFileSync(join(MIGRATIONS_DIR, `${TAG}.sql`), "utf8");
  const hash = createHash("sha256").update(sqlText).digest("hex");
  const [already] = await sql`SELECT 1 AS present FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1`;
  if (already) {
    console.log(`\nALREADY APPLIED ${TAG} (hash already recorded) — nothing to do.`);
    await sql.end();
    return;
  }

  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"));
  const entry = journal.entries.find((e) => e.tag === TAG);
  if (!entry) throw new Error(`tag not in journal: ${TAG}`);

  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`\napplying ${TAG} for real: ${statements.length} statement(s), app.allow_legacy_identity_drop=on for this session only`);
  try {
    await sql.begin(async (tx) => {
      // Session-local to this transaction only — 0278.sql itself is never edited.
      await tx.unsafe(`SET LOCAL app.allow_legacy_identity_drop = 'on'`);
      for (const [i, statement] of statements.entries()) {
        await tx.unsafe(statement);
        console.log(`  OK [${i + 1}/${statements.length}] ${statement.split("\n")[0].slice(0, 90)}`);
      }
      await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.when})`;
    });
  } catch (error) {
    console.error(`\nROLLED BACK ${TAG} — nothing was applied and no migration row was recorded`);
    console.error(`  cause: ${error.code ?? "?"} ${error.message ?? String(error)}`);
    await sql.end();
    process.exitCode = 1;
    return;
  }

  console.log(`\nAPPLIED ${TAG}. leads/clients/contacts/crm_organizations are dropped; the *_party_map tables and every FK column that pointed at them remain.`);
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
