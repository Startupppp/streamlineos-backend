import { Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { HrAnalyticsPlusService } from "../analytics-plus/hr-analytics-plus.service";
import { ServiceDeliveryInboxService } from "../cases/service-delivery-inbox.service";
import { HrHolidaysService } from "../config/hr-holidays.service";
import type { InterviewListInput } from "../interviews/dto/hr-interviews.schemas";
import { HrInterviewsService } from "../interviews/hr-interviews.service";
import { HrRecruitmentReportsService } from "../interviews/hr-recruitment-reports.service";
import { ExitService } from "../lifecycle/exit.service";
import { resolveExitAdmin } from "../lifecycle/exit-scope";
import { HrDashboardService } from "../lifecycle/hr-dashboard.service";
import { ProbationService } from "../lifecycle/probation.service";
import { DocumentsService } from "../performance/documents.service";
import { resolveDocumentsScope } from "../performance/performance-scope";
import { RecruitmentOffersService } from "../recruitment/recruitment-offers.service";
import { RecruitmentRequisitionsService } from "../recruitment/recruitment-requisitions.service";
import { AttendanceService } from "../time/attendance.service";
import { LeavesService } from "../time/leaves.service";
import { WfhService } from "../time/wfh.service";
import { buildHrHubCapabilities } from "./hr-hub-capabilities";
import type { HrHubSection, HrHubSnapshot } from "./hr-hub.types";

const SECTION_ERROR = {
  status: "error",
  code: "HR_HUB_SECTION_UNAVAILABLE",
  message: "This section is temporarily unavailable.",
} as const;

const INTERVIEW_QUERY: InterviewListInput = {
  candidateId: undefined,
  upcoming: undefined,
  relevant: "true",
  page: 1,
  pageSize: 50,
  limit: 50,
  offset: 0,
};

@Injectable()
export class HrHubService {
  constructor(
    private readonly access: AccessService,
    private readonly analytics: HrAnalyticsPlusService,
    private readonly dashboard: HrDashboardService,
    private readonly leaves: LeavesService,
    private readonly wfh: WfhService,
    private readonly probation: ProbationService,
    private readonly exit: ExitService,
    private readonly documents: DocumentsService,
    private readonly holidays: HrHolidaysService,
    private readonly attendance: AttendanceService,
    private readonly opsInbox: ServiceDeliveryInboxService,
    private readonly interviews: HrInterviewsService,
    private readonly recruitmentReports: HrRecruitmentReportsService,
    private readonly offers: RecruitmentOffersService,
    private readonly requisitions: RecruitmentRequisitionsService,
  ) {}

  async getSnapshot(user: CurrentUserContext, today: string): Promise<HrHubSnapshot> {
    const [permissions, payrollEnabled] = await Promise.all([
      this.access.resolveUserPermissions(user.orgId, user.userId),
      this.access.isModuleEnabled(user.orgId, "payroll"),
    ]);
    const capabilities = buildHrHubCapabilities(
      user,
      permissions,
      payrollEnabled,
    );
    const [year, month] = today.split("-").map(Number) as [number, number, number];
    const isExitAdmin = await resolveExitAdmin(this.access, user, permissions);

    const [
      commandCenter,
      dashboardMetrics,
      onboardingStatus,
      leaveCalendar,
      pendingWfh,
      probation,
      resignations,
      documentStats,
      holidays,
      attendanceStatus,
      opsInbox,
      interviews,
      recruitmentStats,
      pendingOffers,
      pendingRequisitions,
    ] = await Promise.all([
      this.capture(capabilities.canAnalytics, () =>
        this.analytics.getCommandCenter(user.orgId),
      ),
      this.capture(capabilities.canAnalytics, () =>
        this.dashboard.metrics(user.orgId),
      ),
      this.capture(capabilities.canAnalytics, () =>
        this.dashboard.onboardingStatus(user.orgId),
      ),
      this.capture(capabilities.canLeaveCalendar, () =>
        this.leaves.calendar(user.orgId, month, year),
      ),
      this.capture(capabilities.canAttendanceManage, () =>
        this.wfh.pending(user.orgId),
      ),
      this.capture(capabilities.canProbation, () =>
        this.probation.listDueForReview(user.orgId, { limit: 20 }),
      ),
      this.capture(capabilities.canExit, () =>
        this.exit.list(user.orgId, user.userId, isExitAdmin, {
          page: 1,
          limit: 5,
        }),
      ),
      this.capture(capabilities.canDocuments, async () => {
        const scope = await resolveDocumentsScope(this.access, user, permissions);
        return this.documents.stats(user.orgId, user.userId, scope);
      }),
      this.capture(capabilities.canAttendanceView, () =>
        this.holidays.listByYear(user.orgId, year),
      ),
      this.capture(capabilities.canAttendanceView, () =>
        this.attendance.teamStatus(user, { page: 1, limit: 1 }),
      ),
      this.capture(capabilities.canCases, () =>
        this.opsInbox.getOpsInbox(user.orgId, user.userId),
      ),
      this.capture(capabilities.canInterviews, () =>
        this.interviews.list(user.orgId, INTERVIEW_QUERY),
      ),
      this.capture(capabilities.canInterviews, () =>
        this.recruitmentReports.stats(user.orgId),
      ),
      this.capture(capabilities.canOffers, () =>
        this.offers.listAllOffers(user.orgId, {
          status: "PENDING_APPROVAL",
          page: 1,
          pageSize: 1,
        }),
      ),
      this.capture(capabilities.canRequisitions, () =>
        this.requisitions.list(user.orgId, "PENDING_APPROVAL"),
      ),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      today,
      capabilities,
      sections: {
        commandCenter,
        dashboardMetrics,
        onboardingStatus,
        leaveCalendar,
        pendingWfh,
        probation,
        resignations,
        documentStats,
        holidays,
        attendanceStatus,
        opsInbox,
        interviews,
        recruitmentStats,
        pendingOffers,
        pendingRequisitions,
      },
    };
  }

  private async capture<T>(
    allowed: boolean,
    load: () => Promise<T>,
  ): Promise<HrHubSection<T> | null> {
    if (!allowed) return null;
    try {
      return { status: "ok", data: await load() };
    } catch {
      return SECTION_ERROR;
    }
  }
}
