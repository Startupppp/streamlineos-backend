/**
 * HRMS-E2E-015 — a person who was invited but never accepted is not headcount.
 *
 * `users.is_active` is the ACCOUNT flag. An administrator creating the person
 * sets it true immediately, before any invitation has been opened, so every
 * aggregate that filtered on it alone reported an unaccepted invitee as an
 * active employee. `getEmployeeCounts` (directory) was fixed first; the
 * analytics aggregates that feed the HR dashboards were not, and they are the
 * numbers a founder actually reads.
 *
 * Acceptance is `users.email_verified` being non-null — set when the magic link
 * is first followed. Nothing is stored; the split is computed at read time.
 *
 * These run the real services over the in-memory SQL evaluator, so the
 * assertion is the number a caller gets back, not that a line was reached.
 */

import type { Redis } from "@upstash/redis";
import { CacheService } from "../../../common/cache/cache.service";
import { InMemoryRedis } from "../../../common/cache/in-memory-redis.test-double";
import type { Db } from "../../../db/drizzle.module";
import { makeFakeDb, type TableRows } from "../../../test/fake-select-db";
import { HrAnalyticsService } from "./hr-analytics.service";
import { HrAttendanceAnalyticsService } from "./hr-attendance-analytics.service";
import { ExitService } from "./exit.service";

const ORG = "org-1";

/**
 * Three memberships: one accepted, one invited and never opened, one whose
 * account was deactivated. Only the first is active headcount.
 */
function orgRows(): TableRows {
  return {
    organization_members: [
      { id: 1, org_id: ORG, user_id: "u-accepted", role: "EMPLOYEE", status: "ACTIVE" },
      { id: 2, org_id: ORG, user_id: "u-pending", role: "EMPLOYEE", status: "ACTIVE" },
      { id: 3, org_id: ORG, user_id: "u-deactivated", role: "EMPLOYEE", status: "ACTIVE" },
    ],
    users: [
      {
        id: "u-accepted",
        is_active: true,
        email_verified: new Date("2026-01-02T00:00:00.000Z"),
        gender: "FEMALE",
        date_of_birth: null,
      },
      { id: "u-pending", is_active: true, email_verified: null, gender: "MALE", date_of_birth: null },
      {
        id: "u-deactivated",
        is_active: false,
        email_verified: new Date("2025-01-02T00:00:00.000Z"),
        gender: "MALE",
        date_of_birth: null,
      },
    ],
  };
}

function analyticsService(): HrAnalyticsService {
  const cache = new CacheService(new InMemoryRedis() as unknown as Redis);
  const db = makeFakeDb(orgRows()) as unknown as Db;
  return new HrAnalyticsService(db, cache, new HrAttendanceAnalyticsService(db, cache));
}

describe("HR analytics headcount excludes an invitation nobody accepted", () => {
  it("counts only the accepted member as active in the overview", async () => {
    const overview = await analyticsService().overview(ORG);

    expect(overview.headcount.total).toBe(3);
    expect(overview.headcount.active).toBe(1);
  });

  it("leaves the pending invitee out of the gender distribution", async () => {
    const overview = await analyticsService().overview(ORG);

    const distributed = overview.gender.reduce((sum, row) => sum + row.count, 0);
    expect(distributed).toBe(1);
  });

  it("leaves the pending invitee out of the role distribution", async () => {
    const overview = await analyticsService().overview(ORG);

    const distributed = overview.roles.reduce((sum, row) => sum + row.count, 0);
    expect(distributed).toBe(1);
  });

  it("leaves the pending invitee out of the department distribution", async () => {
    const overview = await analyticsService().overview(ORG);

    const distributed = overview.departments.reduce((sum, row) => sum + row.count, 0);
    expect(distributed).toBe(1);
  });

  it("divides attrition by the accepted headcount, not by the invitations sent", async () => {
    const cache = new CacheService(new InMemoryRedis() as unknown as Redis);
    const db = makeFakeDb(orgRows()) as unknown as Db;

    const attrition = await new HrAttendanceAnalyticsService(db, cache).attrition(ORG);

    expect(attrition.totalEmployees).toBe(1);
  });

  it("divides exit analytics by the accepted headcount", async () => {
    const db = makeFakeDb(orgRows()) as unknown as Db;

    const analytics = await new ExitService(db, undefined as never, undefined as never).getAnalytics(ORG);

    expect(analytics.totalEmployees).toBe(1);
  });
});
