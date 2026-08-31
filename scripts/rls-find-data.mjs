/**
 * rls-find-data.mjs
 * Scans every RLS-enabled org_id table and reports non-empty ones.
 * Runs as the database OWNER (BYPASSRLS) so counts are unfiltered
 * cross-org totals — this is sufficient to identify higher-risk tables
 * that have live data, but does NOT prove RLS isolation.
 * Use rls-probe.mjs for isolation proofs (requires streamline_app auth).
 *
 * Run:  node scripts/rls-find-data.mjs
 */

import postgres from 'postgres';

const OWNER_URL = process.env.DATABASE_URL
  || 'postgresql://neondb_owner:npg_uHztXRn51MdW@ep-orange-mode-azxn5hbr-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const sql = postgres(OWNER_URL, { prepare: false, ssl: 'require', max: 3 });

async function main() {
  const orgs = await sql`SELECT id FROM organizations ORDER BY created_at LIMIT 5`;
  console.log('orgs:', orgs.map(o => o.id));

  const tables = await sql`
    SELECT c.relname AS table_name
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

  console.log(`\nScanning ${tables.length} RLS tables for data (owner BYPASSRLS — counts are org-wide)...`);

  const nonEmpty = [];
  for (const t of tables) {
    const tname = t.table_name;
    try {
      const r = await sql.unsafe(`SELECT count(*)::int AS n FROM "${tname}"`);
      const n = r[0].n;
      if (n > 0) {
        nonEmpty.push({ tname, n });
        process.stdout.write(`${tname}: ${n}\n`);
      }
    } catch (e) {
      process.stdout.write(`${tname}: ERR ${e.message.slice(0, 60)}\n`);
    }
  }

  console.log(`\nNon-empty tables: ${nonEmpty.length}`);
  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
