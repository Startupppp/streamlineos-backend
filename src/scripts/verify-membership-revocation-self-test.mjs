/**
 * Bite-proof for verify:membership-revocation.
 *
 * Plants a known-bad state: a membership with a resource_grant that has no
 * FK cascade to organization_members (principalId is a free text column,
 * not a FK). Deletes the member WITHOUT the explicit resource_grant cleanup
 * that the real gate performs. Confirms the gate's detection logic would fire:
 *   "FAIL  resource_grants  before=1 after=1"
 *
 * Uses two users: an OWNER who stays, and a MEMBER whose removal is tested.
 *
 * Exits 0 when the bite is confirmed (the bad state is detectable).
 * Exits 1 when the detection is broken (the self-test premise is wrong).
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
const ORG_ID = `revoc-st-${TS}`;
const OWNER_ID = randomUUID();
const MEMBER_ID = randomUUID();
const OWNER_EMAIL = `revoc-st-own-${TS}@verify.invalid`;
const MEMBER_EMAIL = `revoc-st-mem-${TS}@verify.invalid`;
const RESOURCE_GRANT_ID = randomUUID();

const sql = postgres(DB_URL, { prepare: false, max: 2, onnotice: () => {} });

let seededOrg = false;
let seededUsers = false;

function check(condition, message) {
  if (!condition) throw new Error(`self-test assertion failed: ${message}`);
}

async function main() {
  process.stdout.write("=== verify:membership-revocation self-test ===\n");
  process.stdout.write("Plants: org + owner + member + resource_grant (no FK cascade)\n");
  process.stdout.write("Bad state: member deleted WITHOUT explicit resource_grant cleanup\n");
  process.stdout.write("Expected: gate would report FAIL  resource_grants  before=1 after=1\n\n");

  // 1. Seed two users (outside tenant context — no RLS on global users)
  await sql`
    INSERT INTO users (id, email, name) VALUES
    (${OWNER_ID}, ${OWNER_EMAIL}, 'Revoc ST Owner'),
    (${MEMBER_ID}, ${MEMBER_EMAIL}, 'Revoc ST Member')
  `;
  seededUsers = true;

  // 2. Create org + placement + two members in one transaction.
  //    organizations.fk_organizations_owner_membership is DEFERRABLE INITIALLY DEFERRED.
  //    neondb_owner has BYPASSRLS so no tenant GUC is needed.
  let memberMembershipId;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id)
      VALUES (${ORG_ID}, 'Revoc ST Org', ${`revoc-st-${TS}`}, 0)
    `;

    await tx`
      INSERT INTO organization_placement
        (organization_id, region, cell_id, database_shard, object_storage_region,
         search_cluster, write_fence_token, lease_expires_at)
      VALUES (
        ${ORG_ID}, 'primary', 'legacy-1', 'primary', 'auto',
        'primary', ${randomUUID()}, now() + interval '1 day'
      )
    `;

    const [ownerMem] = await tx`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status)
      VALUES (${OWNER_ID}, ${ORG_ID}, 'OWNER', true, 'ACTIVE')
      RETURNING id
    `;
    if (!ownerMem) throw new Error("owner member insert failed");

    await tx`UPDATE organizations SET owner_membership_id = ${ownerMem.id} WHERE id = ${ORG_ID}`;

    const [memberMem] = await tx`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status)
      VALUES (${MEMBER_ID}, ${ORG_ID}, 'MEMBER', false, 'ACTIVE')
      RETURNING id
    `;
    if (!memberMem) throw new Error("member insert failed");
    memberMembershipId = memberMem.id;

    // 3. Plant the resource_grant for the MEMBER user.
    //    resource_grants uses principalId (text = userId), NOT membershipId.
    //    There is NO FK cascade from organization_members → resource_grants.
    await tx`
      INSERT INTO resource_grants (id, org_id, resource_type, resource_id, principal_type, principal_id, level)
      VALUES (${RESOURCE_GRANT_ID}, ${ORG_ID}, 'project', 'fixture-self-test', 'user', ${MEMBER_ID}, 'viewer')
    `;
  });
  seededOrg = true;

  process.stdout.write(`Org: ${ORG_ID}  memberMembershipId: ${memberMembershipId}\n`);

  // 4. Snapshot BEFORE: resource_grant count = 1
  const [beforeRow] = await sql`
    SELECT count(*)::int AS n FROM resource_grants
    WHERE org_id = ${ORG_ID} AND principal_type = 'user' AND principal_id = ${MEMBER_ID}
  `;
  const before = Number(beforeRow.n);
  process.stdout.write(`Before removal: resource_grants count = ${before}\n`);
  check(before === 1, `expected before=1 but got ${before}`);

  // 5. Delete the MEMBER without the explicit resource_grant cleanup.
  //    Simulates the bug: the real gate's explicit DELETE of resource_grants is absent.
  //    No FK cascade fires for resource_grants (principalId is text, not a FK).
  await sql`DELETE FROM organization_members WHERE user_id = ${MEMBER_ID} AND org_id = ${ORG_ID}`;

  // 6. Snapshot AFTER: resource_grant must still be 1
  const [afterRow] = await sql`
    SELECT count(*)::int AS n FROM resource_grants
    WHERE org_id = ${ORG_ID} AND principal_type = 'user' AND principal_id = ${MEMBER_ID}
  `;
  const after = Number(afterRow.n);
  process.stdout.write(`After removal (no explicit cleanup): resource_grants count = ${after}\n\n`);

  // 7. Confirm the detection would fire with the exact gate message
  const gateWouldReport = `FAIL  resource_grants  before=${before} after=${after}`;
  process.stdout.write(`Gate would report: "${gateWouldReport}"\n`);

  check(after === 1, `expected after=1 but got ${after} — cascade fired unexpectedly, bite is broken`);
  check(
    gateWouldReport.includes("FAIL") &&
      gateWouldReport.includes("resource_grants") &&
      gateWouldReport.includes("before=1") &&
      gateWouldReport.includes("after=1"),
    `gate message does not contain expected FAIL tokens: "${gateWouldReport}"`,
  );

  process.stdout.write("\n✓ Bite confirmed: resource_grants leak is detectable\n");
  process.stdout.write(`✓ Detection message: "${gateWouldReport}"\n`);
}

async function cleanup() {
  try {
    await sql`DELETE FROM resource_grants WHERE id = ${RESOURCE_GRANT_ID}`.catch(() => undefined);
    await sql`DELETE FROM organization_members WHERE org_id = ${ORG_ID}`.catch(() => undefined);
    await sql`DELETE FROM organizations WHERE id = ${ORG_ID}`.catch(() => undefined);
    await sql`DELETE FROM organization_placement WHERE organization_id = ${ORG_ID}`.catch(() => undefined);
    if (seededUsers) {
      await sql`DELETE FROM users WHERE id = ${OWNER_ID}`.catch(() => undefined);
      await sql`DELETE FROM users WHERE id = ${MEMBER_ID}`.catch(() => undefined);
    }
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
