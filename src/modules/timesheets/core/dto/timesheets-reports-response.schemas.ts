import { z } from "zod";

export const reportsOverviewResponseSchema = z.object({
  totalHours: z.number(),
  billableHours: z.number(),
  nonBillableHours: z.number(),
  billableRatio: z.number(),
  approvedHours: z.number(),
  pendingApprovalHours: z.number(),
  pendingPeriods: z.number().int(),
  activeUsers: z.number().int(),
  byDay: z.array(z.object({ date: z.string(), hours: z.number() })),
  byProject: z.array(z.object({
    projectId: z.number().int(),
    projectName: z.string(),
    hours: z.number(),
  })),
});

export const utilizationUserSchema = z.object({
  userId: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  totalHours: z.number(),
  billableHours: z.number(),
  nonBillableHours: z.number(),
  billableUtilization: z.number(),
});

export const reportsUtilizationResponseSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  summary: z.object({
    totalHours: z.number(),
    billableHours: z.number(),
    nonBillableHours: z.number(),
    billableUtilization: z.number(),
    activeUsers: z.number().int(),
  }),
  users: z.array(utilizationUserSchema),
});

export const clientProfitabilityResponseSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  clients: z.array(z.object({
    clientId: z.number().int().nullable(),
    clientName: z.string(),
    hours: z.number(),
    missingRateHours: z.number(),
    amounts: z.array(z.object({ currency: z.string(), amount: z.number() })),
  })),
});

export const complianceUserSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  expectedHours: z.number().nullable(),
  actualHours: z.number(),
  missingDays: z.number().int(),
  periodsSubmitted: z.number().int(),
  periodsApproved: z.number().int(),
  periodsOverdue: z.number().int(),
});

export const complianceResponseSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  expectedWeeklyHours: z.number().nullable(),
  users: z.array(complianceUserSchema),
});

export const approvalSlaApproverSchema = z.object({
  approverId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  pendingCount: z.number().int(),
  avgHoursToDecision: z.number().nullable(),
});

export const approvalSlaResponseSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  totalSubmitted: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  avgHoursToDecision: z.number().nullable(),
  oldestPending: z.object({
    periodId: z.number().int(),
    userId: z.string(),
    submittedAt: z.string(),
    daysWaiting: z.number(),
  }).nullable(),
  perApprover: z.array(approvalSlaApproverSchema),
});

export const billingLeakageResponseSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  billableHours: z.number(),
  nonBillableHours: z.number(),
  writeOffRate: z.number(),
  approvedBillableUninvoiced: z.object({
    hours: z.number(),
    amounts: z.array(z.object({ currency: z.string(), amount: z.number() })),
  }),
  missingRateHours: z.number(),
  voidedHours: z.number(),
});

/**
 * `GET /timesheets/calendar/holidays`. `holidays.date` is a `date` column, so it
 * arrives as a `YYYY-MM-DD` string rather than a `Date`; the window echoes the
 * caller's own range back.
 */
export const holidaysResponseSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  holidays: z.array(z.object({
    date: z.string(),
    name: z.string(),
    isPublic: z.boolean(),
  })),
});
