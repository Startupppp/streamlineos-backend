/**
 * Regression test for BE#36: Active employee count must filter by membership status.
 *
 * Run with `pnpm test:db-specs` or:
 *   DATABASE_URL=... node ./node_modules/jest/bin/jest.js --config jest-db.json --runInBand \
 *     --testPathPattern="active-count-membership-status.db"
 *
 * Before the fix, active employee counts filtered only by `users.isActive = true`,
 * incorrectly counting SUSPENDED and LEFT members as active. The fix adds
 * `organizationMembers.status = 'ACTIVE'` to all active count queries.
 *
 * This test seeds members with different status values and verifies that only
 * ACTIVE members are counted in dashboard metrics and analytics overview.
 */
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { HrDashboardService } from "../hr-dashboard.service";
import { HrAnalyticsService } from "../hr-analytics.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { HrAttendanceAnalyticsService } from "../hr-attendance-analytics.service";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "active-count-membership-status.db.spec.ts",
    vars: ["DATABASE_URL", "APP_DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const ssl = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? false : "require";
  return postgres(url.toString(), { prepare: false, max: 4, ssl, connect_timeout: 30 });
}

describe("Active employee count — membership status filter (BE#36)", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let probe: ProbeOrg;
  let ORG_ID: string;
  let dashboardService: HrDashboardService;
  let analyticsService: HrAnalyticsService;
  let suspendedUserId: string;
  let leftUserId: string;

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    probe = await createProbeOrg(sql, "active-count-status");
    ORG_ID = probe.orgId;

    const cacheService = {
      cached: (_key: string, fn: () => unknown) => fn(),
      cachedVersioned: (_ns: string, _key: string, fn: () => unknown) => fn(),
      cachedVersionedForOrg: (_orgId: string, _ns: string, _key: string, fn: () => unknown) => fn(),
    } as unknown as CacheService;

    const attendanceService = new HrAttendanceAnalyticsService(db as never, cacheService);
    dashboardService = new HrDashboardService(db as never, cacheService);
    analyticsService = new HrAnalyticsService(db as never, cacheService, attendanceService);

    // Create SUSPENDED and LEFT members
    const [suspendedUser] = await sql<{ id: string }[]>`
      INSERT INTO users (email, is_active) VALUES ('suspended@test.local', true) RETURNING id
    `;
    suspendedUserId = suspendedUser.id;

    const [leftUser] = await sql<{ id: string }[]>`
      INSERT INTO users (email, is_active) VALUES ('left@test.local', true) RETURNING id
    `;
    leftUserId = leftUser.id;

    await sql`
      INSERT INTO organization_members (user_id, org_id, role, status)
      VALUES
        (${suspendedUserId}, ${ORG_ID}, 'MEMBER', 'SUSPENDED'),
        (${leftUserId}, ${ORG_ID}, 'MEMBER', 'LEFT')
    `;
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      if (suspendedUserId) await sql`DELETE FROM users WHERE id = ${suspendedUserId}`;
      if (leftUserId) await sql`DELETE FROM users WHERE id = ${leftUserId}`;
      if (probe) await dropProbeOrg(sql, probe, []);
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("dashboard metrics() counts only ACTIVE members, not SUSPENDED or LEFT", async () => {
    const metrics = await dashboardService.metrics(ORG_ID);

    // Total includes all statuses (the original probe member + SUSPENDED + LEFT)
    expect(metrics.totalEmployees).toBeGreaterThanOrEqual(3);

    // Active must be exactly 1 (only the original ACTIVE probe member)
    expect(metrics.activeEmployees).toBe(1);

    // Active must exclude the SUSPENDED and LEFT members
    expect(metrics.activeEmployees).toBeLessThan(metrics.totalEmployees);
  });

  it("dashboard diversity() counts only ACTIVE members", async () => {
    const diversity = await dashboardService.diversity(ORG_ID);

    // Gender breakdown should only include ACTIVE members
    const totalInGenderBreakdown = diversity.genderBreakdown.reduce((sum, g) => sum + g.count, 0);
    expect(totalInGenderBreakdown).toBe(1);
  });

  it("analytics overview() counts only ACTIVE members", async () => {
    const overview = await analyticsService.overview(ORG_ID);

    // Active count must be exactly 1 (only the original ACTIVE probe member)
    expect(overview.headcount.active).toBe(1);

    // Total is at least 3 (ACTIVE + SUSPENDED + LEFT)
    expect(overview.headcount.total).toBeGreaterThanOrEqual(3);

    // Departments breakdown should only include ACTIVE members
    const totalInDepartments = overview.departments.reduce((sum, d) => sum + d.count, 0);
    expect(totalInDepartments).toBe(1);

    // Gender breakdown should only include ACTIVE members
    const totalInGender = overview.gender.reduce((sum, g) => sum + g.count, 0);
    expect(totalInGender).toBe(1);

    // Roles breakdown should only include ACTIVE members
    const totalInRoles = overview.roles.reduce((sum, r) => sum + r.count, 0);
    expect(totalInRoles).toBe(1);
  });

  it("active count matches the scope of a filtered member list query", async () => {
    // Simulate what the frontend list query does: filter by ACTIVE status
    const activeMembers = await db.query.organizationMembers.findMany({
      where: (members, { and, eq }) =>
        and(eq(members.orgId, ORG_ID), eq(members.status, "ACTIVE")),
    });

    const metrics = await dashboardService.metrics(ORG_ID);

    // The active count must match the filtered list length
    expect(metrics.activeEmployees).toBe(activeMembers.length);
  });
});
