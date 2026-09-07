import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

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

export const timesheetEntrySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int(),
  ticketId: z.number().int().nullable(),
  date: z.string(),
  hours: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  workLink: z.string().nullable(),
  status: z.string(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  isBillable: z.boolean(),
  payrollStatus: z.string().nullable(),
  payrollExportId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  timesheetPeriodId: z.number().int().nullable(),
  timerSessionId: z.number().int().nullable(),
  billingType: z.string().nullable(),
  billRate: z.string().nullable(),
  costRate: z.string().nullable(),
  currency: z.string().nullable(),
  rateSource: z.string().nullable(),
  invoicingStatus: z.string().nullable(),
  submittedAt: nullableWireDate(),
  lockedAt: nullableWireDate(),
  lockedByMembershipId: z.number().int().nullable(),
  voidedAt: nullableWireDate(),
  voidReason: z.string().nullable(),
  source: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  ticket: ticketRefSchema,
});

export const timesheetPageSchema = z.object({
  items: z.array(timesheetEntrySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export const billingSummaryItemSchema = z.object({
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  totalHours: z.number(),
});

export { successSchema };
