import type { BulkOnboardEmployeeRow } from "../dto/hr-directory.schemas";

export interface BulkOnboardRowResult {
  row: number;
  email: string;
  success: boolean;
  userId?: string;
  error?: string;
}

/** A row that passed every in-memory check and is written by the batch transaction. */
export interface PlannedEmployee {
  row: number;
  email: string;
  source: BulkOnboardEmployeeRow;
  userId: string;
  isNewUser: boolean;
  role: string;
  departmentId: string | null;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  designation: string;
  joiningDate: string | null;
  dateOfBirth: string | null;
}

export interface BulkOnboardPlan {
  accepted: PlannedEmployee[];
  rejected: BulkOnboardRowResult[];
}

export interface BulkOnboardWriteOutcome {
  createdUserIds: string[];
  welcomeEmails: Array<{ email: string; name: string; signInUrl: string }>;
}
