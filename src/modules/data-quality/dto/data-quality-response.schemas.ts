import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

const findingRowSchema = z.object({
  findingId: z.string(),
  organizationId: z.string(),
  producer: z.string(),
  findingKind: z.string(),
  subjectKey: z.string(),
  groupKey: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  status: z.enum(["open", "resolved", "dismissed"]),
  partyId: z.string(),
  relatedPartyId: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()).nullable(),
  score: z.number().nullable(),
  proposedAction: z.string(),
  proposedPatch: z.record(z.string(), z.unknown()).nullable(),
  reversibility: z.string(),
  assignedToUserId: z.string().nullable(),
  assignedByUserId: z.string().nullable(),
  assignedAt: nullableWireDate(),
  firstDetectedAt: wireDate(),
  lastSeenAt: wireDate(),
  resolvedAt: nullableWireDate(),
  resolvedByUserId: z.string().nullable(),
  resolutionId: z.string().nullable(),
  undoToken: z.record(z.string(), z.unknown()).nullable(),
  lastError: z.string().nullable(),
});

const findingItemSchema = findingRowSchema.extend({ ageDays: z.number() });

export const findingsPageSchema = cursorPageSchema(findingItemSchema);

export const findingDetailSchema = findingItemSchema;

const groupItemSchema = z.object({
  producer: z.string(),
  findingKind: z.string(),
  groupKey: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  proposedAction: z.string(),
  reversibility: z.string(),
  openCount: z.number().int(),
  oldestDetectedAt: wireDate(),
  oldestAgeDays: z.number(),
  weight: z.number(),
  resolvableInOneDecision: z.boolean(),
});

export const findingGroupsSchema = z.object({
  data: z.array(groupItemSchema),
});

const severityMapSchema = z.object({
  high: z.number().int(),
  medium: z.number().int(),
  low: z.number().int(),
});

const byProducerItemSchema = z.object({
  producer: z.string(),
  count: z.number().int(),
  weight: z.number(),
});

export const healthSchema = z.object({
  windowDays: z.number().int(),
  open: z.object({
    total: z.number().int(),
    weighted: z.number(),
    bySeverity: severityMapSchema,
    byProducer: z.array(byProducerItemSchema),
  }),
  trend: z.object({
    openedInWindow: z.number().int(),
    closedInWindow: z.number().int(),
    resolvedInWindow: z.number().int(),
    dismissedInWindow: z.number().int(),
    net: z.number().int(),
  }),
  oldestOpenAt: nullableWireDate(),
  oldestOpenAgeDays: z.number().nullable(),
});

const resolutionRowSchema = z.object({
  resolutionId: z.string(),
  organizationId: z.string(),
  action: z.enum(["apply", "dismiss"]),
  selectionKind: z.string(),
  groupKey: z.string().nullable(),
  reversibility: z.string(),
  holdUntil: nullableWireDate(),
  reason: z.string().nullable(),
  attemptedCount: z.number().int(),
  resolvedCount: z.number().int(),
  failedCount: z.number().int(),
  failures: z
    .array(z.object({ findingId: z.string(), error: z.string() }))
    .nullable(),
  decidedByUserId: z.string(),
  decidedAt: wireDate(),
  reversedAt: nullableWireDate(),
  reversedByUserId: z.string().nullable(),
  reversedReason: z.string().nullable(),
  reversedCount: z.number().int().nullable(),
});

export const resolutionsPageSchema = cursorPageSchema(resolutionRowSchema);

export const assignSchema = z.object({
  assigned: z.number().int(),
  findingIds: z.array(z.string()),
});

const executionFailureSchema = z.object({
  findingId: z.string(),
  error: z.string(),
});

export const resolveSchema = z.object({
  resolutionId: z.string(),
  action: z.string(),
  reversibility: z.string(),
  attemptedCount: z.number().int(),
  resolvedCount: z.number().int(),
  failedCount: z.number().int(),
  failures: z.array(executionFailureSchema),
  remainingInGroup: z.number().int().nullable(),
});

export const reverseSchema = z.object({
  reversed: z.literal(true),
  action: z.string(),
  reopened: z.number().int(),
  failedCount: z.number().int(),
  failures: z.array(executionFailureSchema),
});

export const scanSchema = z.object({
  producers: z.array(z.string()),
  examined: z.number().int(),
  filed: z.number().int(),
  capped: z.boolean(),
});
