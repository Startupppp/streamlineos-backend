import { z } from "zod";
import {
  wireDate,
  nullableWireDate,
} from "../../../../common/openapi/wire-types";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { idCursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const contentHealthSignalTypeEnum = z.enum([
  "unowned",
  "stale",
  "unverified",
  "empty",
  "overdue_review",
  "broken_link",
  "overexposed",
  "duplicate_candidate",
  "contradictory_claim",
]);

export type ContentHealthSignalType = z.infer<
  typeof contentHealthSignalTypeEnum
>;

export const contentHealthSignalsQuerySchema = z
  .object({
    signalType: contentHealthSignalTypeEnum,
    afterId: z.coerce.number().int().positive().optional(),
    limit: pageSizeField(50),
    spaceId: z.coerce.number().int().positive().optional(),
    ownerMembershipId: z.coerce.number().int().positive().optional(),
  })
  .strict();

export type ContentHealthSignalsQuery = z.infer<
  typeof contentHealthSignalsQuerySchema
>;

const contentHealthSignalItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  spaceId: z.number().int().nullable(),
  status: z.string(),
  ownerMembershipId: z.number().int().nullable(),
  updatedAt: wireDate(),
  nextReviewAt: nullableWireDate(),
  impact: z.number().int(),
});

export type ContentHealthSignalItem = z.infer<
  typeof contentHealthSignalItemSchema
>;

export const contentHealthSignalsPageSchema = idCursorPageSchema(
  contentHealthSignalItemSchema,
);

const contentHealthCountItemSchema = z.object({
  signalType: contentHealthSignalTypeEnum,
  count: z.number().int(),
});

export const contentHealthCountsSchema = z.object({
  counts: z.array(contentHealthCountItemSchema),
});

export type ContentHealthCounts = z.infer<typeof contentHealthCountsSchema>;

export const dismissHealthItemBodySchema = z
  .object({
    pageId: z.number().int().positive(),
    kind: contentHealthSignalTypeEnum,
    ruleVersion: z.number().int().positive().optional(),
    reason: z.string().min(1).max(1000),
    dismissalExpiresAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .transform((v) => (v !== undefined ? new Date(v) : undefined)),
  })
  .strict();

export type DismissHealthItemBody = z.infer<typeof dismissHealthItemBodySchema>;

export const healthItemStateEnum = z.enum(["open", "resolved", "dismissed"]);

export const healthItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  pageId: z.number().int(),
  kind: contentHealthSignalTypeEnum,
  ruleVersion: z.number().int(),
  impact: z.number().int(),
  state: healthItemStateEnum,
  assigneeMembershipId: z.number().int().nullable(),
  dueAt: nullableWireDate(),
  detectedAt: wireDate(),
  resolvedAt: nullableWireDate(),
  dismissedAt: nullableWireDate(),
  dismissedReason: z.string().nullable(),
  dismissalExpiresAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export type HealthItem = z.infer<typeof healthItemSchema>;

export const assignHealthItemBodySchema = z
  .object({
    pageId: z.number().int().positive(),
    kind: contentHealthSignalTypeEnum,
    assigneeMembershipId: z.number().int().positive(),
    dueAt: z.string().datetime({ offset: true }).optional().transform((v) => (v !== undefined ? new Date(v) : undefined)),
  })
  .strict();

export type AssignHealthItemBody = z.infer<typeof assignHealthItemBodySchema>;

export const bulkRepairBodySchema = z
  .object({
    pageIds: z.array(z.number().int().positive()).min(1).max(100),
    kind: contentHealthSignalTypeEnum,
    repairAction: z.enum(["assign_owner", "request_review", "mark_needs_content"]),
    assigneeMembershipId: z.number().int().positive().optional(),
  })
  .strict();

export type BulkRepairBody = z.infer<typeof bulkRepairBodySchema>;

const bulkRepairOutcomeEnum = z.enum(["applied", "already_resolved", "skipped"]);

const bulkRepairResultItemSchema = z.object({
  pageId: z.number().int(),
  outcome: bulkRepairOutcomeEnum,
});

export const bulkRepairResponseSchema = z.object({
  results: z.array(bulkRepairResultItemSchema),
});

export type BulkRepairResponse = z.infer<typeof bulkRepairResponseSchema>;
export type BulkRepairOutcome = z.infer<typeof bulkRepairOutcomeEnum>;

export const evidenceQuerySchema = z
  .object({
    pageId: z.coerce.number().int().positive(),
    kind: contentHealthSignalTypeEnum,
  })
  .strict();

export type EvidenceQuery = z.infer<typeof evidenceQuerySchema>;

export const evidenceResponseSchema = z.object({
  pageId: z.number().int(),
  kind: contentHealthSignalTypeEnum,
  ruleVersion: z.number().int(),
  evidence: z.record(z.unknown()),
  detectedAt: wireDate(),
});
