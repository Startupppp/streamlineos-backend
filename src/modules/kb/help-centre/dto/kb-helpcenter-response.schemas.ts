import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema, cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const aiUsageMetaSchema = z.object({
  model: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});

export const kbAiBufferedSchema = z.object({
  text: z.string(),
  aiUsage: aiUsageMetaSchema.optional(),
});

export const kbAnalyticsOverviewSchema = z.object({
  totalCount: z.number().int(),
  publishedCount: z.number().int(),
  archivedCount: z.number().int(),
  totalViews: z.number().int(),
  helpfulUp: z.number().int(),
  helpfulDown: z.number().int(),
  helpfulRatio: z.number(),
  searches: z.number().int(),
  noResults: z.number().int(),
  searchSuccessRate: z.number(),
  aiAnswers: z.number().int(),
  aiNoContext: z.number().int(),
  views: z.number().int(),
  ticketsDeflected: z.number().int(),
  verifiedPublished: z.number().int(),
  trustScore: z.number(),
});

export const kbAnalyticsNoResultsSchema = z.array(
  z.object({ query: z.string().nullable(), count: z.number().int() }),
);

const kbAnalyticsPageItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.string(),
  trustState: z.string(),
  updatedAt: wireDate(),
  uniqueViewers: z.number().int(),
  commentCount: z.number().int(),
  versionCount: z.number().int(),
});

export const kbAnalyticsPagesSchema = cursorPageSchema(kbAnalyticsPageItemSchema);

export const kbAnalyticsCitationReuseSchema = z.array(
  z.object({
    kind: z.string(),
    refId: z.number().int(),
    title: z.string(),
    reuseCount: z.number().int(),
  }),
);

export const kbAnalyticsReviewSlaSchema = z.object({
  decided: z.number().int(),
  metSla: z.number().int(),
  slaRate: z.number(),
  overdueOpen: z.number().int(),
});

const kbAnalyticsGapItemSchema = z.object({
  query: z.string().nullable(),
  count: z.number().int(),
  lastOccurredAt: wireDate(),
});

export const kbAnalyticsGapsSchema = cursorPageSchema(kbAnalyticsGapItemSchema);

export const kbAnalyticsGapRelatedPageItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.string(),
  updatedAt: wireDate(),
});

export const kbAnalyticsGapRelatedPagesSchema = cursorPageSchema(kbAnalyticsGapRelatedPageItemSchema);

export const kbAnalyticsContentGapsSchema = z.array(
  z.object({
    query: z.string().nullable(),
    count: z.number().int(),
    lastOccurredAt: wireDate(),
    gapKind: z.enum(["search", "ai_no_context"]),
  }),
);

export const kbArticleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  categoryId: z.number().int().nullable(),
  spaceId: z.number().int().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  content: z.string(),
  contentText: z.string(),
  status: z.enum(["draft", "in_review", "published", "archived"]),
  visibility: z.enum(["public", "internal"]),
  authorId: z.string().nullable(),
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
});

export const kbArticleWithTagsSchema = kbArticleSchema.extend({
  tags: z.array(z.string()),
});

export const kbArticleFullSchema = kbArticleWithTagsSchema.extend({
  category: z
    .object({ id: z.number().int(), name: z.string(), slug: z.string() })
    .nullable(),
});

export const kbArticleListItemSchema = z.object({
  id: z.number().int(),
  spaceId: z.number().int().nullable(),
  categoryId: z.number().int().nullable(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  status: z.enum(["draft", "in_review", "published", "archived"]),
  visibility: z.enum(["public", "internal"]),
  ownerMembershipId: z.number().int().nullable(),
  helpfulCount: z.number().int(),
  notHelpfulCount: z.number().int(),
  lastVerifiedAt: nullableWireDate(),
  updatedAt: wireDate(),
  tags: z.array(z.string()),
});

export const kbArticleListResultSchema = z.object({
  items: z.array(kbArticleListItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int(),
});

export const kbArticleVersionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  articleId: z.number().int(),
  versionNumber: z.number().int(),
  title: z.string(),
  content: z.string(),
  excerpt: z.string().nullable(),
  changeSummary: z.string().nullable(),
  authorId: z.string().nullable(),
  authorMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const kbArticleVersionListSchema = z.array(kbArticleVersionSchema);

export const kbArticleSuccessSchema = z.object({ success: z.boolean() });

export const kbAuthoringContentSchema = z.object({ content: z.string() });

export const kbCategorySchema = z.object({
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

export const kbCategoryListSchema = z.array(kbCategorySchema);

export const kbCategorySuccessSchema = z.object({ success: z.boolean() });

export const kbArticleCommentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  articleId: z.number().int(),
  authorId: z.string().nullable(),
  content: z.string(),
  parentId: z.number().int().nullable(),
  resolvedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbArticleCommentWithAuthorSchema = kbArticleCommentSchema.extend({
  authorName: z.string().nullable(),
});

export const kbArticleCommentListSchema = z.array(kbArticleCommentWithAuthorSchema);

export const kbVerificationQueueItemSchema = z.object({
  id: z.number().int(),
  spaceId: z.number().int().nullable(),
  categoryId: z.number().int().nullable(),
  title: z.string(),
  slug: z.string(),
  ownerMembershipId: z.number().int().nullable(),
  reviewIntervalDays: z.number().int().nullable(),
  lastVerifiedAt: nullableWireDate(),
  updatedAt: wireDate(),
});

export const kbVerificationQueueSchema = itemsPagedSchema(kbVerificationQueueItemSchema);

export const kbWidgetConfigSchema = z.object({
  orgId: z.string(),
  helpCenterUrl: z.string(),
  buttonLabel: z.string(),
  primaryColor: z.string(),
  position: z.string(),
});

export const kbAiFeedbackSchema = z.object({ success: z.literal(true) });
