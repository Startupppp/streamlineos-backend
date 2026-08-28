export const BACKFILL_CHECKPOINT_ACTION = "employment_backfill.checkpoint";
export const BACKFILL_UNMAPPABLE_ACTION = "employment_backfill.unmappable";

export type BackfillUnmappableField =
  | "orgDepartmentId"
  | "branchId"
  | "employeeId"
  | "reportingTo"
  | "monthlySalary"
  | "bankDetails";

export type BackfillUnmappable = {
  userId: string;
  field: BackfillUnmappableField;
  value: string;
  reason: string;
};

export type LegacyEmploymentRow = {
  membershipId: number;
  userId: string;
  employeeId: string | null;
  designation: string | null;
  joiningDate: string | null;
  orgDepartmentId: string | null;
  branchId: string | null;
  reportingTo: string | null;
  monthlySalary: string | null;
  bankDetails: string | null;
  taxId: string | null;
};

export type EmploymentBackfillResult = {
  scanned: number;
  createdPeople: number;
  createdEmployments: number;
  fieldsCopied: number;
  reportingLinesWritten: number;
  sensitiveRecordsWritten: number;
  skipped: number;
  unmappable: BackfillUnmappable[];
  errors: Array<{ userId: string; message: string }>;
};

export function emptyBackfillResult(): EmploymentBackfillResult {
  return {
    scanned: 0,
    createdPeople: 0,
    createdEmployments: 0,
    fieldsCopied: 0,
    reportingLinesWritten: 0,
    sensitiveRecordsWritten: 0,
    skipped: 0,
    unmappable: [],
    errors: [],
  };
}
