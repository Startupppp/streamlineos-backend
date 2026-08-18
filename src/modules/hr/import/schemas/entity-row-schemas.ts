import { z } from "zod";
import { ATTENDANCE_RECORD_STATUSES } from "../../../../db/schema/hr/attendance-status";
import type { HrImportEntity } from "../dto/import-job.dto";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const isoDateOrBlank = z
  .string()
  .refine((v) => !v || dateRegex.test(v), { message: "Invalid date format (YYYY-MM-DD)" });

const emailSchema = z.string().email({ message: "Invalid email address" });

export const employeeRowSchema = z.object({
  email: emailSchema,
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  joiningDate: isoDateOrBlank,
  departmentName: z.string().optional(),
  departmentId: z.union([z.string(), z.number()]).optional(),
  designation: z.string().optional(),
  employeeNumber: z.string().optional(),
  workerType: z.string().optional(),
  phone: z.string().optional(),
  gender: z.string().optional(),
  managerEmail: z.string().email().optional().or(z.literal("")),
});

export const leaveBalanceRowSchema = z.object({
  employeeEmail: emailSchema,
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

export const attendanceRowSchema = z
  .object({
    employeeEmail: emailSchema,
    date: z.string().refine((v) => dateRegex.test(v), { message: "Invalid date (YYYY-MM-DD)" }),
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
    status: z.enum(ATTENDANCE_RECORD_STATUSES).optional(),
  })
  .refine(
    (data) => {
      const d = new Date(data.date);
      return d <= new Date();
    },
    { message: "Attendance date cannot be in the future" },
  );

export const assetRowSchema = z.object({
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
  type: z.string().min(1, "Document type is required"),
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

const ENTITY_SCHEMAS: Record<HrImportEntity, RowSchema> = {
  employees: employeeRowSchema,
  leave_balances: leaveBalanceRowSchema,
  attendance: attendanceRowSchema,
  assets: assetRowSchema,
  document_metadata: documentMetadataRowSchema,
};

export interface RowValidationResult {
  rowNumber: number;
  payload: Record<string, unknown>;
  status: "valid" | "error";
  error: string | null;
}

export function validateRows(
  entity: HrImportEntity,
  rows: Array<Record<string, unknown>>,
): {
  validRows: RowValidationResult[];
  errorRows: RowValidationResult[];
  topErrors: Array<{ row: number; message: string }>;
} {
  const schema = ENTITY_SCHEMAS[entity];
  const validRows: RowValidationResult[] = [];
  const errorRows: RowValidationResult[] = [];
  const topErrors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1;
    const raw = rows[i] ?? {};
    const result = schema.safeParse(raw);

    if (result.success) {
      validRows.push({ rowNumber, payload: raw, status: "valid", error: null });
    } else {
      const message = result.error.issues.map((issue) => issue.message).join("; ");
      errorRows.push({ rowNumber, payload: raw, status: "error", error: message });
      if (topErrors.length < 100) {
        topErrors.push({ row: rowNumber, message });
      }
    }
  }

  return { validRows, errorRows, topErrors };
}
