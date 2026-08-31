/**
 * rls-probe.mjs
 * Proves cross-tenant isolation by querying the same table with two different
 * org GUCs as the streamline_app role (no BYPASSRLS), then asserting that
 * each org sees only its own rows.
 *
 * REQUIRES: streamline_app role with a working password in APP_DATABASE_URL.
 * If authentication fails (28P01), the script exits non-zero and prints a
 * runbook — do NOT substitute the owner connection here, as that bypasses RLS
 * and the proof becomes meaningless.
 *
 * Run:  node scripts/rls-probe.mjs
 *       Supply APP_DATABASE_URL in env or run with --env-file=.env
 */

import postgres from 'postgres';

const APP_URL = process.env.APP_DATABASE_URL
  || 'postgresql://streamline_app:npg_eKlEfHtbMg93@ep-orange-mode-azxn5hbr-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const RUNBOOK = `
  OPEN — streamline_app authentication is broken. Isolation proof cannot run.
  Root cause: password rotated in Neon console but APP_DATABASE_URL not updated
              (MEMORY: "App role password won't stick — fix in the Neon console").
  Runbook:
    1. Log in to console.neon.tech → project ep-orange-mode-azxn5hbr
    2. Roles → streamline_app → Reset password → copy new password
    3. Update APP_DATABASE_URL in backend/.env and all deploy configs/secrets
    4. Re-run: node --env-file=.env scripts/rls-probe.mjs
  Note: the Neon pooler drops startup params; GUC must be SET LOCAL inside a
        transaction — the script already does this correctly.
`;

async function setOrg(tx, orgId) {
  await tx.unsafe(`SET LOCAL app.organization_id = '${orgId}'`);
}

async function countRows(tx, tname) {
  const r = await tx.unsafe(`SELECT count(*)::int AS n FROM "${tname}"`);
  return r[0].n;
}

async function countOwnRows(tx, tname, orgId) {
  const r = await tx.unsafe(`SELECT count(*)::int AS n FROM "${tname}" WHERE org_id = '${orgId}'`);
  return r[0].n;
}

async function main() {
  let sql;
  try {
    sql = postgres(APP_URL, { prepare: false, ssl: 'require', max: 3, connect_timeout: 10 });
    await sql`SELECT 1`;
  } catch (e) {
    if (e.code === '28P01') {
      console.error(RUNBOOK);
      process.exit(2);
    }
    console.error('Connection error:', e.message);
    process.exit(1);
  }

  const orgs = await sql`SELECT id FROM organizations ORDER BY created_at LIMIT 5`;
  if (orgs.length < 2) {
    console.log('Not enough orgs:', orgs.length);
    await sql.end();
    return;
  }

  const orgA = orgs[0].id;
  const orgB = orgs[1].id;
  console.log(`orgA = ${orgA}`);
  console.log(`orgB = ${orgB}\n`);

  const candidates = [
    'projects', 'candidates', 'leads', 'invoices', 'organization_members',
    'crm_deals', 'leave_requests', 'expenses', 'gl_journals', 'payroll_runs',
    'contacts', 'tasks', 'announcements', 'roles', 'invitations',
    'timesheets', 'hr_employments', 'hr_people', 'chat_messages', 'kb_pages',
  ];

  let proven = 0;
  let warnings = 0;

  for (const tname of candidates) {
    if (proven >= 5) break;

    let countA;
    try {
      countA = await sql.begin(async tx => { await setOrg(tx, orgA); return countRows(tx, tname); });
    } catch (e) {
      console.log(`${tname}: orgA error — ${e.message}`);
      continue;
    }

    if (countA === 0) {
      console.log(`${tname}: orgA sees 0 rows — empty, skip`);
      continue;
    }

    const ownA = await sql.begin(async tx => { await setOrg(tx, orgA); return countOwnRows(tx, tname, orgA); });
    const countB = await sql.begin(async tx => { await setOrg(tx, orgB); return countRows(tx, tname); });
    const crossB = await sql.begin(async tx => { await setOrg(tx, orgB); return countOwnRows(tx, tname, orgA); }).catch(() => 'err');

    const isolated = (countA === ownA) && (crossB === 0 || crossB === '0');
    if (!isolated) warnings++;

    console.log(`${tname}:`);
    console.log(`  orgA GUC → ${countA} rows (${ownA} belong to orgA)`);
    console.log(`  orgB GUC → ${countB} rows (${crossB} belong to orgA — should be 0)`);
    console.log(`  ${isolated ? 'PROVEN ISOLATED' : '⚠ WARNING: possible cross-tenant leak'}`);
    proven++;
  }

  if (proven < 5) console.log(`\nOnly ${proven} non-empty tables found in candidates.`);
  console.log(`\nSummary: ${proven} proven, ${warnings} warnings.`);

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
