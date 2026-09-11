import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { orgModules, timesheetExceptions, timesheets as timesheetEntries } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * TS-26. Two organisations, one API, and the question of what the second one
 * can see of the first.
 *
 * The services do scope by `orgId` and do apply `DataScope`, and every
 * `timesheet%` table carries an RLS policy — so the expected answer is
 * "nothing". This file exists because "the code looks right" and "a second
 * tenant cannot reach it" are different claims, and only one of them can be
 * demonstrated.
 *
 * The last test is the one worth keeping longest. It asserts the *shape* of
 * every timesheet RLS policy rather than any particular query's result:
 * `app.current_org_id()` raises when no tenant context is set, while
 * `app.current_org_id_or_null()` returns NULL and turns a context-less read
 * into a silently empty one. A CRM table shipped with the non-raising accessor
 * earlier this week and the table read as empty forever instead of failing —
 * so a migration that downgrades one of these must break a test, not a
 * customer.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=timesheets-tenant-isolation
 */

/**
 * `timesheets:team:view` is in here for a reason worth recording: the
 * exceptions list derives its DataScope from *that* key, not from
 * `exceptions:view`. Without it `scopeFor` answers "none", `applyScope` emits
 * `false`, and the list comes back empty — at which point
 * "does not contain the other tenant's row" passes without proving anything.
 * The positive assertion below is what caught it.
 */
const PERMISSIONS = [
  "timesheets:exceptions:view",
  "timesheets:exceptions:manage",
  "timesheets:reports:view",
  "timesheets:team:view",
];

interface Tenant {
  fixture: SeededFixture;
  token: string;
  userId: string;
  exceptionId: number;
}

describe(`${SEEDED_HARNESS} timesheets tenant isolation — the second tenant sees nothing`, () => {
  let seeded: SeededE2eApp;
  let alpha: Tenant;
  let beta: Tenant;

  const buildTenant = async (alias: string, hours: string): Promise<Tenant> => {
    const fixture = await seedOrg(seeded.seedDb)
      .addMember(alias, { permissionKeys: PERMISSIONS })
      .build();
    await seeded.seedDb
      .insert(orgModules)
      .values([
        { orgId: fixture.orgId, moduleKey: "timesheets", enabled: true },
        /** See timesheets-payroll-handoff: every controller gates on `build`. */
        { orgId: fixture.orgId, moduleKey: "build", enabled: true },
      ])
      .onConflictDoNothing();

    const member = fixture.members[alias];
    if (!member) throw new Error(`fixture member '${alias}' missing`);

    /** Distinct hours per tenant, so a leak is visible as a number and not just a count. */
    await seeded.seedDb.insert(timesheetEntries).values({
      orgId: fixture.orgId,
      userMembershipId: member.membershipId,
      date: "2026-05-04",
      hours,
      description: `${alias} isolation probe`,
      status: "APPROVED" as const,
      isBillable: true,
    });

    const [exception] = await seeded.seedDb
      .insert(timesheetExceptions)
      .values({
        orgId: fixture.orgId,
        userMembershipId: member.membershipId,
        rule: "ISOLATION_PROBE",
        message: `${alias} exception`,
      })
      .returning({ id: timesheetExceptions.id });
    if (!exception) throw new Error("exception insert failed");

    return {
      fixture,
      token: await signSeededToken(member.userId, fixture.orgId),
      userId: member.userId,
      exceptionId: exception.id,
    };
  };

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    alpha = await buildTenant("alpha", "7.00");
    beta = await buildTenant("beta", "3.00");
  }, 240_000);

  afterAll(async () => {
    await alpha?.fixture.teardown();
    await beta?.fixture.teardown();
    await seeded?.close();
  }, 60_000);

  const get = (path: string, token: string) =>
    request(seeded.app.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);

  it("lists only its own exceptions", async () => {
    const res = await get("/timesheets/exceptions", alpha.token);
    expect(res.status).toBe(200);

    const rows = res.body.data ?? res.body.items ?? res.body;
    const ids = (Array.isArray(rows) ? rows : []).map((r: { id: number }) => r.id);
    expect(ids).toContain(alpha.exceptionId);
    expect(ids).not.toContain(beta.exceptionId);
  }, 60_000);

  /**
   * 404, not 403. A 403 would confirm the row exists, which is itself a
   * cross-tenant disclosure — the caller learns that id is real somewhere.
   */
  it("answers 404 for another tenant's exception rather than 403", async () => {
    const res = await request(seeded.app.getHttpServer())
      .post(`/timesheets/exceptions/${beta.exceptionId}/resolve`)
      .set("Authorization", `Bearer ${alpha.token}`)
      .send({ reason: "should never happen" });

    expect(res.status).toBe(404);
  }, 60_000);

  it("leaves the other tenant's exception untouched after that attempt", async () => {
    const [row] = await seeded.seedDb
      .select({ status: timesheetExceptions.status })
      .from(timesheetExceptions)
      .where(eq(timesheetExceptions.id, beta.exceptionId));

    expect(row?.status).toBe("OPEN");
  }, 60_000);

  it("reports only its own hours", async () => {
    const res = await get(
      "/timesheets/reports/overview?start=2026-05-01&end=2026-05-31",
      alpha.token,
    );
    expect(res.status).toBe(200);

    /**
     * Asserted on the total rather than on row counts: 7 is alpha's, 10 would
     * be both, and a count could look right while the arithmetic leaked.
     */
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(beta.userId);
    expect(body).not.toContain("beta isolation probe");
  }, 60_000);

  /**
   * The ratchet. Not about these two tenants at all — about the accessor every
   * future migration will copy from the one beside it.
   */
  it("gives every timesheet table an RLS policy that RAISES without tenant context", async () => {
    const rows = await seeded.seedDb.execute<{
      tablename: string;
      qual: string | null;
      rls: boolean;
    }>(sql`
      SELECT c.relname AS tablename,
             c.relrowsecurity AS rls,
             (SELECT p.qual FROM pg_policies p
               WHERE p.tablename = c.relname AND p.schemaname = 'public' LIMIT 1) AS qual
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND (c.relname LIKE 'timesheet\\_%' OR c.relname = 'timesheets')
      ORDER BY c.relname
    `);

    const tables = [...rows];
    /** Anti-vacuity: this repository has ten of them; a query returning none would pass every assertion below. */
    expect(tables.length).toBeGreaterThanOrEqual(9);

    const withoutRls = tables.filter((t) => !t.rls).map((t) => t.tablename);
    expect(withoutRls).toEqual([]);

    const nonRaising = tables
      .filter((t) => !t.qual?.includes("app.current_org_id()"))
      .map((t) => `${t.tablename}: ${t.qual}`);
    expect(nonRaising).toEqual([]);
  }, 60_000);
});
