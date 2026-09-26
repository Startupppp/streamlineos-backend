import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { roadmapStatusEnum, feedbackStatusEnum } from "../../../../db/schema";
import {
  RICE_INPUT_NAMES,
  RICE_METHOD,
  RICE_SCORE_UNAVAILABLE_REASONS,
} from "../roadmap-prioritization";
import { ROADMAP_DELIVERY_SOURCES } from "../roadmap-delivery";
import { ROADMAP_TIER_UNWEIGHTED_REASONS } from "../roadmap-accounts";
import { crmAccountTierEnum } from "../../../../db/schema";

export const roadmapItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(roadmapStatusEnum.enumValues),
  category: z.string().nullable(),
  isPublic: z.boolean(),
  projectId: z.number().int().nullable(),
  epicTicketId: z.number().int().nullable(),
  targetQuarter: z.string().nullable(),
  sortOrder: z.number().int(),
  votes: z.number().int(),
  reach: z.number().int().nullable(),
  impact: z.number().int().nullable(),
  confidence: z.number().int().nullable(),
  effort: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const roadmapPageSchema = z.object({
  data: z.array(roadmapItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
  total: z.number().int().optional(),
});

export const roadmapPrioritizationSchema = z.object({
  method: z.literal(RICE_METHOD),
  score: z.number().nullable(),
  isComplete: z.boolean(),
  missingInputs: z.array(z.enum(RICE_INPUT_NAMES)),
  unavailableReason: z.enum(RICE_SCORE_UNAVAILABLE_REASONS).nullable(),
});

export const roadmapTierWeightingSchema = z.object({
  tierWeighted: z.boolean(),
  tier: z.enum(crmAccountTierEnum.enumValues).nullable(),
  weight: z.number().nullable(),
  weightedScore: z.number().nullable(),
  unweightedReason: z.enum(ROADMAP_TIER_UNWEIGHTED_REASONS).nullable(),
  linkedFeedbackCount: z.number().int(),
  linkedAccountCount: z.number().int(),
  linkedRevenue: z.number().nullable(),
  revenueKnownAccountCount: z.number().int(),
});

export const roadmapScoredItemSchema = roadmapItemSchema.extend({
  prioritization: roadmapPrioritizationSchema,
  tierWeighting: roadmapTierWeightingSchema,
});

export const roadmapScoredPageSchema = z.object({
  data: z.array(roadmapScoredItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
  total: z.number().int().optional(),
});

export const roadmapDemandSchema = z.object({
  votes: z.number().int(),
  linkedFeedbackCount: z.number().int(),
  openLinkedFeedbackCount: z.number().int(),
});

export const roadmapDeliverySchema = z.object({
  projectId: z.number().int().nullable(),
  epicTicketId: z.number().int().nullable(),
  source: z.enum(ROADMAP_DELIVERY_SOURCES),
  linkedTicketCount: z.number().int(),
  countedTicketCount: z.number().int(),
  completedTicketCount: z.number().int(),
  progressPercent: z.number().int().nullable(),
});

export const roadmapSignalsSchema = z.object({
  itemId: z.number().int(),
  prioritization: roadmapPrioritizationSchema,
  tierWeighting: roadmapTierWeightingSchema,
  demand: roadmapDemandSchema,
  delivery: roadmapDeliverySchema,
});

export const feedbackPostSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(feedbackStatusEnum.enumValues),
  category: z.string().nullable(),
  votes: z.number().int(),
  submittedByName: z.string().nullable(),
  submittedByEmail: z.string().nullable(),
  crmContactId: z.number().int().nullable(),
  crmOrganizationId: z.number().int().nullable(),
  accountValueSnapshot: z.string().nullable(),
  accountTierSnapshot: z.enum(crmAccountTierEnum.enumValues).nullable(),
  linkedRoadmapItemId: z.number().int().nullable(),
  duplicateOfId: z.number().int().nullable(),
  mergedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const changelogEntrySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  content: z.string(),
  version: z.string().nullable(),
  isPublished: z.boolean(),
  linkedRoadmapItemId: z.number().int().nullable(),
  publishedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const projectTemplateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  createdBy: z.string().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const templateListSchema = z.array(projectTemplateSchema);
export const templateRowSchema = projectTemplateSchema;

export const applyTemplateResultSchema = z.object({
  project: z.object({ id: z.number().int(), name: z.string(), key: z.string() }),
  tickets: z.array(z.object({ id: z.number().int(), title: z.string() })),
});


export const roadmapPublicationSchema = z.object({
  token: z.string().nullable(),
  path: z.string().nullable(),
});
