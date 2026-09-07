import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const timesheetPeriodSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.string(),
  totalHours: z.string(),
  billableHours: z.string(),
  nonBillableHours: z.string(),
  submittedAt: nullableWireDate(),
  approvedAt: nullableWireDate(),
  rejectedAt: nullableWireDate(),
  lockedAt: nullableWireDate(),
  currentApproverMembershipId: z.number().int().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: z.object({
    membershipId: z.number().int().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }).optional(),
});

export const timesheetApprovalItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.string(),
  totalHours: z.string(),
  billableHours: z.string(),
  nonBillableHours: z.string(),
  submittedAt: nullableWireDate(),
  approvedAt: nullableWireDate(),
  rejectedAt: nullableWireDate(),
  lockedAt: nullableWireDate(),
  currentApproverMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: z.object({
    membershipId: z.number().int().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
});

export const approvalsListResponseSchema = cursorPageSchema(timesheetApprovalItemSchema);

export const bulkApproveResponseSchema = z.object({
  approved: z.number().int(),
  skipped: z.number().int(),
});

export const bulkRejectResponseSchema = z.object({ rejected: z.number().int() });

export const timesheetAuditEventSchema = z.object({
  id: z.number().int(),
  actorMembershipId: z.number().int().nullable(),
  actorName: z.string().nullable(),
  entityType: z.string(),
  entityId: z.string(),
  action: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
  createdAt: wireDate(),
});

export const auditListResponseSchema = cursorPageSchema(timesheetAuditEventSchema);

export const auditVerifyResponseSchema = z.union([
  z.object({
    valid: z.literal(true),
    checked: z.number().int(),
    verified: z.number().int(),
    legacyRows: z.number().int(),
  }),
  z.object({
    valid: z.literal(false),
    brokenAtId: z.number().int(),
    checked: z.number().int(),
    legacyRows: z.number().int(),
  }),
]);

export const convertedTotalsSchema = z.object({
  baseCurrency: z.string(),
  totalInBase: z.number(),
  rates: z.record(z.string(), z.number()),
  isPartial: z.boolean(),
}).nullable();

export const billingUninvoicedResponseSchema = z.object({
  groups: z.array(z.object({
    projectId: z.number().int(),
    projectName: z.string(),
    totalHours: z.number(),
    billableAmount: z.number(),
    currency: z.string(),
    entryCount: z.number().int(),
    missingRate: z.boolean(),
  })),
  totals: z.object({
    hours: z.number(),
    amount: z.number().nullable(),
    currency: z.string().nullable(),
    mixed: z.boolean(),
    byCurrency: z.array(z.object({ currency: z.string(), amount: z.number(), hours: z.number() })),
    converted: convertedTotalsSchema,
  }),
});

export const billingExportResponseSchema = z.object({
  exportId: z.number().int(),
  entryCount: z.number().int(),
  totalHours: z.number(),
  totalAmount: z.number(),
  duplicate: z.boolean().optional(),
});

export const billingInvoiceDraftResponseSchema = z.object({
  exportId: z.number().int(),
  entryCount: z.number().int(),
  amount: z.number(),
});

export const billingRatePreviewResponseSchema = z.object({
  billRate: z.number().nullable(),
  costRate: z.number().nullable(),
  currency: z.string(),
  source: z.enum(["RATE_CARD", "PROJECT_MEMBER"]).nullable(),
});

const burnResultSchema = z.object({
  budget: z.number(),
  consumed: z.number(),
  percentUsed: z.number(),
  remaining: z.number(),
  alertLevel: z.number(),
  over: z.boolean(),
});

export const budgetItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  clientId: z.number().int().nullable(),
  budgetType: z.string(),
  budgetHours: z.string().nullable(),
  budgetAmount: z.string().nullable(),
  currency: z.string(),
  alertThresholds: z.array(z.number()),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  burn: burnResultSchema,
});

export const budgetListResponseSchema = z.array(budgetItemSchema);

export const entrySchema = z.object({
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
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  lockedAt: nullableWireDate(),
  voidedAt: nullableWireDate(),
  invoicingStatus: z.string(),
  billRate: z.string().nullable(),
  currency: z.string().nullable(),
  rateSource: z.string().nullable(),
  source: z.string(),
  workLink: z.string().nullable(),
  timesheetPeriodId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  project: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  ticket: z.object({
    id: z.number().int(),
    title: z.string(),
    ticketNumber: z.number().int(),
    project: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  }).nullable(),
});

