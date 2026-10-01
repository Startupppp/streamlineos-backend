/**
 * The first real-database exercise of `membershipTeamScope` (timesheets-core-scope.ts:96).
 *
 * Until now that `EXISTS` — five tables, `hr_reporting_lines` → `hr_employments` →
 * `hr_people` → `organization_members`, bounded by `app.org_business_date` — had only
 * ever been verified as rendered SQL by `timesheets-core-scope.spec.ts`, which asserts
 * the text of the fragment and never asks a server whether it selects the right rows.
 * Eighteen read predicates across `modules/timesheets` depend on it.
 *
 * It must run as a NOBYPASSRLS role with the tenant GUC set (BE-76): every table in the
 * join carries RLS, so as the owner the `EXISTS` is answered from rows the app can never
 * see, and as the app role with no GUC `app.current_org_id()` raises 42501. Both make a
 * false green.
 *
 * ANTI-VACUITY. The positive case runs first and is asserted on explicitly. If the
 * semi-join returns nothing under the app role, every exclusion below would still pass as
 * "correctly excluded" while proving nothing, so the suite refuses to interpret an empty
 * positive result as a pass.
 *
 *   APP_DATABASE_URL=postgresql://streamline_app@127.0.0.1:5432/<scratch db> \
 *     pnpm test:db-specs --testPathPattern="timesheets-team-scope.db"
 *
 * Fixtures are the two-org reporting graph seeded by the proof run; every write this
 * suite makes is rolled back.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { timesheets, organizationMembers } from "../../../db/schema";
import { ScopedRead } from "../../access/scoped-read";
import { membershipTeamScope } from "./timesheets-core-scope";
import { dbSpecClient, dbSpecSuite, dbSpecUrl } from "../../../test/db-spec-gate";

const describeDb = dbSpecSuite(["APP_DATABASE_URL"]);

const ORG_A = "orgA";
const ORG_B = "orgB";
const MGR_A = { userId: "u_mgr", membershipId: 1 };
const MGR_B = { userId: "u_bmgr", membershipId: 2 };
const REP1 = 10; // direct report of MGR_A
const REP2 = 11; // reports to REP1 — second level, must not be visible
const OTHER = 12; // unrelated member
const EXPIRED = 13; // reporting line ended yesterday (org business date)
const FUTURE = 14; // reporting line starts tomorrow
const SOFT_DELETED = 15; // hr_people.deleted_at set
const NON_PRIMARY = 16; // only a non-primary hr_employments row
const REP_B = 20; // report in the other org

describeDb("membershipTeamScope — real database, app role, tenant GUC", () => {
  const client = dbSpecClient(dbSpecUrl("APP_DATABASE_URL"), { max: 1 });
  const db = drizzle(client);

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  /** Runs a team-scoped read of `timesheets.user_membership_id` the way the services do. */
  async function teamOwners(
    orgId: string,
    actor: { userId: string; membershipId: number },
  ): Promise<number[]> {
    const read = ScopedRead.of(orgId, actor.userId, "team");
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.organization_id', ${orgId}, true)`);
      return read.read(
        {
          tenant: timesheets.orgId,
          scope: membershipTeamScope(orgId, actor.userId, actor.membershipId, timesheets.userMembershipId),
        },
        async (where) => {
          const rows = await tx
            .select({ owner: timesheets.userMembershipId })
            .from(timesheets)
            .where(where.sql);
          return rows.map((r) => r.owner).filter((v): v is number => v !== null);
        },
        () => [] as number[],
      );
    });
  }

  it("connects as a role RLS applies to, with no bypass", async () => {
    const rows = await client`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("includes the manager's own row AND a direct report's — the join resolves, so the exclusions below mean something", async () => {
    const owners = await teamOwners(ORG_A, MGR_A);
    expect(owners).toContain(MGR_A.membershipId);
    expect(owners).toContain(REP1);
  });

  it("excludes an unrelated member of the same org", async () => {
    expect(await teamOwners(ORG_A, MGR_A)).not.toContain(OTHER);
  });

  it("excludes a report-of-a-report: the one-hop join does not walk transitively", async () => {
    expect(await teamOwners(ORG_A, MGR_A)).not.toContain(REP2);
  });

  it("excludes a line that ended before the org business date and one that starts after it", async () => {
    const owners = await teamOwners(ORG_A, MGR_A);
    expect(owners).not.toContain(EXPIRED);
    expect(owners).not.toContain(FUTURE);
  });

  it("bounds the line by the ORG business date, not the session date", async () => {
    // The fixture org sits in a zone whose date differs from the connection's
    // CURRENT_DATE right now; if it does not, this assertion proves nothing and says so.
    const [row] = await client`
      SELECT app.org_business_date(${ORG_A}) AS org_date, CURRENT_DATE AS session_date`;
    expect(String(row?.org_date)).not.toEqual(String(row?.session_date));
  });

  it("excludes a soft-deleted person and a report whose only employment is non-primary", async () => {
    const owners = await teamOwners(ORG_A, MGR_A);
    expect(owners).not.toContain(SOFT_DELETED);
    expect(owners).not.toContain(NON_PRIMARY);
  });

  it("gives a manager in one org nothing for a report in another", async () => {
    expect(await teamOwners(ORG_A, MGR_A)).not.toContain(REP_B);
    const bOwners = await teamOwners(ORG_B, MGR_B);
    expect(bOwners).toContain(REP_B); // positive half (BE-141): org B's own graph does resolve
    expect(bOwners).not.toContain(REP1);
  });

  it("widens the roster read on organization_members the same way", async () => {
    const read = ScopedRead.of(ORG_A, MGR_A.userId, "team");
    const ids = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.organization_id', ${ORG_A}, true)`);
      return read.read(
        {
          tenant: organizationMembers.orgId,
          scope: membershipTeamScope(ORG_A, MGR_A.userId, MGR_A.membershipId, organizationMembers.id),
        },
        async (where) => {
          const rows = await tx.select({ id: organizationMembers.id }).from(organizationMembers).where(where.sql);
          return rows.map((r) => r.id);
        },
        () => [] as number[],
      );
    });
    expect(ids).toEqual(expect.arrayContaining([MGR_A.membershipId, REP1]));
    expect(ids).not.toContain(OTHER);
  });
});
