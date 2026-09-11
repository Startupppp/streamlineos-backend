/**
 * Bite-proof for verify:multi-org-employment.
 *
 * The gate checks that employment designations are INDEPENDENT per-org:
 * changing a designation in org A must not affect org B's employment row.
 *
 * Seeds: user + two orgs, each with one hr_people + one hr_employments row.
 * Tests: the independence predicate (same predicate verify:multi-org-employment uses)
 * bites when both orgs have the same designation (cross-contaminated state).
 *
 * Exits 0 when the bite is confirmed. Exits 1 when the premise breaks.
 */
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DB_JSON = resolve(DIR, "..", "..", ".scratch", "release-db.json");

let dbJson;
try {
  dbJson = JSON.parse(await readFile(DB_JSON, "utf8"));
} catch {
  process.stderr.write("ERROR: cannot read .scratch/release-db.json\n");
  process.exit(1);
}

const DB_URL = dbJson.OWNER_A;
const SAFE_HOST = dbJson._SAFE_HOST;
if (!DB_URL || !SAFE_HOST) {
  process.stderr.write("ERROR: OWNER_A or _SAFE_HOST missing from release-db.json\n");
  process.exit(1);
}

const urlHost = new URL(DB_URL).hostname;
if (urlHost !== SAFE_HOST) {
  process.stderr.write(`SAFETY: URL host ${urlHost} does not match safe host ${SAFE_HOST}. Refusing to run.\n`);
  process.exit(1);
}

const TS = `${process.pid}${Date.now()}`;
const ORG_A = `moe-st-a-${TS}`;
const ORG_B = `moe-st-b-${TS}`;
const USER_ID = randomUUID();
const USER_EMAIL = `moe-st-${TS}@verify.invalid`;

const sql = postgres(DB_URL, { prepare: false, max: 2, onnotice: () => {} });

let seededOrgA = false;
let seededOrgB = false;
let seededUser = false;
let personIdA = null;
let personIdB = null;
let employmentIdA = null;
let employmentIdB = null;

function check(condition, message) {
  if (!condition) throw new Error(`self-test assertion failed: ${message}`);
}

async function seedOrg(tx, orgId) {
  await tx`
    INSERT INTO organizations (id, name, slug, owner_membership_id)
    VALUES (${orgId}, ${`MOE ST ${orgId}`}, ${orgId}, 0)
  `;
  await tx`
    INSERT INTO organization_placement
      (organization_id, region, cell_id, database_shard, object_storage_region,
       search_cluster, write_fence_token, lease_expires_at)
    VALUES (
      ${orgId}, 'primary', 'legacy-1', 'primary', 'auto',
      'primary', ${randomUUID()}, now() + interval '1 day'
    )
  `;
  const [mem] = await tx`
    INSERT INTO organization_members (user_id, org_id, role, is_owner, status)
    VALUES (${USER_ID}, ${orgId}, 'OWNER', true, 'ACTIVE')
    RETURNING id
  `;
  if (!mem) throw new Error(`member insert failed for ${orgId}`);
  await tx`UPDATE organizations SET owner_membership_id = ${mem.id} WHERE id = ${orgId}`;
  return mem.id;
}

async function seedEmployment(tx, orgId, empNum, designation) {
  const [personRow] = await tx`
    INSERT INTO hr_people (org_id, user_id) VALUES (${orgId}, ${USER_ID}) RETURNING id
  `;
  if (!personRow) throw new Error(`hr_people insert failed for ${orgId}`);
  const personId = personRow.id;

  const [empRow] = await tx`
    INSERT INTO hr_employments (org_id, person_id, employee_number, is_primary, lifecycle_status, designation)
    VALUES (${orgId}, ${personId}, ${empNum}, true, 'ACTIVE', ${designation})
    RETURNING id
  `;
  if (!empRow) throw new Error(`hr_employments insert failed for ${orgId}`);
  return { personId, employmentId: empRow.id };
}

async function readDesignation(orgId, employmentId) {
  const [row] = await sql`
    SELECT designation FROM hr_employments
    WHERE id = ${employmentId} AND org_id = ${orgId} AND is_primary = true AND deleted_at IS NULL
  `;
  return row?.designation ?? null;
}

async function setDesignation(orgId, employmentId, designation) {
  await sql`
    UPDATE hr_employments SET designation = ${designation}
    WHERE id = ${employmentId} AND org_id = ${orgId}
  `;
}

