import { z } from "zod";
import {
  PAGE_SIZE_CAP,
  pageSizeField,
} from "../../../../common/pagination/list-query.schema";
import {
  KB_PAGE_COLLECTION_DEFAULT_LIMIT,
  KB_PAGE_COLLECTION_SORTS,
  KB_PAGE_STATUSES,
} from "../collection/knowledge-collection.types";

export const KB_AUDIENCES = ["internal", "public", "mixed"] as const;
export const KB_ARTICLE_STATUSES = [
  "draft",
  "in_review",
  "published",
  "archived",
] as const;
export const KB_ARTICLE_VISIBILITIES = ["public", "internal"] as const;

export const createSpaceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    audience: z.enum(KB_AUDIENCES).default("internal"),
    icon: z.string().trim().max(100).optional(),
    isPublicHelpCenter: z.boolean().optional(),
  })
  .strict();
export type CreateSpaceInput = z.infer<typeof createSpaceSchema>;

export const updateSpaceSchema = createSpaceSchema.partial().strict();
export type UpdateSpaceInput = z.infer<typeof updateSpaceSchema>;

export const createCategorySchema = z
  .object({
    parentId: z.coerce.number().int().positive().nullable().optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).optional(),
    icon: z.string().trim().max(100).optional(),
    sortOrder: z.coerce.number().int().optional(),
  })
  .strict();
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    parentId: z.coerce.number().int().positive().nullable().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    icon: z.string().trim().max(100).optional(),
    sortOrder: z.coerce.number().int().optional(),
  })
  .strict();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const listArticlesSchema = z
  .object({
    spaceId: z.coerce.number().int().positive().optional(),
    categoryId: z.coerce.number().int().positive().optional(),
    status: z.enum(KB_ARTICLE_STATUSES).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().optional(),
    limit: pageSizeField(20, 100),
  })
  .strict();
export type ListArticlesInput = z.infer<typeof listArticlesSchema>;

export const createArticleSchema = z
  .object({
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
    reviewIntervalDays: z.coerce
      .number()
      .int()
      .positive()
      .nullable()
      .optional(),
  })
  .strict();
export type CreateArticleInput = z.infer<typeof createArticleSchema>;

export const updateArticleSchema = z
  .object({
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
    reviewIntervalDays: z.coerce
      .number()
      .int()
      .positive()
      .nullable()
      .optional(),
    changeSummary: z.string().trim().max(500).optional(),
    expectedContentRevision: z.coerce.number().int().positive(),
  })
  .strict();
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;

export const verifyArticleSchema = z
  .object({
    reviewIntervalDays: z.coerce
      .number()
      .int()
      .positive()
      .nullable()
      .optional(),
  })
  .strict();
export type VerifyArticleInput = z.infer<typeof verifyArticleSchema>;

export const voteArticleSchema = z
  .object({
    helpful: z.boolean(),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict();
export type VoteArticleInput = z.infer<typeof voteArticleSchema>;

export const updateKbSettingsSchema = z.object({
  trashRetentionDays: z.number().int().min(1).max(365),
});
export type UpdateKbSettingsInput = z.infer<typeof updateKbSettingsSchema>;

export const kbCommentCursorQuerySchema = z
  .object({
    afterCreatedAt: z.string().optional(),
    afterId: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type KbCommentCursorQuery = z.infer<typeof kbCommentCursorQuerySchema>;

const kbFlag = z
  .enum(["0", "1", "true", "false"])
  .transform(function toBoolean(raw) {
    return raw === "1" || raw === "true";
  });

export const kbPageCollectionQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    spaceId: z.coerce.number().int().positive().optional(),
    projectId: z.coerce.number().int().positive().optional(),
    owner: z.literal("me").optional(),
    sharedWithMe: kbFlag.optional(),
    status: z
      .string()
      .min(1)
      .max(64)
      .transform(function splitStatuses(raw) {
        return raw
          .split(",")
          .map(function trimEntry(entry) {
            return entry.trim();
          })
          .filter(function nonEmpty(entry) {
            return entry.length > 0;
          });
      })
      .pipe(
        z.array(z.enum(KB_PAGE_STATUSES)).min(1).max(KB_PAGE_STATUSES.length),
      )
      .optional(),
    verified: kbFlag.optional(),
    deleted: kbFlag.optional(),
    sort: z.enum(KB_PAGE_COLLECTION_SORTS).default("updated_desc"),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGE_SIZE_CAP)
      .default(KB_PAGE_COLLECTION_DEFAULT_LIMIT),
    facets: kbFlag.optional(),
  })
  .strict();

export type KbPageCollectionQueryInput = z.infer<
  typeof kbPageCollectionQuerySchema
>;

export const listSpacesQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    audience: z.enum(KB_AUDIENCES).optional(),
    archived: z
      .enum(["0", "1", "true", "false"])
      .transform(function toBoolean(v) {
        return v === "1" || v === "true";
      })
      .optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: pageSizeField(20),
  })
  .strict();
export type ListSpacesQuery = z.infer<typeof listSpacesQuerySchema>;
