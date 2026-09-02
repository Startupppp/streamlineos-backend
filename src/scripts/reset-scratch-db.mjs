/**
 * reset-scratch-db.mjs
 *
 * Drop all schemas from a scratch bootstrap database and recreate public + the five
 * required extensions.  Must point at the scratch database — never neondb or cell2.
 *
 * Usage:
 *   SCRATCH_URL=postgresql://… node src/scripts/reset-scratch-db.mjs
 *
 * The script drops: public, drizzle, build, build_events, app
 * Then recreates: public schema + 5 extensions (vector, pg_trgm, btree_gist, pgcrypto, uuid-ossp)
 */
import postgres from "postgres";
import process from "node:process";

const url = process.env.SCRATCH_URL;
if (!url) {
  process.stderr.write("SCRATCH_URL is required\n");
  process.exit(2);
}
const dbName = new URL(url).pathname.replace(/^\//, "").split("?")[0];
if (dbName === "neondb" || dbName === "cell2") {
  process.stderr.write(`ERROR: SCRATCH_URL points at a protected database (${dbName}). Refusing.\n`);
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 60 });
try {
  process.stdout.write(`Resetting ${url.replace(/:\/\/[^@]+@/, "://***@")}\n`);

  for (const schema of ["build_events", "build", "app", "drizzle", "public"]) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    process.stdout.write(`  Dropped ${schema}\n`);
  }

  await sql.unsafe(`CREATE SCHEMA public`);
  process.stdout.write(`  Recreated public\n`);

  for (const ext of ["vector", "pg_trgm", "btree_gist", "pgcrypto", "uuid-ossp"]) {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
    process.stdout.write(`  Extension: ${ext}\n`);
  }

  const [t] = await sql`SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'`;
  process.stdout.write(`Reset complete. Public tables: ${t.n}\n`);
} finally {
  await sql.end();
}
