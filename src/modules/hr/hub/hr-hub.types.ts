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
import type { HrHubCapabilities } from "./hr-hub-capabilities";

export interface HrHubSectionError {
  status: "error";
  code: "HR_HUB_SECTION_UNAVAILABLE";
  message: "This section is temporarily unavailable.";
}

export type HrHubSection<T> =
  | { status: "ok"; data: T }
  | HrHubSectionError;

type Output<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>;

export interface HrHubSections {
  commandCenter: HrHubSection<Output<HrAnalyticsPlusService["getCommandCenter"]>> | null;
  dashboardMetrics: HrHubSection<Output<HrDashboardService["metrics"]>> | null;
  onboardingStatus: HrHubSection<Output<HrDashboardService["onboardingStatus"]>> | null;
  leaveCalendar: HrHubSection<Output<LeavesService["calendar"]>> | null;
  pendingWfh: HrHubSection<Output<WfhService["pending"]>> | null;
  probation: HrHubSection<Output<ProbationService["listDueForReview"]>> | null;
  resignations: HrHubSection<Output<ExitService["hubDigest"]>> | null;
  documentStats: HrHubSection<Output<DocumentsService["stats"]>> | null;
  holidays: HrHubSection<Output<HrHolidaysService["listByYear"]>> | null;
  attendanceStatus: HrHubSection<Output<AttendanceService["teamStatus"]>> | null;
  opsInbox: HrHubSection<Output<ServiceDeliveryInboxService["getOpsInbox"]>> | null;
  interviews: HrHubSection<Output<HrInterviewsService["list"]>> | null;
  recruitmentStats: HrHubSection<Output<HrRecruitmentReportsService["stats"]>> | null;
  pendingOffers: HrHubSection<Output<RecruitmentOffersService["listAllOffers"]>> | null;
  pendingRequisitions: HrHubSection<Output<RecruitmentRequisitionsService["list"]>> | null;
}

export interface HrHubSnapshot {
  generatedAt: string;
  today: string;
  capabilities: HrHubCapabilities;
  sections: HrHubSections;
}
