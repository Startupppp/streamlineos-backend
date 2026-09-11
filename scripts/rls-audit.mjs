/**
 * rls-audit.mjs
 * Queries pg_catalog as the owner role to enumerate RLS coverage on every
 * tenant table (those carrying an org_id column), then attempts isolation
 * proofs via the streamline_app role.
 *
 * Owner is used for catalog-only metadata (pg_class, pg_policies) — that
 * does NOT constitute an RLS proof. Isolation proofs require streamline_app;
 * if 28P01 fires, those proofs are marked OPEN with a runbook.
 *
 * Run:  node scripts/rls-audit.mjs
 *       DATABASE_URL and APP_DATABASE_URL may be supplied as env vars;
 *       if absent the script reads backend/.env (--env-file=.env flag).
 */

import postgres from 'postgres';

const OWNER_URL = process.env.DATABASE_URL;
if (!OWNER_URL) throw new Error("DATABASE_URL is required");

const APP_URL = process.env.APP_DATABASE_URL;
if (!APP_URL) throw new Error("APP_DATABASE_URL is required");

const owner = postgres(OWNER_URL, { prepare: false, ssl: 'require', max: 3 });

async function main() {
  console.log('=== RLS AUDIT (catalog via owner, isolation via streamline_app) ===\n');

  // --- Catalog query (owner, BYPASSRLS, safe for metadata only) ---
  const tables = await owner`
    SELECT
      c.relname AS table_name,
      c.relrowsecurity AS rls_enabled,
      c.relforcerowsecurity AS rls_forced,
      COUNT(p.polname) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_policy p ON p.polrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'org_id'
          AND NOT a.attisdropped
      )
    GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
    ORDER BY c.relname
  `;

  const withRls = tables.filter(t => t.rls_enabled && Number(t.policy_count) > 0);
  const rlsNoPolicies = tables.filter(t => t.rls_enabled && Number(t.policy_count) === 0);
  const noRls = tables.filter(t => !t.rls_enabled);

  console.log(`Total org_id tables: ${tables.length}`);
  console.log(`  (a) RLS enabled + >=1 policy : ${withRls.length}  — GOOD`);
  console.log(`  (b) RLS enabled, 0 policies  : ${rlsNoPolicies.length}  — deny-all (no app access)`);
  console.log(`  (c) RLS DISABLED             : ${noRls.length}  — cross-tenant holes`);

  if (rlsNoPolicies.length > 0) {
    console.log('\n=== LIST (b): RLS enabled, ZERO policies ===');
    for (const t of rlsNoPolicies) console.log(`  ${t.table_name}`);
  }

  if (noRls.length > 0) {
    console.log('\n=== LIST (c): RLS DISABLED — cross-tenant holes ===');
    for (const t of noRls) console.log(`  ${t.table_name}`);
  }

  // --- Isolation proof (streamline_app role) ---
  console.log('\n=== ISOLATION PROOF (requires streamline_app role) ===');

  let app;
  let appBroken = false;
  try {
    app = postgres(APP_URL, { prepare: false, ssl: 'require', max: 3, connect_timeout: 10 });
    await app`SELECT 1`;
  } catch (e) {
    if (e.code === '28P01') {
      appBroken = true;
      console.log('OPEN — streamline_app password authentication failed (28P01).');
      console.log('  Root cause: password rotated in Neon console but APP_DATABASE_URL not updated.');
      console.log('  Runbook:');
      console.log('    1. Log in to console.neon.tech → project ep-orange-mode-azxn5hbr');
      console.log('    2. Roles → streamline_app → Reset password → copy new password');
      console.log('    3. Update APP_DATABASE_URL in backend/.env and all deploy secrets');
      console.log('    4. Re-run: node scripts/rls-probe.mjs');
    } else {
      console.log('OPEN — unexpected connection error:', e.message);
      appBroken = true;
    }
  }

  if (!appBroken && app) {
    let orgs = [];
    try {
      orgs = await app`SELECT id FROM organizations ORDER BY created_at LIMIT 5`;
    } catch (e) {
      console.log('Cannot query organizations:', e.message);
    }

    if (orgs.length < 2) {
      console.log('Not enough orgs to prove isolation. Orgs found:', orgs.length);
    } else {
      const orgA = orgs[0].id;
      const orgB = orgs[1].id;
      let proven = 0;

      for (const t of withRls.slice(0, 10)) {
        if (proven >= 5) break;
        const tname = t.table_name;

        let countA;
        try {
          countA = await app.begin(async tx => {
            await tx.unsafe(`SET LOCAL app.organization_id = '${orgA}'`);
            const r = await tx.unsafe(`SELECT count(*)::int AS n FROM "${tname}"`);
            return r[0].n;
          });
        } catch (e) {
          console.log(`  ${tname}: orgA error — ${e.message}`);
          continue;
        }

        if (countA === 0) {
          console.log(`  ${tname}: orgA has 0 rows — empty, skip`);
          continue;
        }

        const ownA = await app.begin(async tx => {
          await tx.unsafe(`SET LOCAL app.organization_id = '${orgA}'`);
          const r = await tx.unsafe(`SELECT count(*)::int AS n FROM "${tname}" WHERE org_id = '${orgA}'`);
          return r[0].n;
        });

        const countB = await app.begin(async tx => {
          await tx.unsafe(`SET LOCAL app.organization_id = '${orgB}'`);
          const r = await tx.unsafe(`SELECT count(*)::int AS n FROM "${tname}"`);
          return r[0].n;
        });

        const isolated = (countA === ownA) && (countB === 0);
        console.log(`  ${tname}: orgA=${countA} (${ownA} own) orgB=${countB} — ${isolated ? 'PROVEN ISOLATED' : 'WARNING: possible leak'}`);
        proven++;
      }

      if (proven < 5) console.log(`Only ${proven} tables had data.`);
    }

    await app.end();
  }

  console.log('\n=== DONE ===');
  await owner.end();
}

main().catch(e => { console.error(e); process.exit(1); });
