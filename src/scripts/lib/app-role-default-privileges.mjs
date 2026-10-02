/**
 * Give the app role, on a disposable database, the default privileges every real database has.
 *
 * `db:bootstrap-role` runs `ALTER DEFAULT PRIVILEGES ... TO streamline_app`, so on production,
 * on every cell and on CI's bootstrapped database, each table a migration creates is readable
 * by the app role. Default privileges are per database, though. The probe databases
 * `migration:proof` creates and the blank database `replay:chain-cold` replays into never got
 * them, so a migration that asserts the app can read what it built failed there and nowhere
 * else:
 *   1174 postcondition failed: kb_page_tags is not readable by streamline_app; ...
 *
 * Without IN SCHEMA, so it also covers schemas the chain creates later (build, build_events,
 * app). Skipped when the role does not exist: a cluster with no app role has nothing to grant.
 */
export async function grantAppRoleDefaultPrivileges(sql, role = process.env.APP_DB_ROLE || "streamline_app") {
  const [exists] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
  if (!exists) return false;
  const ident = `"${role.replaceAll('"', '""')}"`;
  await sql.unsafe(`ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident}`);
  await sql.unsafe(`ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO ${ident}`);
  await sql.unsafe(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${ident}`);
  return true;
}
