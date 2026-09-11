import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const kbCategoryRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  spaceId: z.number().int().nullable(),
  parentId: z.number().int().nullable(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  sortOrder: z.number().int(),
  isPublished: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbCategoryListSchema = z.array(kbCategoryRowSchema);

export const kbArticleListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  categoryId: z.number().int().nullable(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  status: z.enum(["draft", "in_review", "published", "archived"]),
  visibility: z.enum(["public", "internal"]),
  authorId: z.string().nullable(),
  views: z.number().int(),
  helpfulCount: z.number().int(),
  notHelpfulCount: z.number().int(),
  tags: z.array(z.string()),
  publishedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbArticleListSchema = z.array(kbArticleListItemSchema);

export const kbArticleDetailSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  categoryId: z.number().int().nullable(),
  spaceId: z.number().int().nullable(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  content: z.string(),
  contentText: z.string(),
  status: z.enum(["draft", "in_review", "published", "archived"]),
  visibility: z.enum(["public", "internal"]),
  authorId: z.string().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  views: z.number().int(),
  helpfulCount: z.number().int(),
  notHelpfulCount: z.number().int(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  reviewIntervalDays: z.number().int().nullable(),
  lastVerifiedAt: nullableWireDate(),
  publishedAt: nullableWireDate(),
  archivedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  aclRevision: z.number().int(),
  contentRevision: z.number().int(),
  tags: z.array(z.string()),
});

export const kbFeedbackRowSchema = z.object({
  id: z.number().int(),
  articleId: z.number().int(),
  helpful: z.boolean(),
  comment: z.string().nullable(),
  visitorId: z.string().nullable(),
  createdAt: wireDate(),
});

export const kbFeedbackListSchema = z.array(kbFeedbackRowSchema);

export const kbCommentRowSchema = z.object({
  id: z.number().int(),
  articleId: z.number().int(),
  body: z.string(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  userImage: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbCommentListSchema = z.array(kbCommentRowSchema);

export const kbAttachmentRowSchema = z.object({
  id: z.number().int(),
  articleId: z.number().int(),
  fileName: z.string(),
  fileSize: z.number().int().nullable(),
  mimeType: z.string(),
  uploadedBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const kbAttachmentListSchema = z.array(kbAttachmentRowSchema);

export const kbAttachmentDownloadSchema = z.object({
  fileName: z.string(),
  mimeType: z.string(),
  downloadUrl: z.string(),
});

const kbAskCitationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("article"),
    articleId: z.number().int(),
    title: z.string(),
    slug: z.string(),
    spaceId: z.number().int().nullable(),
    updatedAt: wireDate(),
  }),
  z.object({
    kind: z.literal("page"),
    pageId: z.number().int(),
    title: z.string(),
    spaceId: z.number().int().nullable(),
    updatedAt: wireDate(),
  }),
  z.object({
    kind: z.literal("source"),
    sourceId: z.number().int(),
    title: z.string(),
    spaceId: z.number().int().nullable(),
    updatedAt: wireDate(),
  }),
]);

export const kbAskResultSchema = z.object({
  answer: z.string(),
  citations: z.array(kbAskCitationSchema),
  hasContext: z.boolean(),
  aiUsage: z.object({
    model: z.string(),
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    totalTokens: z.number().int(),
    credits: z.number(),
    costUsd: z.number(),
  }).optional(),
});

export const kbIndexStatusSchema = z.object({
  chunks: z.number().int(),
  lastIndexedAt: z.string().nullable(),
});

export const kbReindexArticleSchema = z.object({
  chunks: z.number().int(),
  warnings: z.array(z.string()),
});

export const kbReindexAllSchema = z.object({
  total: z.number().int(),
  indexed: z.number().int(),
  totalChunks: z.number().int(),
  failures: z.array(z.object({ articleId: z.number().int(), error: z.string() })),
  nextArticleId: z.number().int().nullable(),
});

export { successSchema };
