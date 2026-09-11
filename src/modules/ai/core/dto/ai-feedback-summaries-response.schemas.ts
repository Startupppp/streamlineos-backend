import { z } from "zod";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const aiFeedbackCreateResponseSchema = successSchema;

export const aiFeedbackSummaryItemSchema = z.object({
  feature: z.string(),
  up: z.number().int(),
  down: z.number().int(),
  total: z.number().int(),
  ratio: z.number().nullable(),
});

export const aiFeedbackSummaryResponseSchema = z.array(aiFeedbackSummaryItemSchema);

export const aiSummarySnapshotSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  summary: z.string(),
  structured: z.object({
    highlights: z.array(z.string()),
    blockers: z.array(z.string()),
    nextActions: z.array(z.string()),
  }).nullable(),
  citations: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    href: z.string().optional(),
    snippet: z.string().optional(),
    freshness: z.string().optional(),
  })).nullable(),
  correlationId: z.string().nullable(),
  generatedBy: z.string().nullable(),
  generatedByMembershipId: z.number().int().nullable(),
  createdAt: z.string(),
});

const snapshotFieldDiffSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});

const snapshotDiffSchema = z.object({
  highlights: snapshotFieldDiffSchema,
  blockers: snapshotFieldDiffSchema,
  nextActions: snapshotFieldDiffSchema,
  isSameSnapshot: z.boolean(),
});

export const snapshotWithDiffResponseSchema = z.object({
  snapshot: aiSummarySnapshotSchema,
  diff: snapshotDiffSchema.nullable(),
});

export const snapshotWithDiffNullableResponseSchema = snapshotWithDiffResponseSchema.nullable();

export const aiSummariesSaveSnapshotResponseSchema = aiSummarySnapshotSchema;
