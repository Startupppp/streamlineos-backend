import { z } from "zod";
import { queryBoolean } from "../../../../common/validation/query-boolean";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const roadmapListQuerySchema = z.object({
  status: z
    .enum(["planned", "in_progress", "completed", "cancelled"])
    .optional(),
  search: z.string().trim().min(1).optional(),
  page: pageNumberField,
  limit: pageSizeField(50),
});

export const createRoadmapSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  status: z
    .enum(["planned", "in_progress", "completed", "cancelled"])
    .default("planned"),
  category: z.string().trim().max(100).optional(),
  isPublic: z.boolean().default(true),
  projectId: z.number().int().positive().optional(),
  epicTicketId: z.number().int().positive().optional(),
  targetQuarter: z.string().trim().max(20).optional(),
  sortOrder: z.number().int().default(0),
});

export const updateRoadmapSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  status: z
    .enum(["planned", "in_progress", "completed", "cancelled"])
    .optional(),
  category: z.string().trim().max(100).nullable().optional(),
  isPublic: z.boolean().optional(),
  projectId: z.number().int().positive().nullable().optional(),
  epicTicketId: z.number().int().positive().nullable().optional(),
  targetQuarter: z.string().trim().max(20).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

export const feedbackListQuerySchema = z.object({
  status: z
    .enum(["open", "planned", "in_progress", "completed", "declined"])
    .optional(),
  search: z.string().trim().min(1).optional(),
  includeMerged: queryBoolean.default(false),
  page: pageNumberField,
  limit: pageSizeField(50),
});

export const mergeFeedbackSchema = z.object({
  targetPostId: z.number().int().positive(),
});

export const createFeedbackSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  status: z
    .enum(["open", "planned", "in_progress", "completed", "declined"])
    .default("open"),
  category: z.string().trim().max(100).optional(),
  submittedByName: z.string().trim().max(120).optional(),
  submittedByEmail: z.string().trim().email().optional(),
  linkedRoadmapItemId: z.number().int().positive().optional(),
});

export const updateFeedbackSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  status: z
    .enum(["open", "planned", "in_progress", "completed", "declined"])
    .optional(),
  category: z.string().trim().max(100).nullable().optional(),
  linkedRoadmapItemId: z.number().int().positive().nullable().optional(),
});

export const changelogListQuerySchema = z.object({
  type: z.enum(["feature", "improvement", "fix"]).optional(),
  page: pageNumberField,
  limit: pageSizeField(50),
});

export const createChangelogSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().max(20000).default(""),
  version: z.string().trim().max(40).optional(),
  type: z.enum(["feature", "improvement", "fix"]).default("feature"),
  isPublished: z.boolean().default(false),
  linkedRoadmapItemId: z.number().int().positive().optional(),
});

export const updateChangelogSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().max(20000).optional(),
  version: z.string().trim().max(40).nullable().optional(),
  type: z.enum(["feature", "improvement", "fix"]).optional(),
  isPublished: z.boolean().optional(),
  linkedRoadmapItemId: z.number().int().positive().nullable().optional(),
});

export type RoadmapListQuery = z.infer<typeof roadmapListQuerySchema>;
export type CreateRoadmapInput = z.infer<typeof createRoadmapSchema>;
export type UpdateRoadmapInput = z.infer<typeof updateRoadmapSchema>;
export type FeedbackListQuery = z.infer<typeof feedbackListQuerySchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export type UpdateFeedbackInput = z.infer<typeof updateFeedbackSchema>;
export type ChangelogListQuery = z.infer<typeof changelogListQuerySchema>;
export type CreateChangelogInput = z.infer<typeof createChangelogSchema>;
export type UpdateChangelogInput = z.infer<typeof updateChangelogSchema>;
export type MergeFeedbackInput = z.infer<typeof mergeFeedbackSchema>;
