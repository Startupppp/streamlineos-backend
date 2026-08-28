// Usage:
//   node scripts/seed-employment-read-scale.mjs --seed [--employments=6000] [--lines=1500]
//   node scripts/seed-employment-read-scale.mjs --purge
//   node scripts/seed-employment-read-scale.mjs --count
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

export const SCALE_ORG_ID = "5ca1e000-0000-4000-8000-000000000001";

const args = process.argv.slice(2);
const mode = args.includes("--purge")
  ? "purge"
  : args.includes("--count")
    ? "count"
    : args.includes("--seed")
      ? "seed"
      : null;

if (!mode) {
  process.stderr.write("Pass one of --seed | --purge | --count\n");
  process.exit(2);
}

const numArg = (name, fallback) => {
  const raw = args.find((a) => a.startsWith(`--${name}=`));
  return raw ? Number(raw.slice(name.length + 3)) : fallback;
};

const EMPLOYMENTS = numArg("employments", 6000);
const LINES = numArg("lines", 1500);

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(2);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

async function counts() {
  const [row] = await sql`
    SELECT
      (SELECT count(*)::int FROM hr_employments   WHERE org_id = ${SCALE_ORG_ID}) AS employments,
      (SELECT count(*)::int FROM hr_people        WHERE org_id = ${SCALE_ORG_ID}) AS people,
      (SELECT count(*)::int FROM hr_reporting_lines WHERE org_id = ${SCALE_ORG_ID}) AS lines,
      (SELECT count(*)::int FROM organization_members WHERE org_id = ${SCALE_ORG_ID}) AS members`;
  return row;
}

async function purge() {
  await sql`DELETE FROM hr_reporting_lines  WHERE org_id = ${SCALE_ORG_ID}`;
  await sql`DELETE FROM hr_employments      WHERE org_id = ${SCALE_ORG_ID}`;
  await sql`DELETE FROM hr_people           WHERE org_id = ${SCALE_ORG_ID}`;
  await sql`DELETE FROM organization_people WHERE organization_id = ${SCALE_ORG_ID}`;
  await sql`DELETE FROM organizations       WHERE id = ${SCALE_ORG_ID}`;
  await sql`DELETE FROM organization_members WHERE org_id = ${SCALE_ORG_ID}`;
  for (;;) {
    const deleted = await sql`
      DELETE FROM users
      WHERE id IN (
        SELECT id FROM users WHERE email LIKE 'read-scale-%@fixture.invalid' LIMIT 500)
      RETURNING id`;
    if (deleted.length === 0) break;
  }
}

async function seed() {
  await sql.begin(async (tx) => {
    const [existing] = await tx`SELECT id FROM organizations WHERE id = ${SCALE_ORG_ID}`;
    if (existing) return;

    const [seq] = await tx`
      SELECT nextval(pg_get_serial_sequence('organization_members', 'id'))::int AS id`;
    const ownerMembershipId = seq.id;
    const ownerUserId = "00000000-0000-4000-8000-000000000001";

    await tx`
      INSERT INTO users (id, email, first_name, last_name, name, is_active)
      VALUES (${ownerUserId}, 'read-scale-owner@fixture.invalid', 'Scale', 'Owner', 'Scale Owner', true)
      ON CONFLICT (id) DO NOTHING`;

    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id, status)
      VALUES (${SCALE_ORG_ID}, 'Read Scale Fixture',
              ${`read-scale-${Date.now().toString(36)}`}, ${ownerMembershipId}, 'ACTIVE')`;

    await tx`
      INSERT INTO organization_members (id, org_id, user_id, role, status, is_owner, joined_at)
      VALUES (${ownerMembershipId}, ${SCALE_ORG_ID}, ${ownerUserId}, 'OWNER', 'ACTIVE', true, now())`;
  });

  await sql`
    INSERT INTO users (id, email, first_name, last_name, name, is_active)
    SELECT
      ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
      'read-scale-' || g || '@fixture.invalid',
      'Scale', g::text, 'Scale ' || g, true
    FROM generate_series(1, ${EMPLOYMENTS}) g
    ON CONFLICT (id) DO NOTHING`;

  await sql`
    INSERT INTO organization_members (org_id, user_id, role, status, joined_at)
    SELECT ${SCALE_ORG_ID},
      ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
      'MEMBER', 'ACTIVE', now() - (g || ' minutes')::interval
    FROM generate_series(1, ${EMPLOYMENTS}) g
    ON CONFLICT DO NOTHING`;

  await sql`
    INSERT INTO organization_people (organization_person_id, organization_id, first_name, last_name, user_id)
    SELECT
      ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
      ${SCALE_ORG_ID}, 'Scale', g::text,
      ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid
    FROM generate_series(1, ${EMPLOYMENTS}) g
    ON CONFLICT DO NOTHING`;

  await sql`
    INSERT INTO hr_people (org_id, user_id, organization_person_id)
    SELECT ${SCALE_ORG_ID},
      ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
      ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid
    FROM generate_series(1, ${EMPLOYMENTS}) g
    ON CONFLICT DO NOTHING`;

  await sql`
    INSERT INTO hr_employments (org_id, person_id, employee_number, designation, joining_date, is_primary)
    SELECT ${SCALE_ORG_ID}, p.id,
      'RS-' || row_number() OVER (ORDER BY p.id),
      (ARRAY['Engineer','Analyst','Manager','Designer','Lead'])[1 + (p.id % 5)],
      (date '2020-01-01' + ((p.id % 1500) || ' days')::interval)::date,
      true
    FROM hr_people p
    WHERE p.org_id = ${SCALE_ORG_ID}
      AND NOT EXISTS (SELECT 1 FROM hr_employments e WHERE e.person_id = p.id AND e.org_id = ${SCALE_ORG_ID})`;

  await sql`
    INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, line_type, effective_from, effective_to)
    SELECT ${SCALE_ORG_ID}, e.id, m.id, 'primary', date '2024-01-01', 'infinity'::date
    FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM hr_employments WHERE org_id = ${SCALE_ORG_ID}) e
    JOIN (SELECT id, row_number() OVER (ORDER BY id) rn FROM hr_employments WHERE org_id = ${SCALE_ORG_ID}) m
      ON m.rn = (e.rn % 50) + 1
    WHERE e.rn <= ${LINES}
      AND NOT EXISTS (
        SELECT 1 FROM hr_reporting_lines rl
        WHERE rl.org_id = ${SCALE_ORG_ID} AND rl.employment_id = e.id AND rl.line_type = 'primary')`;

  await sql.unsafe(`VACUUM ANALYZE hr_employments`);
  await sql.unsafe(`VACUUM ANALYZE hr_people`);
  await sql.unsafe(`VACUUM ANALYZE hr_reporting_lines`);
  await sql.unsafe(`VACUUM ANALYZE organization_members`);
}

try {
  if (mode === "seed") await seed();
  if (mode === "purge") await purge();
  const final = await counts();
  process.stdout.write(
    JSON.stringify({ mode, orgId: SCALE_ORG_ID, ...final }, null, 2) + "\n",
  );
} finally {
  await sql.end({ timeout: 5 });
}