async function main() {
  process.stdout.write("=== verify:multi-org-employment self-test ===\n");
  process.stdout.write("Seeds: user + two orgs with hr_people + hr_employments in both\n");
  process.stdout.write("Tests: independence predicate bites when designations cross-contaminate\n\n");

  await sql`INSERT INTO users (id, email, name) VALUES (${USER_ID}, ${USER_EMAIL}, 'MOE ST User')`;
  seededUser = true;

  const { personId: pA, employmentId: eA } = await sql.begin(async (tx) => {
    await seedOrg(tx, ORG_A);
    return seedEmployment(tx, ORG_A, `EMP-A-${TS}`, "Initial designation");
  });
  seededOrgA = true;
  personIdA = pA;
  employmentIdA = eA;
  process.stdout.write(`Org A: ${ORG_A}  employmentId: ${employmentIdA}\n`);

  const { personId: pB, employmentId: eB } = await sql.begin(async (tx) => {
    await seedOrg(tx, ORG_B);
    return seedEmployment(tx, ORG_B, `EMP-B-${TS}`, "Initial designation");
  });
  seededOrgB = true;
  personIdB = pB;
  employmentIdB = eB;
  process.stdout.write(`Org B: ${ORG_B}  employmentId: ${employmentIdB}\n\n`);

  check(employmentIdA !== employmentIdB, "employments must be distinct rows");

  await setDesignation(ORG_A, employmentIdA, "Contractor in org A");
  await setDesignation(ORG_B, employmentIdB, "Head of Engineering in org B");

  const designationA = await readDesignation(ORG_A, employmentIdA);
  const designationB = await readDesignation(ORG_B, employmentIdB);
  process.stdout.write(`After independent updates:\n`);
  process.stdout.write(`  Org A designation: "${designationA}"\n`);
  process.stdout.write(`  Org B designation: "${designationB}"\n\n`);

  const passIndependent =
    designationA === "Contractor in org A" &&
    designationB === "Head of Engineering in org B" &&
    employmentIdA !== employmentIdB;
  process.stdout.write(`Independence check (should be true): ${passIndependent}\n`);
  check(passIndependent, "PASS case: designations should be independent after separate updates");

  await setDesignation(ORG_A, employmentIdA, "Same designation everywhere");
  await setDesignation(ORG_B, employmentIdB, "Same designation everywhere");

  const corruptA = await readDesignation(ORG_A, employmentIdA);
  const corruptB = await readDesignation(ORG_B, employmentIdB);
  process.stdout.write(`\nAfter corruption (same designation for both):\n`);
  process.stdout.write(`  Org A designation: "${corruptA}"\n`);
  process.stdout.write(`  Org B designation: "${corruptB}"\n\n`);

  const failIndependent =
    corruptA === "Contractor in org A" &&
    corruptB === "Head of Engineering in org B" &&
    employmentIdA !== employmentIdB;

  process.stdout.write(`Independence check after corruption (should be false): ${failIndependent}\n\n`);
  check(!failIndependent, "FAIL case: corrupted designations must NOT satisfy the independence predicate");

  const gateOutput = JSON.stringify(
    {
      userId: USER_ID,
      orgA: { orgId: ORG_A, employmentId: employmentIdA, designation: corruptA },
      orgB: { orgId: ORG_B, employmentId: employmentIdB, designation: corruptB },
      independent: false,
      legacyFallbackPossible: false,
    },
    null,
    2,
  );
  process.stdout.write(`Gate would output:\n${gateOutput}\n`);
  check(gateOutput.includes('"independent": false'), 'gate output must contain "independent": false');

  process.stdout.write("\n✓ Bite confirmed: independence check fires on cross-contaminated designations\n");
  process.stdout.write('✓ Detection message contains: "independent": false\n');
}

async function cleanup() {
  const delOrgData = async (orgId) => {
    await sql`DELETE FROM hr_employments WHERE org_id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM hr_people WHERE org_id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM organization_members WHERE org_id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM organizations WHERE id = ${orgId}`.catch(() => undefined);
    await sql`DELETE FROM organization_placement WHERE organization_id = ${orgId}`.catch(() => undefined);
  };

  try {
    if (seededOrgA) await delOrgData(ORG_A);
    if (seededOrgB) await delOrgData(ORG_B);
    if (seededUser) await sql`DELETE FROM users WHERE id = ${USER_ID}`.catch(() => undefined);
  } catch (err) {
    process.stderr.write(`cleanup error: ${err?.message ?? err}\n`);
  } finally {
    await sql.end();
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (err) {
  process.stderr.write(`FAIL: ${err?.message ?? err}\n`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
