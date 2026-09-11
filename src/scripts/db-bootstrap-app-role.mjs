import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const adminUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!adminUrl) {
  console.error("DATABASE_URL (or DIRECT_DATABASE_URL) is required — it must be the owner/admin role.");
  process.exit(1);
}

const role = process.env.APP_DB_ROLE || "streamline_app";
const password = process.env.APP_DB_PASSWORD || "";
const schemas = (process.env.APP_DB_SCHEMA || "public,build,build_events,app")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Providers ship shared roles whose privileges must never be rewritten by this script
const RESERVED = new Set([
  "postgres", "authenticated", "anon", "service_role", "supabase_admin",
  "supabase_auth_admin", "supabase_storage_admin", "neondb_owner",
  "neon_superuser", "cloud_admin", "neon_service", "rds_superuser", "azure_pg_admin",
]);

if (RESERVED.has(role) && process.env.APP_DB_ROLE_FORCE !== "1") {
  console.error(
    `Refusing to modify the provider-managed role "${role}". ` +
      `Set APP_DB_ROLE to a dedicated role (e.g. streamline_app), or APP_DB_ROLE_FORCE=1 if you really mean it.`,
  );
  process.exit(1);
}

// Tables a migration deliberately made append-only for the app role. Each entry is
// re-revoked after the blanket DML grant above, and asserted in the verification block,
// so this script can never report READY over a mutable audit log.
const IMMUTABLE_TABLES = [
  { schema: "public", table: "audit_logs", revoke: "UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER" },
];

const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
const ident = (v) => `"${v.replace(/"/g, '""')}"`;
const literal = (v) => `'${v.replace(/'/g, "''")}'`;
const manual = [];

function isPermissionDenied(err) {
  return /permission denied|must have admin option|must be superuser/i.test(
    err instanceof Error ? err.message : String(err),
  );
}

