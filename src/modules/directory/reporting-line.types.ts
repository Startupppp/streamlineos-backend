export const SPAN_OF_CONTROL_LIMIT = 12;
export const COVERAGE_LIST_CAP = 100;
export const REPORTING_LINE_HISTORY_CAP = 50;
export const MANAGER_CHAIN_DEPTH_CAP = 100;

export type ManagerAssignmentRefusal =
  | "self-reference"
  | "manager-not-in-organization"
  | "manager-inactive"
  /** Invited, never came through the magic link — cannot sign in to decide anything. */
  | "manager-never-accepted"
  | "manager-has-no-employment"
  | "manager-exited"
  | "circular";

export type ManagerAssignmentCheck =
  | { ok: true; managerEmploymentId: number }
  | { ok: false; reason: ManagerAssignmentRefusal; message: string };

export type ApproverEligibility =
  | { ok: true; managerEmploymentId: number | null }
  | { ok: false; reason: ManagerAssignmentRefusal; message: string };

export type ManagerState = "active" | "on-notice" | "inactive" | "exited";

export interface ReportingLineHistoryEntry {
  lineId: number;
  managerUserId: string | null;
  managerName: string | null;
  managerEmail: string | null;
  managerDesignation: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  recordedAt: string;
  recordedBy: string | null;
  managerState: ManagerState;
}

export interface ReportingLineView {
  userId: string;
  current: ReportingLineHistoryEntry | null;
  upcoming: ReportingLineHistoryEntry[];
  history: ReportingLineHistoryEntry[];
}

export interface ManagerCoverageReport {
  generatedAt: string;
  spanOfControlLimit: number;
  summary: {
    employees: number;
    withManager: number;
    withoutManager: number;
    inactiveManager: number;
    circular: number;
    overSpan: number;
  };
  withoutManager: Array<{
    userId: string | null;
    employmentId: number;
    employeeNumber: string;
    name: string | null;
    email: string | null;
    designation: string | null;
    departmentId: string | null;
    lifecycleStatus: string;
  }>;
  inactiveManager: Array<{
    userId: string | null;
    name: string | null;
    managerUserId: string | null;
    managerName: string | null;
    managerState: ManagerState;
    effectiveFrom: string;
  }>;
  circular: Array<{ userIds: string[] }>;
  overSpan: Array<{ managerUserId: string | null; managerName: string | null; directReports: number }>;
}