export const entriesListResponseSchema = z.object({
  data: z.array(entrySchema),
  pagination: z.object({ hasNextPage: z.boolean(), cursor: z.string().nullable() }).optional(),
});

export const exceptionItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  periodId: z.number().int().nullable(),
  entryId: z.number().int().nullable(),
  rule: z.string(),
  severity: z.string(),
  status: z.string(),
  message: z.string(),
  details: z.unknown().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  dueDate: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  resolvedByMembershipId: z.number().int().nullable(),
  resolvedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: z.object({
    membershipId: z.number().int().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
});

export const exceptionsListResponseSchema = cursorPageSchema(exceptionItemSchema);

export const exceptionsSummaryResponseSchema = z.object({
  total: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  bySeverity: z.record(z.string(), z.number().int()),
  openBySeverity: z.record(z.string(), z.number().int()),
});

export const exceptionResolutionResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  periodId: z.number().int().nullable(),
  entryId: z.number().int().nullable(),
  rule: z.string(),
  severity: z.string(),
  status: z.string(),
  message: z.string(),
  details: z.unknown().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  dueDate: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  resolvedByMembershipId: z.number().int().nullable(),
  resolvedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const detectorResponseSchema = z.object({
  week: z.object({ start: z.string(), end: z.string() }),
  candidates: z.number().int(),
  created: z.number().int(),
});

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
  })),
});

export const rateCardSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  currency: z.string(),
  isDefault: z.boolean(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const rateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  rateCardId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  userMembershipId: z.number().int().nullable(),
  clientId: z.number().int().nullable(),
  taskId: z.number().int().nullable(),
  billingType: z.string(),
  billRate: z.string(),
  costRate: z.string().nullable(),
  currency: z.string(),
  priority: z.number().int(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const ratesListResponseSchema = z.object({
  rates: z.array(rateSchema),
  rateCards: z.array(rateCardSchema),
});

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

export const timesheetSettingsSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  workWeekStart: z.number().int(),
  requiredFields: z.unknown().nullable(),
  roundingRule: z.string(),
  maxHoursPerDay: z.string(),
  allowOverlappingEntries: z.boolean(),
  allowBackdatedEntries: z.boolean(),
  backdateLimitDays: z.number().int().nullable(),
  approvalMode: z.string(),
  clientApprovalEnabled: z.boolean(),
  lockAfterApproval: z.boolean(),
  lockAfterInvoice: z.boolean(),
  reminderRules: z.unknown().nullable(),
  payPeriod: z.string(),
  allowFutureEntries: z.boolean(),
  expectedDailyHours: z.string().nullable(),
  expectedWeeklyHours: z.string().nullable(),
  submissionGraceDays: z.number().int().nullable(),
  overtimeDailyHours: z.string(),
  overtimeWeeklyHours: z.string(),
  includeNonBillable: z.boolean(),
  payrollMapping: z.unknown().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const settingsHistorySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  version: z.number().int(),
  settings: z.unknown(),
  changedByMembershipId: z.number().int().nullable(),
  changeReason: z.string().nullable(),
  createdAt: wireDate(),
});

export const settingsHistoryListResponseSchema = z.array(settingsHistorySchema);

export const teamSummaryResponseSchema = z.object({
  summaries: z.array(z.object({
    userId: z.string(),
    period: timesheetPeriodSchema.nullable(),
    dailyHours: z.record(z.string(), z.number()),
    totalHours: z.number(),
  })),
});

export const timerSchema = z.object({
  id: z.number().int(),
  userMembershipId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  ticketId: z.number().int().nullable(),
  description: z.string().nullable(),
  billable: z.boolean(),
  startedAt: wireDate(),
  lastResumedAt: nullableWireDate(),
  accumulatedSeconds: z.number().int(),
  status: z.string(),
  elapsedSeconds: z.number().int(),
  project: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  ticket: z.object({ id: z.number().int(), title: z.string() }).nullable(),
});

export const timerNullableResponseSchema = timerSchema.nullable();

export const aiTextResponseSchema = z.object({
  text: z.string(),
  aiUsage: z.object({
    model: z.string(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    cacheReadTokens: z.number().int().optional(),
    cacheWriteTokens: z.number().int().optional(),
    creditsCharged: z.number().optional(),
  }).optional(),
});

export const aiSummarizePeriodResponseSchema = z.object({
  narration: z.string(),
  evidence: z.record(z.string(), z.unknown()),
});
