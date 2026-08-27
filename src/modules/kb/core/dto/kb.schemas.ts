import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const KB_AUDIENCES = ["internal", "public", "mixed"] as const;
export const KB_ARTICLE_STATUSES = ["draft", "in_review", "published", "archived"] as const;
export const KB_ARTICLE_VISIBILITIES = ["public", "internal"] as const;

export const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  audience: z.enum(KB_AUDIENCES).default("internal"),
  icon: z.string().trim().max(100).optional(),
  isPublicHelpCenter: z.boolean().optional(),
});
export type CreateSpaceInput = z.infer<typeof createSpaceSchema>;

export const updateSpaceSchema = createSpaceSchema.partial();
export type UpdateSpaceInput = z.infer<typeof updateSpaceSchema>;

export const createCategorySchema = z.object({
  parentId: z.coerce.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  icon: z.string().trim().max(100).optional(),
  sortOrder: z.coerce.number().int().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  parentId: z.coerce.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  icon: z.string().trim().max(100).optional(),
  sortOrder: z.coerce.number().int().optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const listArticlesSchema = z.object({
  spaceId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  status: z.enum(KB_ARTICLE_STATUSES).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  page: pageNumberField,
  pageSize: pageSizeField(20, 100),
});
export type ListArticlesInput = z.infer<typeof listArticlesSchema>;

export const createArticleSchema = z.object({
  spaceId: z.coerce.number().int().positive(),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  title: z.string().trim().min(1).max(300),
  excerpt: z.string().trim().max(500).optional(),
  content: z.string().optional(),
  contentText: z.string().optional(),
  status: z.enum(KB_ARTICLE_STATUSES).default("draft"),
  visibility: z.enum(KB_ARTICLE_VISIBILITIES).default("internal"),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  seoTitle: z.string().trim().max(200).optional(),
  seoDescription: z.string().trim().max(500).optional(),
  reviewIntervalDays: z.coerce.number().int().positive().nullable().optional(),
});
export type CreateArticleInput = z.infer<typeof createArticleSchema>;

export const updateArticleSchema = z.object({
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  excerpt: z.string().trim().max(500).optional(),
  content: z.string().optional(),
  contentText: z.string().optional(),
  status: z.enum(KB_ARTICLE_STATUSES).optional(),
  visibility: z.enum(KB_ARTICLE_VISIBILITIES).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  seoTitle: z.string().trim().max(200).optional(),
  seoDescription: z.string().trim().max(500).optional(),
  reviewIntervalDays: z.coerce.number().int().positive().nullable().optional(),
  changeSummary: z.string().trim().max(500).optional(),
});
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;

export const verifyArticleSchema = z.object({
  reviewIntervalDays: z.coerce.number().int().positive().nullable().optional(),
});
export type VerifyArticleInput = z.infer<typeof verifyArticleSchema>;

export const voteArticleSchema = z.object({
  helpful: z.boolean(),
  comment: z.string().trim().max(1000).optional(),
});
export type VoteArticleInput = z.infer<typeof voteArticleSchema>;
