import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { managedProductStatusEnum } from "../../../../db/schema";

export const managedProductRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  status: z.enum(managedProductStatusEnum.enumValues),
  ownerId: z.string().nullable(),
  vision: z.string().nullable(),
  missionStatement: z.string().nullable(),
  targetCustomer: z.string().nullable(),
  differentiators: z.string().nullable(),
  currentPhase: z.string().nullable(),
  targetLaunchDate: nullableWireDate(),
  successMetrics: z.unknown(),
  ownerMembershipId: z.number().int().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const managedProductPageSchema = cursorPageSchema(managedProductRowSchema);

export const bulkManagedProductsResultItemSchema = z.object({
  id: z.number().int(),
  outcome: z.enum(["updated", "skipped"]),
  reason: z.string().nullable(),
});

export const bulkManagedProductsResultSchema = z.object({
  requested: z.number().int(),
  succeeded: z.number().int(),
  skipped: z.number().int(),
  results: z.array(bulkManagedProductsResultItemSchema),
});

export const managedProductInsightsSchema = z.object({
  linkedProjectCount: z.number().int(),
  projectsByStatus: z.object({
    active: z.number().int(),
    completed: z.number().int(),
    archived: z.number().int(),
  }),
  submissionsByStatus: z.object({
    open: z.number().int(),
    in_progress: z.number().int(),
    resolved: z.number().int(),
    archived: z.number().int(),
  }),
  roadmapItemCount: z.number().int(),
  roadmapItemsByStatus: z.object({
    planned: z.number().int(),
    in_progress: z.number().int(),
    completed: z.number().int(),
    cancelled: z.number().int(),
  }),
  feedbackByStatus: z.object({
    open: z.number().int(),
    planned: z.number().int(),
    in_progress: z.number().int(),
    completed: z.number().int(),
    declined: z.number().int(),
  }),
  linkedFeedbackVoteCount: z.number().int(),
});
