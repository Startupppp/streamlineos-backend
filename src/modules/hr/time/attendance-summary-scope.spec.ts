import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AttendanceSummaryController } from "./attendance-summary.controller";

describe("AttendanceSummaryController scope boundary", () => {
  it("passes the authenticated context to the scoped summary entry point", async () => {
    const summary = {
      buildScopedAttendanceSummary: jest.fn().mockResolvedValue({ data: [] }),
    };
    const controller = new AttendanceSummaryController(summary as never);
    const user = {
      userId: "actor-1",
      orgId: "org-1",
      role: "EMPLOYEE",
      permissions: ["hr:attendance:view"],
      isOrgOwner: false,
      sessionId: "session-1",
      tokenScopes: null,
    } satisfies CurrentUserContext;
    const query = {
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      employeeId: "target-1",
      page: 1,
      limit: 50,
    };

    await controller.getSummary(query, user);

    expect(summary.buildScopedAttendanceSummary).toHaveBeenCalledWith(user, query);
  });
});
