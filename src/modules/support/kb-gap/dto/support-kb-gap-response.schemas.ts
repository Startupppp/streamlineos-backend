import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const aiUsageMetaSchema = z.object({
  model: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});

export const supportKnowledgeGapRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  representativeQuestion: z.string(),
  ticketCount: z.number().int(),
  sampleTicketIds: z.array(z.number().int()),
  status: z.string(),
  proposedArticleId: z.number().int().nullable(),
  draftedBy: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  evidence: z.unknown().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const supportKnowledgeGapWithDeflectionSchema = supportKnowledgeGapRowSchema.and(
  z.object({
    deflectionCount: z.number().int(),
    proposedArticleTitle: z.string().nullable(),
  }),
);

export const gapListResponseSchema = z.object({
  gaps: z.array(supportKnowledgeGapWithDeflectionSchema),
  nextCursor: z.number().int().nullable(),
});

export const detectGapsJobSchema = z.object({ jobId: z.number().int() });

export const proposeDraftResponseSchema = z.object({
  gap: supportKnowledgeGapRowSchema.and(
    z.object({ aiUsage: aiUsageMetaSchema.optional() }),
  ),
});

export const dismissGapResponseSchema = supportKnowledgeGapRowSchema;
