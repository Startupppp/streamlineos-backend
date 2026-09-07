import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

export const roadmapItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
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

export const feedbackPostSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  votes: z.number().int(),
  submittedByName: z.string().nullable(),
  submittedByEmail: z.string().nullable(),
  crmContactId: z.number().int().nullable(),
  crmOrganizationId: z.number().int().nullable(),
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

export { successSchema };
