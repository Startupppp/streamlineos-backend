/**
 * reset-scratch-db.mjs
 *
 * Drop every application schema from a scratch bootstrap database and recreate
 * public plus the five required extensions, so the next cold bootstrap starts from
 * an empty catalog.
 *
 * The target must be a scratch database: its name has to contain "scratch". This is
 * an allowlist on purpose. The previous denylist named two databases ("neondb",
 * "cell2") and let every other name through, so a mistyped or copy-pasted URL —
 * a cell, a staging database, a colleague's branch — would have been dropped
 * without a word. The same rule guards seed-scratch-e2e.mjs.
 *
 * Usage:
 *   SCRATCH_URL=postgresql://… node src/scripts/reset-scratch-db.mjs
 *   node src/scripts/reset-scratch-db.mjs --self-test
 *
 * Drops: build_events, build, app, drizzle, public
 * Recreates: public + vector, pg_trgm, btree_gist, pgcrypto, uuid-ossp
 *
 * Exit codes:
 *   0  Reset complete, or self-test passed
 *   2  SCRATCH_URL absent, unparseable, or not naming a scratch database
 */
import postgres from "postgres";
import process from "node:process";

export function assertScratchTarget(scratchUrl) {
  let parsed;
  try {
    parsed = new URL(scratchUrl);
  } catch {
    return { ok: false, reason: "SCRATCH_URL is not a parseable URL" };
  }
  const database = parsed.pathname.replace(/^\//, "").split("?")[0];
  if (!/scratch/i.test(database))
    return {
      ok: false,
      reason:
        `refusing to reset database "${database}" — SCRATCH_URL must name a scratch ` +
        `database (its name must contain "scratch"). This script drops every schema in it.`,
    };
  return { ok: true, database, label: `${parsed.hostname}:${parsed.port || "5432"}/${database}` };
}

if (process.argv.includes("--self-test")) {
  const cases = [
    ["refuses the shared database name", assertScratchTarget("postgres://u:p@h/neondb").ok, false],
    ["refuses a cell database", assertScratchTarget("postgres://u:p@h/cell2").ok, false],
    ["refuses an unlisted third-party name", assertScratchTarget("postgres://u:p@h/staging_api").ok, false],
    ["refuses an empty database name", assertScratchTarget("postgres://u:p@h/").ok, false],
    ["refuses an unparseable url", assertScratchTarget("not a url").ok, false],
    ["accepts scratch_boot_b", assertScratchTarget("postgres://u:p@h/scratch_boot_b").ok, true],
    ["accepts a query-string suffix", assertScratchTarget("postgres://u:p@h/scratch_e2e?sslmode=require").ok, true],
    [
      "the label carries no credentials",
      (() => {
        const r = assertScratchTarget("postgres://someuser:hunter2@db.example.com:5433/scratch_x");
        return r.ok && r.label === "db.example.com:5433/scratch_x";
      })(),
      true,
    ],
  ];
  let failed = 0;
  for (const [label, actual, wanted] of cases) {
    if (actual === wanted) console.log(`  PASS  ${label}`);
    else {
      console.error(`  FAIL  ${label}: expected ${wanted}, got ${actual}`);
      failed++;
    }
  }
  console.log(`\nSELF-TEST ${failed === 0 ? "PASSED" : "FAILED"}: ${cases.length - failed}/${cases.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

const url = process.env.SCRATCH_URL;
if (!url) {
  process.stderr.write("SCRATCH_URL is required\n");
  process.exit(2);
}

const target = assertScratchTarget(url);
if (!target.ok) {
  process.stderr.write(`reset-scratch-db: ${target.reason}\n`);
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 60 });
try {
  process.stdout.write(`Resetting ${target.label}\n`);

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
