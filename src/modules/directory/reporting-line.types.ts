import type { ReportingLineSource, ReportingManagerFallbackOrder, ReportingManagerRequestStatus } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

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
  relationshipType: "PRIMARY";
  source: ReportingLineSource;
  isFallback: boolean;
  fallbackConfirmedAt: string | null;
  /** Null unless the reader was granted `manage` or `review` in `permittedActions`. */
  changeReason: string | null;
}

export interface ManagerRef {
  userId: string;
  name: string;
  email: string | null;
  designation: string | null;
  state: ManagerState;
}

export interface RelationshipEntry {
  lineId: number;
  relationshipType: "PRIMARY" | "SECONDARY";
  label: string | null;
  manager: ManagerRef;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: ReportingLineSource;
  isFallback: boolean;
  fallbackConfirmedAt: string | null;
  recordedAt: string;
  changeReason: string | null;
}

export interface PermittedActions {
  manage: boolean;
  review: boolean;
  override: boolean;
}

export interface ReportingLineView {
  userId: string;
  current: ReportingLineHistoryEntry | null;
  upcoming: ReportingLineHistoryEntry[];
  history: ReportingLineHistoryEntry[];
  secondary: RelationshipEntry[];
  topLevel: { reason: string; effectiveFrom: string } | null;
  primaryChangesLast24h: number;
  changeThreshold: number;
  maxSecondaryManagers: number;
  pendingRequest: { requestId: string; status: ReportingManagerRequestStatus; createdAt: string } | null;
  permittedActions: PermittedActions;
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
    topLevel: number;
    fallback: number;
    pendingReview: number;
  };
  policyMissing: boolean;
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
  circular: Array<{ userIds: string[]; members: Array<{ userId: string; name: string | null }> }>;
  overSpan: Array<{ managerUserId: string | null; managerName: string | null; directReports: number }>;
  fallback: Array<{ userId: string | null; name: string | null; managerUserId: string | null; managerName: string | null; effectiveFrom: string }>;
  pendingReview: Array<{ requestId: string; userId: string | null; name: string | null; createdAt: string }>;
}

export const REPORTING_LINE_ERROR_CODES = {
  SELF_REFERENCE: "SELF_REFERENCE",
  MANAGER_NOT_ELIGIBLE: "MANAGER_NOT_ELIGIBLE",
  MANAGER_NOT_FOUND: "MANAGER_NOT_FOUND",
  PRIMARY_CYCLE: "PRIMARY_CYCLE",
  SECONDARY_DUPLICATES_PRIMARY: "SECONDARY_DUPLICATES_PRIMARY",
  SECONDARY_DUPLICATE: "SECONDARY_DUPLICATE",
  SECONDARY_CAP_EXCEEDED: "SECONDARY_CAP_EXCEEDED",
  TOP_LEVEL_WITH_MANAGER: "TOP_LEVEL_WITH_MANAGER",
  TOP_LEVEL_REASON_REQUIRED: "TOP_LEVEL_REASON_REQUIRED",
  TOP_LEVEL_NOT_ALLOWED: "TOP_LEVEL_NOT_ALLOWED",
  NO_DEFAULT_REPORTING_MANAGER: "NO_DEFAULT_REPORTING_MANAGER",
  CHANGE_REASON_REQUIRED: "CHANGE_REASON_REQUIRED",
  ELEVATED_AUTHORITY_REQUIRED: "ELEVATED_AUTHORITY_REQUIRED",
  INVALID_EFFECTIVE_DATE: "INVALID_EFFECTIVE_DATE",
  EMPLOYEE_NOT_FOUND: "EMPLOYEE_NOT_FOUND",
  REQUEST_INVALID_TRANSITION: "REQUEST_INVALID_TRANSITION",
  REQUEST_DUPLICATE_ACTIVE: "REQUEST_DUPLICATE_ACTIVE",
  MANAGER_COLUMN_CONFLICT: "MANAGER_COLUMN_CONFLICT",
  MANAGER_ROW_FAILED: "MANAGER_ROW_FAILED",
} as const;

export type ReportingLineErrorCode = (typeof REPORTING_LINE_ERROR_CODES)[keyof typeof REPORTING_LINE_ERROR_CODES];

/** D4: the reason a repeated or emergency primary change must carry, counted without whitespace. */
export const CHANGE_REASON_MIN_CHARS = 10;
export const PRIMARY_CHANGE_WINDOW_HOURS = 24;
export const TOP_LEVEL_REASON_MAX_CHARS = 500;
export const RELATIONSHIP_LABEL_MAX_CHARS = 60;
export const CHANGE_REASON_MAX_CHARS = 1000;
/** Future primary-line start dates a cycle check walks, beyond the effective date itself. */
export const CYCLE_CHECK_FUTURE_DATE_CAP = 50;

