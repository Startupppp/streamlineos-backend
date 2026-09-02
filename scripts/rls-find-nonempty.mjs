/**
 * rls-find-nonempty.mjs
 * Lists every RLS-enabled org_id table that is non-empty, sorted by row count.
 * Runs as the database OWNER (BYPASSRLS). Counts are cross-org totals;
 * this script identifies which tables carry live data and therefore represent
 * higher risk if RLS policies fail — it does NOT prove isolation.
 *
 * Run:  node scripts/rls-find-nonempty.mjs
 */

import postgres from 'postgres';

const OWNER_URL = process.env.DATABASE_URL;
if (!OWNER_URL) throw new Error("DATABASE_URL is required");

const sql = postgres(OWNER_URL, { prepare: false, ssl: 'require', max: 1 });

async function main() {
  const tables = await sql`
    SELECT c.relname AS tname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = true
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
      )
    ORDER BY c.relname
  `;

  console.log(`Scanning ${tables.length} RLS tables (owner BYPASSRLS)...`);

  const nonEmpty = [];
  for (const row of tables) {
    const tname = row.tname;
    try {
      const r = await sql.unsafe(`SELECT count(*)::int AS n FROM "${tname}"`);
      const n = r[0].n;
      if (n > 0) {
        nonEmpty.push({ tname, n });
        process.stdout.write(`  ${tname}: ${n}\n`);
      }
    } catch (e) {
      process.stdout.write(`  ${tname}: ERR ${e.message.slice(0, 80)}\n`);
    }
  }

  nonEmpty.sort((a, b) => b.n - a.n);
  console.log(`\nTotal non-empty: ${nonEmpty.length}`);
  console.log('\nSorted by row count (highest risk first):');
  for (const t of nonEmpty) console.log(`  ${t.tname}: ${t.n}`);

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
