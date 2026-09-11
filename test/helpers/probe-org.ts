/**
 * A disposable organisation with exactly one active member, created and destroyed by the test
 * that uses it.
 *
 * WHY THIS EXISTS. Three HR db-specs opened with `const ORG_ID = "kbprobe-a"` and then
 * `SELECT ... WHERE m.org_id = 'kbprobe-a' ... if (!member) throw`. No seeder in this repository
 * creates `kbprobe-a` — grep finds the string in those three spec files and nowhere else — so it
 * was an org that existed on one developer's database and on no other. Two of the three therefore
 * failed on every machine but that one, and the third (`hr-analytics-plus-department-filter`)
 * did something worse: its assertions are "this query resolves" and "the filtered page is empty",
 * both of which a NON-EXISTENT org satisfies trivially, so it passed while measuring nothing.
 *
 * A fixture that a spec cannot create is a fixture the spec does not really have.
 *
 * WHY A FRESH ORG RATHER THAN A SEEDED ONE. `buildAttendanceAnalytics` divides by
 * `organization_members INNER JOIN users WHERE users.is_active`, and the grain regression is only
 * visible when that denominator is known exactly. The seeded scratch org carries 25+ members, so
 * the assertion would have to be written around whatever the seed happens to hold — which is how
 * a test stops pinning the thing it was written for. One member, created here, keeps the
 * arithmetic exact and makes the spec independent of every seeder.
 *
 * THE DEFERRED FOREIGN KEY IS LOAD-BEARING. `organizations.owner_membership_id` is NOT NULL and
 * points at `organization_members(org_id, id)`, which points back at the organisation — neither
 * row can be inserted first. `fk_organizations_owner_membership` is DEFERRABLE INITIALLY
 * DEFERRED precisely so the pair can be inserted inside one transaction and checked at commit;
 * the id is reserved from the sequence up front so both rows can name it. This mirrors
 * `seed-scratch-e2e.mjs`, which solves the same problem the same way.
 */
import type postgres from "postgres";

export interface ProbeOrg {
  orgId: string;
  userId: string;
  membershipId: number;
}

/** Table names are interpolated as identifiers, so they may not come from anywhere but here. */
const SAFE_TABLE = /^[a-z][a-z0-9_]*$/;

/**
 * A suffix per call rather than a fixed id: two suites running against one database would
 * otherwise collide on the primary key, and the second would delete the first's rows on teardown.
 */
function suffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function createProbeOrg(
  sql: postgres.Sql,
  label: string,
): Promise<ProbeOrg> {
  const tag = `${label}-${suffix()}`;
  const orgId = `probe-org-${tag}`;
  const userId = `probe-user-${tag}`;

  const [seqRow] = await sql<{ next_id: string }[]>`
    SELECT nextval('organization_members_id_seq')::text AS next_id`;
  const membershipId = Number(seqRow.next_id);

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO users (id, email, name, is_active)
      VALUES (${userId}, ${`${userId}@synthetic.invalid`}, ${`Probe ${tag}`}, true)`;

    await tx`
      INSERT INTO organizations (id, name, slug, status, owner_membership_id, created_at, updated_at)
      VALUES (${orgId}, ${`Probe ${tag}`}, ${orgId}, 'ACTIVE', ${membershipId}, now(), now())`;

    await tx`
      INSERT INTO organization_members (id, user_id, org_id, role, is_owner, status, joined_at)
      VALUES (${membershipId}, ${userId}, ${orgId}, 'OWNER', true, 'ACTIVE', now())`;
  });

  return { orgId, userId, membershipId };
}

/**
 * Removes the probe and anything the spec wrote against it. `orgScopedTables` is deleted first
 * and in the order given: `organizations` and `users` both have dependents, and a NO ACTION
 * foreign key refuses the parent delete rather than cascading, so a spec that leaves rows behind
 * fails teardown instead of leaking them.
 */
export async function dropProbeOrg(
  sql: postgres.Sql,
  org: ProbeOrg,
  orgScopedTables: readonly string[] = [],
): Promise<void> {
  for (const table of orgScopedTables) {
    if (!SAFE_TABLE.test(table)) throw new Error(`unsafe table name for probe teardown: ${table}`);
    await sql.unsafe(`DELETE FROM ${table} WHERE org_id = $1`, [org.orgId]);
  }

  // The organisation goes first, and the membership is never deleted directly. `trg_guard_owner_membership`
  // refuses to delete the membership an organisation still points at ("Transfer ownership first") — a real
  // product guard, not a test obstacle. It resolves `owner_membership_id` from the organisation row, so once
  // that row is gone the pointer reads NULL and the guard stands down; `organization_members.org_id` is
  // ON DELETE CASCADE, so the membership goes with it. Deleting the member first is what the guard exists
  // to stop, and working around it by disabling the trigger would make every probe teardown a place where
  // an ownership invariant is quietly suspended.
  await sql`DELETE FROM organizations WHERE id = ${org.orgId}`;
  await sql`DELETE FROM users WHERE id = ${org.userId}`;
}
