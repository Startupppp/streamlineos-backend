/**
 * HRMS-E2E-015 — a manager's scorecard must not count a direct report who was
 * invited and never accepted.
 *
 * `teamSize` and `teamAttendanceRate` come out of the same row set. A person
 * who has never followed their magic link cannot clock in, so counting them
 * inflates the team and then divides its attendance by a denominator that can
 * never be met — the rate falls without anyone having missed a day.
 */

import type { Db } from "../../../db/drizzle.module";
import { organizationMembers } from "../../../db/schema";
import type { EmploymentFactsService } from "../../directory/employment-facts.service";
import { makeFakeDb, type TableRows } from "../../../test/fake-select-db";
import { EmployeeAnalyticsService } from "./employee-analytics.service";

const ORG = "org-1";
const MANAGER = "u-manager";

function orgRows(): TableRows {
  return {
    organization_members: [
      { id: 1, org_id: ORG, user_id: MANAGER, role: "MANAGER", status: "ACTIVE" },
      { id: 2, org_id: ORG, user_id: "u-accepted", role: "EMPLOYEE", status: "ACTIVE" },
      { id: 3, org_id: ORG, user_id: "u-pending", role: "EMPLOYEE", status: "ACTIVE" },
    ],
    users: [
      { id: MANAGER, is_active: true, email_verified: new Date("2025-06-01T00:00:00.000Z"), name: "Manager" },
      {
        id: "u-accepted",
        is_active: true,
        email_verified: new Date("2026-01-02T00:00:00.000Z"),
        name: "Accepted",
      },
      { id: "u-pending", is_active: true, email_verified: null, name: "Pending" },
    ],
  };
}

function employmentDouble(): EmploymentFactsService {
  const double = {
    getDirectReportUserIds: () => Promise.resolve(["u-accepted", "u-pending"]),
    getFactsBatch: () => Promise.resolve(new Map()),
  };
  return double as unknown as EmploymentFactsService;
}

describe("manager scorecard excludes a direct report who never accepted", () => {
  it("sizes the team by accepted reports only", async () => {
    const service = new EmployeeAnalyticsService(
      makeFakeDb(orgRows(), { organizationMembers }) as unknown as Db,
      employmentDouble(),
    );

    const scorecard = await service.getManagerScorecard(ORG, MANAGER);

    expect(scorecard.teamSize).toBe(1);
    expect(scorecard.directReports.map((report) => report.id)).toEqual(["u-accepted"]);
  });
});