/** Runs a repair, but downgrades a privilege error to an operator instruction instead of failing. */
async function repair(label, statement, instruction) {
  try {
    await sql.unsafe(statement);
    console.log(`OK    ${label}`);
    return true;
  } catch (err) {
    if (isPermissionDenied(err)) {
      console.log(`ADMIN ${label} — needs a higher-privileged role`);
      manual.push(instruction ?? statement);
      return false;
    }
    console.error(`FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

try {
  const [{ current_user: owner }] = await sql`SELECT current_user`;
  console.log(`Granting role : ${role}`);
  console.log(`Object owner  : ${owner}`);
  console.log(`Schemas       : ${schemas.join(", ")}\n`);

  let [attrs] = await sql`
    SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin
    FROM pg_roles WHERE rolname = ${role}`;

  if (!attrs) {
    await repair(
      `create role ${role}`,
      `CREATE ROLE ${ident(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION`,
      `CREATE ROLE ${ident(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;`,
    );
    [attrs] = await sql`
      SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin
      FROM pg_roles WHERE rolname = ${role}`;
  } else {
    console.log(`OK    role ${role} already exists`);
  }

  if (attrs) {
    // Only touch attributes that are actually wrong; a provider-created role often cannot be altered
    const wrong = [];
    if (attrs.rolsuper) wrong.push("NOSUPERUSER");
    if (attrs.rolcreatedb) wrong.push("NOCREATEDB");
    if (attrs.rolcreaterole) wrong.push("NOCREATEROLE");
    if (attrs.rolbypassrls) wrong.push("NOBYPASSRLS");
    if (!attrs.rolcanlogin) wrong.push("LOGIN");

    if (wrong.length === 0) {
      console.log("OK    role attributes already safe (no superuser / createdb / createrole / bypassrls)");
    } else {
      await repair(
        `fix role attributes: ${wrong.join(" ")}`,
        `ALTER ROLE ${ident(role)} ${wrong.join(" ")}`,
        `ALTER ROLE ${ident(role)} ${wrong.join(" ")};`,
      );
    }
  }

  if (password) {
    await repair(
      "set password",
      `ALTER ROLE ${ident(role)} WITH PASSWORD ${literal(password)}`,
      `ALTER ROLE ${ident(role)} WITH PASSWORD '<your password>';`,
    );
  } else {
    console.log("SKIP  set password (APP_DB_PASSWORD not set — use the provider console)");
  }

  for (const schema of schemas) {
    const [present] = await sql`SELECT 1 AS ok FROM pg_namespace WHERE nspname = ${schema}`;
    if (!present) {
      console.log(`SKIP  schema ${schema} does not exist yet`);
      continue;
    }
    await repair(
      `revoke object creation in ${schema}`,
      `REVOKE CREATE ON SCHEMA ${ident(schema)} FROM ${ident(role)}`,
    );
    // A direct revoke is not enough: CREATE usually arrives via the PUBLIC pseudo-role,
    // and a table the app role owns would be exempt from its own RLS policies
    await repair(
      `revoke object creation from PUBLIC in ${schema}`,
      `REVOKE CREATE ON SCHEMA ${ident(schema)} FROM PUBLIC`,
    );
    await repair(
      `grant usage on ${schema}`,
      `GRANT USAGE ON SCHEMA ${ident(schema)} TO ${ident(role)}`,
    );
    await repair(
      `grant DML on existing tables in ${schema}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ident(schema)} TO ${ident(role)}`,
    );
    await repair(
      `grant sequence usage in ${schema}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${ident(schema)} TO ${ident(role)}`,
    );

    // Without these, every table a future migration adds is invisible to the app
    await repair(
      `default privileges for future tables in ${schema}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA ${ident(schema)}
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(role)}`,
    );
    await repair(
      `default privileges for future sequences in ${schema}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA ${ident(schema)}
       GRANT USAGE, SELECT ON SEQUENCES TO ${ident(role)}`,
    );

    /*
     * EXECUTE, which this script never granted.
     *
     * Function grants live in migrations, and many hardcode the role name --
     * `GRANT EXECUTE ON FUNCTION app.search_chat_message_ids(...) TO streamline_app`
     * -- so any role NOT literally called `streamline_app` was silently broken
     * on every function-backed search path, while the verification below (which
     * counted tables only) printed READY over it. The symptom is a product bug
     * in whichever feature you happened to run: `Failed query: SELECT
     * app.search_kb_page_ids($1, $2)`.
     *
     * Granting on ALL FUNCTIONS is what makes this role-name independent.
     */
    await repair(
      `grant function execute in ${schema}`,
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${ident(schema)} TO ${ident(role)}`,
    );
    await repair(
      `default privileges for future functions in ${schema}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA ${ident(schema)}
       GRANT EXECUTE ON FUNCTIONS TO ${ident(role)}`,
    );
  }

  // A blanket `GRANT ... ON ALL TABLES` re-opens every privilege a migration
  // deliberately revoked, and it does it silently. `audit_logs` is append-only:
  // migrations 0840 and 0928 revoke UPDATE/DELETE (and TRUNCATE/REFERENCES/TRIGGER)
  // from the app role, and running this script afterwards handed them all back.
  // The append-only trigger still refused the mutation, so nothing failed loudly —
  // only `check:audit-log-privileges` saw it, and only against a live database.
  // The privilege, not the trigger, is the boundary the gate measures.
  for (const t of IMMUTABLE_TABLES) {
    const [present] = await sql`
      SELECT 1 AS ok FROM information_schema.tables
      WHERE table_schema = ${t.schema} AND table_name = ${t.table} AND table_type = 'BASE TABLE'`;
    if (!present) {
      console.log(`SKIP  re-revoke on ${t.schema}.${t.table} — table does not exist yet`);
      continue;
    }
    await repair(
      `re-revoke ${t.revoke} on ${t.schema}.${t.table} (append-only)`,
      `REVOKE ${t.revoke} ON TABLE ${ident(t.schema)}.${ident(t.table)} FROM ${ident(role)}`,
    );
  }

  const [final] = await sql`
    SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin
    FROM pg_roles WHERE rolname = ${role}`;
  /*
   * Functions are counted here because this verification used to report tables
   * ONLY, and so printed READY over a role that could execute 4 of 30 app.*
   * functions. has_function_privilege is the honest question: it resolves
   * grants made directly, through PUBLIC, and through role membership, which a
   * scan of information_schema.role_routine_grants does not.
   *
   * TRIGGER FUNCTIONS ARE EXCLUDED, and getting this wrong is how a fix becomes
   * a false alarm. Postgres fires a trigger with the trigger function's own
   * rights, so the app role needs no EXECUTE on one -- and SHOULD NOT have it,
   * since these are the append-only guards (app.prevent_audit_log_mutation,
   * app.prevent_kb_page_version_mutation and three siblings) that exist to
   * refuse the app. Counting them made even the canonical `streamline_app`
   * read as 478/483 and would have blocked a correct bootstrap on five
   * functions nothing is supposed to call.
   */
  const [counts] = await sql`
    SELECT
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema = ANY(${schemas}) AND table_type = 'BASE TABLE') AS tables,
      (SELECT count(DISTINCT table_schema || '.' || table_name)::int
        FROM information_schema.role_table_grants
        WHERE table_schema = ANY(${schemas}) AND grantee = ${role}) AS granted,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY(${schemas})
          AND p.prorettype <> 'trigger'::regtype) AS functions,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY(${schemas})
          AND p.prorettype <> 'trigger'::regtype
          AND has_function_privilege(${role}, p.oid, 'EXECUTE')) AS executable`;

  console.log("\n--- verification ---");
  if (!final) {
    console.error(`role ${role} does not exist`);
  } else {
    console.log(
      `superuser=${final.rolsuper} createdb=${final.rolcreatedb} createrole=${final.rolcreaterole} ` +
        `bypassrls=${final.rolbypassrls} login=${final.rolcanlogin}`,
    );
  }
  console.log(`tables granted:    ${counts.granted}/${counts.tables}`);
  console.log(`functions executable: ${counts.executable}/${counts.functions}`);

  const creatable = await sql`
    SELECT nspname FROM pg_namespace
    WHERE nspname = ANY(${schemas}) AND has_schema_privilege(${role}, nspname, 'CREATE')`;
  console.log(
    `can create objects in: ${creatable.length === 0 ? "(none)" : creatable.map((r) => r.nspname).join(", ")} (must be none)`,
  );

  const immutable = [];
  for (const t of IMMUTABLE_TABLES) {
    const [row] = await sql`
      SELECT
        has_table_privilege(${role}, ${`${t.schema}.${t.table}`}, 'UPDATE') AS can_update,
        has_table_privilege(${role}, ${`${t.schema}.${t.table}`}, 'DELETE') AS can_delete
      WHERE EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${t.schema} AND table_name = ${t.table})`;
    if (!row) continue;
    immutable.push({ name: `${t.schema}.${t.table}`, canUpdate: row.can_update, canDelete: row.can_delete });
  }
  for (const t of immutable)
    console.log(`append-only ${t.name}: update=${t.canUpdate ? "GRANTED" : "revoked"} delete=${t.canDelete ? "GRANTED" : "revoked"}`);

  const blockers = [];
  for (const { nspname } of creatable)
    blockers.push(`${role} can still create objects in ${nspname}`);
  if (!final) blockers.push(`role ${role} does not exist`);
  else {
    if (final.rolsuper || final.rolcreatedb || final.rolcreaterole || final.rolbypassrls) {
      blockers.push("role still holds an attribute that would defeat RLS");
    }
    if (!final.rolcanlogin) blockers.push("role cannot log in");
  }
  if (counts.granted < counts.tables) {
    blockers.push(`${counts.tables - counts.granted} table(s) have no grant for ${role}`);
  }
  for (const t of immutable) {
    if (t.canUpdate || t.canDelete)
      blockers.push(`${role} can still ${[t.canUpdate && "UPDATE", t.canDelete && "DELETE"].filter(Boolean).join("/")} ${t.name}, which must be append-only`);
  }

  if (manual.length > 0) {
    console.log(
      `\nRun these as a higher-privileged role (provider console / superuser) — ${owner} is not allowed to:\n`,
    );
    for (const stmt of manual) console.log(`  ${stmt.replace(/\s+/g, " ").trim()}`);
  }

  if (blockers.length > 0) {
    console.error(`\nRESULT: INCOMPLETE\n${blockers.map((b) => `  - ${b}`).join("\n")}`);
    process.exit(1);
  }

  console.log(`\nRESULT: READY — point APP_DATABASE_URL at ${role} to run the app under RLS.`);
} catch {
  console.log("\nRESULT: FAILED");
  process.exit(1);
} finally {
  await sql.end();
}
