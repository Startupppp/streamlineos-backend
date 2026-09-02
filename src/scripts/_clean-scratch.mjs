/**
 * Temporary cleanup script - drops and recreates the public schema on a scratch DB.
 * Usage: node src/scripts/_clean-scratch.mjs <db-name>
 * SAFETY: only accepts scratch_boot_* databases.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const dbName = process.argv[2];
if (!dbName || !dbName.startsWith("scratch_boot_")) {
  process.stderr.write("Only scratch_boot_* databases are accepted.\n");
  process.exit(2);
}

const envPath = resolve(process.cwd(), ".env");
const envContent = readFileSync(envPath, "utf8");
let poolerUrl = null;
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^DATABASE_URL=(.+)$/);
  if (m) { poolerUrl = m[1].trim().replace(/^['"]|['"]$/g, ""); break; }
}
if (!poolerUrl) { process.stderr.write("DATABASE_URL not found in .env\n"); process.exit(1); }

const u = new URL(poolerUrl);
u.pathname = "/" + dbName;
// Use direct URL (no pooler) for DDL
const directUrl = u.toString().replace("-pooler.", ".");

console.log(`Cleaning database: ${dbName}`);

const sql = postgres(directUrl, { max: 1, prepare: false, onnotice: () => {} });
try {
  // Drop all non-system schemas (public, drizzle, and any others)
  const schemas = await sql`
    SELECT nspname FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast','pg_temp_1','pg_toast_temp_1')
      AND nspname NOT LIKE 'pg_%'
    ORDER BY nspname
  `;
  console.log("Schemas to drop:", schemas.map(r => r.nspname).join(", "));

  for (const row of schemas) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`);
    console.log(`  Dropped schema: ${row.nspname}`);
  }

  // Recreate public schema with proper grants
  await sql.unsafe(`CREATE SCHEMA public`);
  await sql.unsafe(`GRANT ALL ON SCHEMA public TO neondb_owner`);
  await sql.unsafe(`GRANT ALL ON SCHEMA public TO PUBLIC`);
  console.log("  Recreated schema: public");

  // Drop all enum types that might be in pg_catalog scope (they're schema-specific so dropped above)
  // Verify clean state
  const tableCount = await sql`SELECT count(*) AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema','pg_toast')`;
  const enumCount = await sql`SELECT count(*) AS n FROM pg_type WHERE typtype = 'e'`;
  console.log(`Post-clean state: tables=${tableCount[0].n} enums=${enumCount[0].n}`);
} finally {
  await sql.end();
}
console.log("Done.");
