import type { AdmissionClearance } from "../../../organization/core/membership-admission.service";
import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";

export interface BulkOnboardRowResult {
  row: number;
  email: string;
  success: boolean;
  userId?: string;
  error?: string;
}

export interface PlannedEmployee {
  row: number;
  email: string;
  source: BulkOnboardEmployeeRow;
  clearance: AdmissionClearance;
  role: string;
  departmentId: string | null;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  designation: string;
  joiningDate: string | null;
  dateOfBirth: string | null;
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
