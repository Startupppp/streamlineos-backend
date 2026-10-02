import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { DB_ENUMS } from "../../../../db/enums.generated";

const ticketRefSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  projectId: z.number().int().nullable(),
  project: z.object({
    id: z.number().int(),
    name: z.string(),
    key: z.string(),
  }).nullable(),
}).nullable();

export const timesheetRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  ticketId: z.number().int().nullable(),
  date: z.string(),
  hours: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  workLink: z.string().nullable(),
  status: z.enum(DB_ENUMS.timesheet_entry_status),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  isBillable: z.boolean(),
  payrollStatus: z.enum(DB_ENUMS.timesheet_payroll_status).nullable(),
  payrollExportId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  timesheetPeriodId: z.number().int().nullable(),
  timerSessionId: z.number().int().nullable(),
  billingType: z.enum(DB_ENUMS.timesheet_billing_type).nullable(),
  billRate: z.string().nullable(),
  costRate: z.string().nullable(),
  currency: z.string().nullable(),
  rateSource: z.enum(DB_ENUMS.timesheet_rate_source).nullable(),
  invoicingStatus: z.enum(DB_ENUMS.timesheet_invoicing_status).nullable(),
  submittedAt: nullableWireDate(),
  lockedAt: nullableWireDate(),
  lockedByMembershipId: z.number().int().nullable(),
  voidedAt: nullableWireDate(),
  voidReason: z.string().nullable(),
  source: z.enum(DB_ENUMS.timesheet_entry_source),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const timesheetEntrySchema = timesheetRowSchema.extend({ ticket: ticketRefSchema });

export const timesheetPageSchema = z.object({
  items: z.array(timesheetEntrySchema),
  total: z.number().int(),
  page: z.number().int().optional(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const billingSummaryItemSchema = z.object({
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  totalHours: z.number(),
});