export const REPORTING_LINE_WARNINGS = {
  PRIMARY_CHANGE_THRESHOLD_EXCEEDED: "PRIMARY_CHANGE_THRESHOLD_EXCEEDED",
  EMERGENCY_OVERRIDE: "EMERGENCY_OVERRIDE",
  FALLBACK_ASSIGNED: "FALLBACK_ASSIGNED",
} as const;

export type ReportingLineWarning = (typeof REPORTING_LINE_WARNINGS)[keyof typeof REPORTING_LINE_WARNINGS];

export interface ReportingManagerPolicy {
  orgId: string;
  isConfigured: boolean;
  maxSecondaryManagersPerEmployee: number;
  defaultPrimaryManagerUserId: string | null;
  fallbackOrder: ReportingManagerFallbackOrder;
  requireReasonAfterChanges: number;
  allowTopLevelWithoutManager: boolean;
  version: number;
  updatedAt: string | null;
}

export interface ReportingManagerPolicyView extends ReportingManagerPolicy {
  defaultPrimaryManager: { userId: string; name: string; designation: string | null; eligible: boolean } | null;
}

export interface ReportingManagerPolicyPatch {
  maxSecondaryManagersPerEmployee?: number;
  defaultPrimaryManagerUserId?: string | null;
  fallbackOrder?: ReportingManagerFallbackOrder;
  requireReasonAfterChanges?: number;
  allowTopLevelWithoutManager?: boolean;
  expectedVersion: number;
}

/**
 * Who is changing a relationship. A request actor is the caller's `CurrentUserContext`; a
 * background path with no session (staged import commit, effective-dated change sweep) passes
 * `{ orgId, userId, isOrgOwner }` and is resolved from the database; `{ system }` names an
 * unattended path, which never holds elevated authority but is exempt from the D4 guard.
 */
export type ReportingActor =
  | CurrentUserContext
  | { orgId: string; userId: string; isOrgOwner: boolean }
  | { orgId: string; system: string };

export type RelationshipSubject = { subjectUserId: string } | { subjectEmploymentId: number };

export interface SecondaryManagerInput {
  managerUserId: string;
  label?: string | null;
}

export type SetRelationshipsCommand = RelationshipSubject & {
  orgId: string;
  actor: ReportingActor;
  primaryManagerUserId: string | null;
  topLevelReason?: string | null;
  /** Undefined leaves secondary lines unchanged; an array is the complete set from `effectiveFrom`. */
  secondary?: SecondaryManagerInput[];
  effectiveFrom: string;
  /** Inclusive last day of a bounded primary line; omitted means open-ended. */
  effectiveTo?: string | null;
  source: ReportingLineSource;
  reason?: string | null;
  emergency?: boolean;
  bulkJobId?: string | null;
  requestId?: string | null;
  skipFrequencyGuard?: boolean;
};

export interface RelationshipSnapshot {
  primary: { lineId: number; managerUserId: string | null; managerEmploymentId: number } | null;
  secondary: Array<{ lineId: number; managerUserId: string | null; managerEmploymentId: number; label: string | null }>;
  topLevel: { reason: string; effectiveFrom: string } | null;
}

export interface SetRelationshipsResult {
  subjectUserId: string | null;
  employmentId: number;
  before: RelationshipSnapshot;
  after: RelationshipSnapshot;
  changed: boolean;
  primaryChanged: boolean;
  warnings: ReportingLineWarning[];
}

export interface RelationshipValidation {
  ok: boolean;
  issues: Array<{ code: ReportingLineErrorCode; message: string }>;
  warnings: ReportingLineWarning[];
  employmentId: number | null;
  currentPrimaryManagerEmploymentId: number | null;
  primaryManagerEmploymentId: number | null;
  primaryChanged: boolean;
  primaryChangesLast24h: number;
  requiresReason: boolean;
}

export const REPORTING_LINE_PERMISSIONS = {
  MANAGE: "hr:reporting-lines:manage",
  REVIEW: "hr:reporting-lines:review",
  OVERRIDE: "hr:reporting-lines:override",
} as const;

export const REPORTING_LINE_EVENTS = {
  CHANGED: "hr.reporting_line.changed",
  EMERGENCY_OVERRIDE: "hr.reporting_line.emergency_override",
  FALLBACK_CONFIRMED: "hr.reporting_line.fallback_confirmed",
  POLICY_UPDATED: "hr.reporting_manager_policy.updated",
} as const;
