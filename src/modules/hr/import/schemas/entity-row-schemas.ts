import { z } from "zod";
import { ATTENDANCE_RECORD_STATUSES } from "../../../../db/schema/hr/attendance-status";
import { documentTypeEnum, genderEnum } from "../../../../db/schema/common/enums";
import { fromWallClockUtc } from "../../../../common/date/zoned-wall-clock";
import type { HrImportEntity } from "../dto/import-job.dto";
import { findInFileDuplicates } from "./import-row-identity";
import { employeeManagerRowFields, refineEmployeeManagerColumns } from "./employee-manager-row-fields";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Imports are dated in the organisation's calendar, not the server's. Comparing
 * `new Date(row.date)` against `new Date()` read the host clock, so the same file
 * was accepted or rejected depending on where the process happened to run.
 * Formatting "now" in the target zone and comparing the two YYYY-MM-DD strings
 * gives the same answer on every host.
 */
export const DEFAULT_IMPORT_TIME_ZONE = "Asia/Kolkata";

export function todayInTimeZone(timeZone: string = DEFAULT_IMPORT_TIME_ZONE, now: Date = new Date()): string {
  // en-CA renders ISO order (2026-09-24), which is what the CSV carries.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const timeOfDayRegex = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

/** Minutes past midnight, or null when the cell is blank or not a wall-clock time. */
function minutesOfDay(value: string | undefined): number | null {
  if (!value) return null;
  const match = timeOfDayRegex.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * The instant an attendance cell names, or null when the cell is blank.
 *
 * Two shapes reach this column and both have to work. The import dialog
 * documents `checkIn` as `09:30` — a wall clock on the row's own date — and the
 * commit used to hand that straight to `new Date("09:30")`, which is an Invalid
 * Date; the insert then failed and the row was counted as an error nobody could
 * explain from the file. The other shape is a full ISO instant, which is what
 * an export round-trip produces.
 *
 * A wall clock is read in the organisation's zone, so `09:30` on a day in India
 * is 04:00Z and not whatever the server's own offset would have made of it.
 */
export function attendanceInstant(
  date: string,
  value: string | undefined,
  timeZone: string = DEFAULT_IMPORT_TIME_ZONE,
): Date | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();

  const minutes = minutesOfDay(trimmed);
  if (minutes !== null) {
    const wall = new Date(`${date}T${trimmed.length === 5 ? `${trimmed}:00` : trimmed}Z`);
    if (Number.isNaN(wall.getTime())) return null;
    return fromWallClockUtc(wall, timeZone);
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** True when the cell is a wall clock or a parseable instant. */
function isAttendanceTime(value: string | undefined): boolean {
  if (!value?.trim()) return true;
  return attendanceInstant("2000-01-01", value) !== null;
}

const isoDateOrBlank = z
  .string()
  .refine((v) => !v || dateRegex.test(v), { message: "Invalid date format (YYYY-MM-DD)" });

const emailSchema = z.string().email({ message: "Invalid email address" });

/**
 * Ids the preflight pass resolved and wrote onto the stored payload
 * (`hr-import-preflight.ts`). They are org-scoped query results, never CSV
 * cells — `stripResolvedKeys` removes them from every raw row before validation
 * so a file cannot name a column `resolvedUserId` and hand the commit a user id
 * from another tenant.
 */
const resolvedUserId = z.string().optional();

export const employeeRowSchema = z.object({
  email: emailSchema,
  resolvedDepartmentId: z.string().optional(),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  joiningDate: isoDateOrBlank,
  departmentName: z.string().optional(),
  departmentId: z.union([z.string(), z.number()]).optional(),
  designation: z.string().optional(),
  employeeNumber: z.string().optional(),
  workerType: z.string().optional(),
  phone: z.string().optional(),
  // `gender` is an enum on both `users` and `organization_people`. It was typed
  // as free text here, so a row saying "male" parsed as valid and then failed at
  // insert time with a Postgres enum error the operator could not act on.
  gender: z
    .enum(genderEnum.enumValues, {
      message: `Gender must be one of: ${genderEnum.enumValues.join(", ")}`,
    })
    .optional()
    .or(z.literal("").transform(() => undefined)),
  ...employeeManagerRowFields,
  effectiveFrom: isoDateOrBlank.optional(),
}).superRefine(refineEmployeeManagerColumns);

export const leaveBalanceRowSchema = z.object({
  employeeEmail: emailSchema,
  resolvedUserId,
  resolvedLeaveTypeId: z.number().int().optional(),
  leaveTypeName: z.string().min(1, "Leave type name is required"),
  balance: z
    .union([z.string(), z.number()])
    .refine(
      (v) => {
        const n = typeof v === "string" ? parseFloat(v) : v;
        return !isNaN(n) && n >= 0;
      },
      { message: "Balance must be a non-negative number" },
    ),
  year: z
    .union([z.string(), z.number()])
    .refine(
      (v) => {
        const n = typeof v === "string" ? parseInt(v) : v;
        return !isNaN(n) && n >= 2000 && n <= 2100;
      },
      { message: "Invalid year" },
    ),
});

/**
 * "Not in the future" is a question about the organisation's calendar, so the
 * zone is a parameter (V-012b). It used to be the module's hardcoded
 * Asia/Kolkata, which rejected today's rows for an org in Los Angeles and
 * accepted tomorrow's for one in Auckland.
 */
export const attendanceRowSchemaFor = (timeZone: string = DEFAULT_IMPORT_TIME_ZONE) => z
  .object({
    employeeEmail: emailSchema,
    resolvedUserId,
    date: z.string().refine((v) => dateRegex.test(v), { message: "Invalid date (YYYY-MM-DD)" }),
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
    status: z.enum(ATTENDANCE_RECORD_STATUSES).optional(),
  })
  .refine((data) => data.date <= todayInTimeZone(timeZone), {
    message: "Attendance date cannot be in the future",
    path: ["date"],
  })
  .refine((data) => isAttendanceTime(data.checkIn), {
    message: "Check-in must be a 24-hour time (HH:MM) or a full timestamp",
    path: ["checkIn"],
  })
  .refine((data) => isAttendanceTime(data.checkOut), {
    message: "Check-out must be a 24-hour time (HH:MM) or a full timestamp",
    path: ["checkOut"],
  })
  .refine(
    (data) => {
      // A row carrying both times must run forwards. QA's `19:00 -> 09:00` row
      // was previewed as valid, and the commit then stored a negative working
      // day that every hours-worked and payable-days read counts.
      const start = attendanceInstant(data.date, data.checkIn);
      const end = attendanceInstant(data.date, data.checkOut);
      if (start === null || end === null) return true;
      return end.getTime() > start.getTime();
    },
    { message: "Check-out must be later than check-in", path: ["checkOut"] },
  );

export const attendanceRowSchema = attendanceRowSchemaFor();

export const assetRowSchema = z.object({
  resolvedUserId,
  name: z.string().min(1, "Asset name is required"),
  type: z.string().min(1, "Asset type is required"),
  brand: z.string().optional(),
  model: z.string().optional(),
  serialNumber: z.string().optional(),
  assignedToEmail: z.string().email().optional().or(z.literal("")),
  status: z.enum(["AVAILABLE", "ASSIGNED", "MAINTENANCE", "RETIRED"]).optional(),
  purchaseDate: isoDateOrBlank.optional(),
  location: z.string().optional(),
});

export const documentMetadataRowSchema = z.object({
  employeeEmail: emailSchema,
  name: z.string().min(1, "Document name is required"),
  // The column used to be `z.string()`, parsed and then discarded: every imported
  // document was stored as OTHER whatever the file said. Validating against the
  // `document_type` enum is what lets the commit keep the value — and tells the
  // operator which words the column accepts instead of silently flattening them.
  type: z.enum(documentTypeEnum.enumValues, {
    message: `Document type must be one of: ${documentTypeEnum.enumValues.join(", ")}`,
  }),
  fileUrl: z.string().url({ message: "Invalid file URL" }),
  category: z.string().optional(),
  expiryDate: isoDateOrBlank.optional(),
});

export type EmployeeRow = z.infer<typeof employeeRowSchema>;
export type LeaveBalanceRow = z.infer<typeof leaveBalanceRowSchema>;
export type AttendanceRow = z.infer<typeof attendanceRowSchema>;
export type AssetRow = z.infer<typeof assetRowSchema>;
export type DocumentMetadataRow = z.infer<typeof documentMetadataRowSchema>;

type RowSchema =
  | typeof employeeRowSchema
  | typeof leaveBalanceRowSchema
  | typeof attendanceRowSchema
  | typeof assetRowSchema
  | typeof documentMetadataRowSchema;

function schemaFor(entity: HrImportEntity, timeZone: string): RowSchema {
  if (entity === "employees") return employeeRowSchema;
  if (entity === "leave_balances") return leaveBalanceRowSchema;
  if (entity === "attendance") return attendanceRowSchemaFor(timeZone);
  if (entity === "assets") return assetRowSchema;
  return documentMetadataRowSchema;
}

export interface RowValidationResult {
  rowNumber: number;
  payload: Record<string, unknown>;
  status: "valid" | "error";
  error: string | null;
}

export function validateRows(
  entity: HrImportEntity,
  rows: Array<Record<string, unknown>>,
  timeZone: string = DEFAULT_IMPORT_TIME_ZONE,
): {
  validRows: RowValidationResult[];
  errorRows: RowValidationResult[];
  topErrors: Array<{ row: number; message: string }>;
} {
  const schema = schemaFor(entity, timeZone);
  const schemaValid: RowValidationResult[] = [];
  const errorRows: RowValidationResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1;
    const raw = rows[i] ?? {};
    const result = schema.safeParse(raw);

    if (result.success) {
      schemaValid.push({ rowNumber, payload: raw, status: "valid", error: null });
    } else {
      const message = result.error.issues.map((issue) => issue.message).join("; ");
      errorRows.push({ rowNumber, payload: raw, status: "error", error: message });
    }
  }

  // A row can only collide with one that is itself well-formed, so this pass runs
  // over the schema-valid rows. The *later* row fails, which keeps a re-uploaded
  // file's first occurrence importable.
  const duplicates = findInFileDuplicates(entity, schemaValid);
  const validRows: RowValidationResult[] = [];
  for (const row of schemaValid) {
    const duplicate = duplicates.get(row.rowNumber);
    if (duplicate === undefined) {
      validRows.push(row);
      continue;
    }
    errorRows.push({ ...row, status: "error", error: duplicate });
  }

  errorRows.sort((a, b) => a.rowNumber - b.rowNumber);
  const topErrors = errorRows
    .slice(0, 100)
    .map((row) => ({ row: row.rowNumber, message: row.error ?? "Invalid row" }));

  return { validRows, errorRows, topErrors };
}
