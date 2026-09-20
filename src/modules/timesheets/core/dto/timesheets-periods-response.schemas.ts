import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { timesheetPeriodSchema } from "./timesheets-approvals-response.schemas";

export const periodsListResponseSchema = z.array(timesheetPeriodSchema);

export const periodDetailResponseSchema = z.object({
  period: timesheetPeriodSchema,
  entries: z.array(z.object({
    id: z.number().int(),
    orgId: z.string(),
    userMembershipId: z.number().int().nullable(),
    ticketId: z.number().int().nullable(),
    projectId: z.number().int().nullable(),
    date: z.string(),
    hours: z.string(),
    description: z.string().nullable(),
    isBillable: z.boolean(),
    billingType: z.string(),
    status: z.string(),
    submittedAt: nullableWireDate(),
    approvedAt: nullableWireDate(),
    approvedByMembershipId: z.number().int().nullable(),
    rejectionReason: z.string().nullable(),
    voidedAt: nullableWireDate(),
    invoicingStatus: z.string(),
    billRate: z.string().nullable(),
    currency: z.string().nullable(),
    timesheetPeriodId: z.number().int().nullable(),
    createdAt: wireDate(),
    updatedAt: wireDate(),
    project: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  })),
});

/**
 * `GET /timesheets/periods/overdue`. Derived on read from `period_end + grace`,
 * so `graceDays` and `escalationThresholds` come back alongside the rows: an
 * organisation that configured no reminders reports every `escalationLevel` as
 * zero, and only the empty threshold list tells that apart from "not yet late
 * enough". `totalHours` is a numeric column, hence a string.
 */
export const overduePeriodSchema = z.object({
  periodId: z.number().int(),
  userMembershipId: z.number().int().nullable(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.string(),
  totalHours: z.string(),
  dueDate: z.string(),
  daysOverdue: z.number(),
  escalationLevel: z.number().int(),
});

export const overdueQueueResponseSchema = z.object({
  escalationThresholds: z.array(z.number().int()),
  graceDays: z.number().int(),
  asOf: z.string(),
  items: z.array(overduePeriodSchema),
  total: z.number().int(),
});
