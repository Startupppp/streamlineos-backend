import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import type { AccessService } from "../../access/access.service";
import type { HrAnalyticsPlusService } from "../analytics-plus/hr-analytics-plus.service";
import type { ServiceDeliveryInboxService } from "../cases/service-delivery-inbox.service";
import type { HrHolidaysService } from "../config/hr-holidays.service";
import type { HrInterviewsService } from "../interviews/hr-interviews.service";
import type { HrRecruitmentReportsService } from "../interviews/hr-recruitment-reports.service";
import type { ExitService } from "../lifecycle/exit.service";
import type { HrDashboardService } from "../lifecycle/hr-dashboard.service";
import type { ProbationService } from "../lifecycle/probation.service";
import type { DocumentsService } from "../performance/documents.service";
import type { RecruitmentOffersService } from "../recruitment/recruitment-offers.service";
import type { RecruitmentRequisitionsService } from "../recruitment/recruitment-requisitions.service";
import type { AttendanceService } from "../time/attendance.service";
import type { LeavesService } from "../time/leaves.service";
import type { WfhService } from "../time/wfh.service";
import { HrHubService } from "./hr-hub.service";

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  permissions: [],
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
};

function methodMock() {
  return jest.fn().mockResolvedValue({ source: "test" });
}

function createHarness(permissionEntries: Array<[string, DataScope]> = []) {
  const permissions = new Map<string, DataScope>(permissionEntries);
  const access = {
    resolveUserPermissions: jest.fn().mockResolvedValue(permissions),
    isModuleEnabled: jest.fn().mockResolvedValue(true),
  };
  const analytics = { getCommandCenter: methodMock() };
  const dashboard = {
    metrics: methodMock(),
    onboardingStatus: methodMock(),
  };
  const leaves = { calendar: methodMock() };
  const wfh = { pending: methodMock() };
  const probation = { listDueForReview: methodMock() };
  const exit = { list: methodMock() };
  const documents = { stats: methodMock() };
  const holidays = { listByYear: methodMock() };
  const attendance = { teamStatus: methodMock() };
  const opsInbox = { getOpsInbox: methodMock() };
  const interviews = { list: methodMock() };
  const recruitmentReports = { stats: methodMock() };
  const offers = { listAllOffers: methodMock() };
  const requisitions = { list: methodMock() };

  const service = new HrHubService(
    access as unknown as AccessService,
    analytics as unknown as HrAnalyticsPlusService,
    dashboard as unknown as HrDashboardService,
    leaves as unknown as LeavesService,
    wfh as unknown as WfhService,
    probation as unknown as ProbationService,
    exit as unknown as ExitService,
    documents as unknown as DocumentsService,
    holidays as unknown as HrHolidaysService,
    attendance as unknown as AttendanceService,
    opsInbox as unknown as ServiceDeliveryInboxService,
    interviews as unknown as HrInterviewsService,
    recruitmentReports as unknown as HrRecruitmentReportsService,
    offers as unknown as RecruitmentOffersService,
    requisitions as unknown as RecruitmentRequisitionsService,
  );

  return {
    service,
    access,
    analytics,
    dashboard,
    leaves,
    wfh,
    probation,
    exit,
    documents,
    holidays,
    attendance,
    opsInbox,
    interviews,
    recruitmentReports,
    offers,
    requisitions,
  };
}

describe("HrHubService", () => {
  it("does not invoke any section service without its permission", async () => {
    const harness = createHarness();

    const result = await harness.service.getSnapshot(USER, "2026-08-18");

    expect(harness.access.resolveUserPermissions).toHaveBeenCalledTimes(1);
    expect(harness.access.isModuleEnabled).toHaveBeenCalledWith("org-1", "payroll");
    for (const section of Object.values(result.sections)) {
      expect(section).toBeNull();
    }
    expect(harness.analytics.getCommandCenter).not.toHaveBeenCalled();
    expect(harness.dashboard.metrics).not.toHaveBeenCalled();
    expect(harness.dashboard.onboardingStatus).not.toHaveBeenCalled();
    expect(harness.leaves.calendar).not.toHaveBeenCalled();
    expect(harness.wfh.pending).not.toHaveBeenCalled();
    expect(harness.probation.listDueForReview).not.toHaveBeenCalled();
    expect(harness.exit.list).not.toHaveBeenCalled();
    expect(harness.documents.stats).not.toHaveBeenCalled();
    expect(harness.holidays.listByYear).not.toHaveBeenCalled();
    expect(harness.attendance.teamStatus).not.toHaveBeenCalled();
    expect(harness.opsInbox.getOpsInbox).not.toHaveBeenCalled();
    expect(harness.interviews.list).not.toHaveBeenCalled();
    expect(harness.recruitmentReports.stats).not.toHaveBeenCalled();
    expect(harness.offers.listAllOffers).not.toHaveBeenCalled();
    expect(harness.requisitions.list).not.toHaveBeenCalled();
  });

  it("loads each permitted boundary once and keeps section failures generic", async () => {
    const harness = createHarness([
      ["hr:analytics:read", "all"],
      ["hr:documents:view", "own"],
      ["hr:interviews:view", "all"],
    ]);
    harness.dashboard.metrics.mockRejectedValue(
      new Error("database host and employee email must not escape"),
    );

    const result = await harness.service.getSnapshot(USER, "2026-08-18");

    expect(harness.access.resolveUserPermissions).toHaveBeenCalledTimes(1);
    expect(harness.analytics.getCommandCenter).toHaveBeenCalledTimes(1);
    expect(harness.dashboard.metrics).toHaveBeenCalledTimes(1);
    expect(harness.dashboard.onboardingStatus).toHaveBeenCalledTimes(1);
    expect(harness.documents.stats).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "own",
    );
    expect(harness.interviews.list).toHaveBeenCalledTimes(1);
    expect(harness.recruitmentReports.stats).toHaveBeenCalledTimes(1);
    expect(harness.leaves.calendar).not.toHaveBeenCalled();
    expect(harness.attendance.teamStatus).not.toHaveBeenCalled();
    expect(result.sections.dashboardMetrics).toEqual({
      status: "error",
      code: "HR_HUB_SECTION_UNAVAILABLE",
      message: "This section is temporarily unavailable.",
    });
    expect(JSON.stringify(result)).not.toContain("database host");
    expect(JSON.stringify(result)).not.toContain("employee email");
  });

  it("uses the original date, tenant and record-scope arguments", async () => {
    const harness = createHarness([
      ["hr:leaves:read", "all"],
      ["hr:attendance:view", "all"],
      ["hr:attendance:manage", "all"],
      ["hr:exit:view", "all"],
      ["hr:exit:manage", "all"],
      ["hr:cases:view", "all"],
    ]);

    await harness.service.getSnapshot(USER, "2026-08-18");

    expect(harness.leaves.calendar).toHaveBeenCalledWith("org-1", 8, 2026);
    expect(harness.holidays.listByYear).toHaveBeenCalledWith("org-1", 2026);
    expect(harness.attendance.teamStatus).toHaveBeenCalledWith(USER, {
      page: 1,
      limit: 1,
    });
    expect(harness.exit.list).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      true,
      { page: 1, limit: 5 },
    );
    expect(harness.opsInbox.getOpsInbox).toHaveBeenCalledWith(
      "org-1",
      "user-1",
    );
  });
});
