import type { AdmissionClearance } from "../../../organization/core/membership-admission.service";
import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";

export interface BulkOnboardRowResult {
  row: number;
  email: string;
  success: boolean;
  userId?: string;
  error?: string;
  /** HRM-15: the contract error code behind `error`, when there is one. */
  code?: string;
  /** Not created because the manager it names (another row) was not. */
  skipped?: boolean;
  dependsOnRow?: number | null;
}

/** HRM-15: who a planned row reports to, as the fallback resolver decided it. */
export interface PlannedPrimaryManager {
  userId: string | null;
  name: string | null;
  email: string | null;
  resolution: "SELECTED" | "IN_FILE" | "FALLBACK_CONFIGURED" | "FALLBACK_UPLOADER";
  dependsOnRow: number | null;
}

export interface PlannedSecondaryManager {
  email: string;
  /** Null when the manager is another row of this file, resolved after admission. */
  userId: string | null;
  name: string | null;
}

export interface PlannedEmployee {
  row: number;
  email: string;
  source: BulkOnboardEmployeeRow;
  clearance: AdmissionClearance;
  role: string;
  departmentId: string | null;
  /** BUG-HRMS-006. Resolved from the row's `locationId` or `location` name. */
  locationId: string | null;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  designation: string;
  joiningDate: string | null;
  dateOfBirth: string | null;
  reportingManagerUserId: string | null;
  /**
   * Set when the manager is another row of the same file. It cannot be a user id
   * at plan time because that person does not exist yet; the write phase
   * resolves it once everyone has been admitted.
   */
  reportingManagerEmail: string | null;
  /** Null for a top-level row. */
  primaryManager: PlannedPrimaryManager | null;
  secondaryManagers: PlannedSecondaryManager[];
  effectiveFrom: string | null;
}

export interface AdmittedEmployee extends PlannedEmployee {
  userId: string;
  membershipId: number | null;
  createdUser: boolean;
}

export interface BulkOnboardPlan {
  accepted: PlannedEmployee[];
  rejected: BulkOnboardRowResult[];
}

export interface BulkOnboardWriteOutcome {
  admitted: AdmittedEmployee[];
  rejected: BulkOnboardRowResult[];
  welcomeEmails: Array<{ email: string; name: string; signInUrl: string }>;
}
