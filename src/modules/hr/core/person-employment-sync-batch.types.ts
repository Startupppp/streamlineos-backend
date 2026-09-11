import type { HrAuditEntry } from "./hr-audit.service";
import type { EnsurePersonEmploymentInput } from "./person-employment-sync.types";

export type EnsureManyInput = EnsurePersonEmploymentInput & {
  departmentId?: string | null;
};

export interface EnsureManyRow {
  userId: string;
  personId: number;
  employmentId: number;
  employeeNumber: string;
  createdPerson: boolean;
  createdEmployment: boolean;
}

export interface EnsureManyOutcome {
  rows: EnsureManyRow[];
  auditEntries: HrAuditEntry[];
}
