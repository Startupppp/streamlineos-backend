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
const schema = process.env.APP_DB_SCHEMA || "public";

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
  console.log(`Schema        : ${schema}\n`);

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

  await repair(
    "revoke object creation in schema",
    `REVOKE CREATE ON SCHEMA ${ident(schema)} FROM ${ident(role)}`,
  );
  // A direct revoke is not enough: CREATE usually arrives via the PUBLIC pseudo-role,
  // and a table the app role owns would be exempt from its own RLS policies
  await repair(
    "revoke object creation from PUBLIC",
    `REVOKE CREATE ON SCHEMA ${ident(schema)} FROM PUBLIC`,
  );
  await repair("grant schema usage", `GRANT USAGE ON SCHEMA ${ident(schema)} TO ${ident(role)}`);
  await repair(
    "grant DML on existing tables",
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ident(schema)} TO ${ident(role)}`,
  );
  await repair(
    "grant sequence usage",
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${ident(schema)} TO ${ident(role)}`,
  );

  // Without these, every table a future migration adds is invisible to the app
  await repair(
    "default privileges for future tables",
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA ${ident(schema)}
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(role)}`,
  );
  await repair(
    "default privileges for future sequences",
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA ${ident(schema)}
     GRANT USAGE, SELECT ON SEQUENCES TO ${ident(role)}`,
  );

  const [final] = await sql`
    SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin
    FROM pg_roles WHERE rolname = ${role}`;
  const [counts] = await sql`
    SELECT
      (SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema = ${schema} AND table_type = 'BASE TABLE') AS tables,
      (SELECT count(DISTINCT table_name)::int FROM information_schema.role_table_grants
        WHERE table_schema = ${schema} AND grantee = ${role}) AS granted`;

  console.log("\n--- verification ---");
  if (!final) {
    console.error(`role ${role} does not exist`);
  } else {
    console.log(
      `superuser=${final.rolsuper} createdb=${final.rolcreatedb} createrole=${final.rolcreaterole} ` +
        `bypassrls=${final.rolbypassrls} login=${final.rolcanlogin}`,
    );
  }
  console.log(`tables granted: ${counts.granted}/${counts.tables}`);

  const [canCreate] = await sql`SELECT has_schema_privilege(${role}, ${schema}, 'CREATE') AS yes`;
  console.log(`can create objects: ${canCreate.yes} (must be false)`);

  const blockers = [];
  if (canCreate.yes) blockers.push(`${role} can still create objects in ${schema}`);
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
