import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { successSchema } from "../../../common/openapi/response-envelopes";

export const dealSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  value: z.string().nullable(),
  stage: z.string(),
  companyName: z.string().nullable(),
  contactName: z.string().nullable(),
  assignedToId: z.string().nullable(),
  salesRepId: z.number().int().nullable(),
  pipelineId: z.string().nullable(),
  probability: z.number().int().nullable(),
  expectedCloseDate: z.string().nullable(),
  actualCloseDate: z.string().nullable(),
  lastContactDate: z.string().nullable(),
  lostReason: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  customData: z.record(z.string(), z.unknown()).nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const dealListSchema = z.object({
  deals: z.array(dealSchema),
  total: z.number().int(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
});

export const dealStatsSchema = z.object({
  active: z.number().int(),
  pipelineValue: z.number(),
  wonValue: z.number(),
});

export const dealAgingSchema = z.object({
  summary: z.object({
    total: z.number().int(),
    stale: z.number().int(),
    critical: z.number().int(),
  }),
  deals: z.array(
    dealSchema.pick({ id: true, name: true, value: true, stage: true, updatedAt: true, createdAt: true, assignedToId: true }).extend({
      assigneeName: z.string().nullable(),
      daysInStage: z.number().int(),
      isStale: z.boolean(),
      isCritical: z.boolean(),
    }),
  ),
});

const forecastByMonthSchema = z.object({
  month: z.string(),
  weighted: z.number(),
  bestCase: z.number(),
  count: z.number().int(),
});

const forecastByStageSchema = z.object({
  stage: z.string(),
  count: z.number().int(),
  totalValue: z.number(),
  weightedValue: z.number(),
  avgProbability: z.number().int(),
});

export const dealForecastSchema = z.object({
  totalWeighted: z.number(),
  totalBestCase: z.number(),
  totalDeals: z.number().int(),
  byMonth: z.array(forecastByMonthSchema),
  byStage: z.array(forecastByStageSchema),
});

export const dealForecastSnapshotSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  period: z.string(),
  createdById: z.string().nullable(),
  overrideAmount: z.string().nullable(),
  overrideNote: z.string().nullable(),
  overriddenBy: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  capturedAt: wireDate(),
});

export const dealForecastSnapshotsSchema = z.object({
  snapshots: z.array(dealForecastSnapshotSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const dealForecastCompareSchema = z.object({
  period: z.string(),
  baseline: z.record(z.string(), z.unknown()),
  current: z.record(z.string(), z.unknown()),
  delta: z.object({
    totalWeighted: z.number(),
    totalBestCase: z.number(),
    totalDeals: z.number().int(),
  }),
});

export const dealWinLossSchema = z.object({
  summary: z.object({
    won: z.number().int(),
    wonValue: z.number(),
    lost: z.number().int(),
    lostValue: z.number(),
    total: z.number().int(),
    winRate: z.number().int(),
  }),
  lostByReason: z.array(
    z.object({
      reason: z.string(),
      count: z.number().int(),
      totalValue: z.number(),
    }),
  ),
});

export const dealHealthSchema = z.object({
  dealId: z.number().int(),
  score: z.number().int(),
  level: z.enum(["healthy", "at_risk", "critical"]),
  factors: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      impact: z.enum(["positive", "negative", "neutral"]),
      weight: z.number().int(),
    }),
  ),
  computedAt: z.string(),
});

export const dealApprovalRuleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  minValue: z.string(),
  approverRole: z.string(),
  isActive: z.boolean(),
  createdAt: wireDate(),
});

export const dealApprovalSchema = z.object({
  id: z.number().int(),
  dealId: z.number().int(),
  dealName: z.string().nullable(),
  dealValue: z.string().nullable(),
  requestedBy: z.string(),
  requesterName: z.string().nullable(),
  requestedStage: z.string(),
  status: z.string(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  resolvedAt: nullableWireDate(),
});

export const dealRequestApprovalSchema = z.union([
  z.object({ created: z.literal(false), body: z.object({ approved: z.literal(true), directUpdate: z.literal(true) }) }),
  z.object({
    created: z.literal(true),
    body: z.object({
      id: z.number().int(),
      orgId: z.string(),
      dealId: z.number().int(),
      requestedBy: z.string(),
      requestedStage: z.string(),
      status: z.string(),
      rejectionReason: z.string().nullable(),
      approvedBy: z.string().nullable(),
      resolvedAt: nullableWireDate(),
      createdAt: wireDate(),
    }),
  }),
]);

export const dealStakeholderSchema = z.object({
  id: z.number().int(),
  dealId: z.number().int(),
  contactId: z.number().int(),
  roleKey: z.string().nullable(),
  influence: z.string().nullable(),
  isPrimary: z.boolean(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  contact: z.object({
    id: z.number().int(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    title: z.string().nullable(),
    company: z.string().nullable(),
  }),
});

export const dealStakeholderMutatedSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  dealId: z.number().int(),
  contactId: z.number().int(),
  roleKey: z.string().nullable(),
  influence: z.string().nullable(),
  isPrimary: z.boolean(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
});

export const dealCompetitorSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  dealId: z.number().int(),
  name: z.string(),
  notes: z.string().nullable(),
  strength: z.string().nullable(),
  weakness: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const dealMeetingSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  dealId: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  scheduledAt: wireDate(),
  durationMinutes: z.number().int().nullable(),
  location: z.string().nullable(),
  meetingUrl: z.string().nullable(),
  createdById: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  creator: z.object({ id: z.string(), name: z.string().nullable() }).nullable().optional(),
  attendees: z.array(z.string()),
});

export const dealActivitySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  dealId: z.number().int(),
  type: z.string(),
  subject: z.string().nullable(),
  previousValue: z.string().nullable(),
  newValue: z.string().nullable(),
  notes: z.string().nullable(),
  userId: z.string().nullable(),
  createdAt: wireDate(),
});

export const dealStageTransitionSchema = z.object({
  id: z.number().int(),
  dealId: z.number().int(),
  fromStage: z.string().nullable(),
  toStage: z.string(),
  userId: z.string().nullable(),
  createdAt: wireDate(),
});

export const dealCustomDataSchema = z.object({
  customData: z.record(z.string(), z.unknown()).nullable(),
});

export const dealBulkResultSchema = z.object({ updated: z.number().int() });
export const dealBulkDeleteResultSchema = z.object({ deleted: z.number().int() });
export const dealBulkImportResultSchema = z.object({
  imported: z.number().int(),
  updated: z.number().int(),
  errors: z.array(z.unknown()),
});

export const dealTransitionsListSchema = z.object({
  data: z.array(dealStageTransitionSchema),
});

export const dealUpdateResultSchema = z.union([
  dealSchema,
  z.object({
    approvalPending: z.literal(true),
    approvalId: z.number().int(),
    deal: dealSchema,
  }),
]);

export { successSchema };
