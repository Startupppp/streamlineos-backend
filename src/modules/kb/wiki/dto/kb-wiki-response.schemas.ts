import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";


const aiUsageMetaSchema = z.object({
  model: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});

export const kbPageAiBufferedSchema = z.object({
  text: z.string(),
  aiUsage: aiUsageMetaSchema.optional(),
});

export const kbPageCommentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  pageId: z.number().int(),
  authorId: z.string().nullable(),
  parentId: z.number().int().nullable(),
  content: z.string(),
  resolvedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbPageCommentWithAuthorSchema = kbPageCommentSchema.extend({
  authorName: z.string().nullable(),
});

export const kbPageCommentListSchema = z.array(kbPageCommentWithAuthorSchema);

export const kbRecordLinkSchema = z.object({
  id: z.number().int(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  label: z.string().nullable(),
});

export const kbRecordLinkListSchema = z.array(kbRecordLinkSchema);

export const kbRecordLinkSuccessSchema = z.object({ success: z.boolean() });

export const kbRecordLinkByRecordListSchema = z.array(
  z.object({
    pageId: z.number().int(),
    title: z.string(),
    icon: z.string().nullable(),
  }),
);

export const kbPageReviewSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  pageId: z.number().int(),
  type: z.enum(["approval", "freshness"]),
  status: z.enum(["pending", "approved", "rejected"]),
  isOverdue: z.boolean(),
  requestedById: z.string().nullable(),
  reviewerId: z.string().nullable(),
  requestedByMembershipId: z.number().int().nullable(),
  reviewerMembershipId: z.number().int().nullable(),
  dueAt: nullableWireDate(),
  decidedAt: nullableWireDate(),
  decisionNote: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbPageReviewWithContextSchema = kbPageReviewSchema.extend({
  pageTitle: z.string().nullable(),
  requestedByName: z.string().nullable(),
  reviewerName: z.string().nullable(),
});

export const kbPageReviewListPageSchema = cursorPageSchema(kbPageReviewWithContextSchema);
export const kbPageReviewListSchema = z.array(kbPageReviewWithContextSchema);

export const bulkDecideResultItemSchema = z.object({
  id: z.number().int(),
  outcome: z.enum(["succeeded", "denied", "conflict", "notFound"]),
});
export const bulkDecideResultSchema = z.object({
  results: z.array(bulkDecideResultItemSchema),
});

export const kbPageTemplateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  content: z.record(z.string(), z.unknown()).nullable(),
  createdById: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbPageTemplateListSchema = z.array(kbPageTemplateSchema);

const kbPageContentSchema = z.record(z.string(), z.unknown()).nullable();

export const kbPageSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  spaceId: z.number().int().nullable(),
  parentPageId: z.number().int().nullable(),
  sortOrder: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  title: z.string(),
  icon: z.string().nullable(),
  coverImage: z.string().nullable(),
  status: z.string(),
  contentType: z.string(),
  trustState: z.string(),
  visibility: z.string(),
  publicToken: z.string().nullable(),
  publicSlug: z.string().nullable(),
  content: kbPageContentSchema,
  contentText: z.string().nullable(),
  isLocked: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
  createdByMembershipId: z.number().int().nullable(),
  lastEditedByMembershipId: z.number().int().nullable(),
  deletedByMembershipId: z.number().int().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  verifiedByMembershipId: z.number().int().nullable(),
  createdById: z.string().nullable(),
  lastEditedById: z.string().nullable(),
  deletedById: z.string().nullable(),
  ownerUserId: z.string().nullable(),
  verifiedById: z.string().nullable(),
  verifiedUntil: nullableWireDate(),
  nextReviewAt: nullableWireDate(),
  aclRevision: z.number().int(),
  contentRevision: z.number().int(),
  sourceArticleId: z.number().int().nullable(),
});

export const kbPageWithAncestorsSchema = kbPageSchema.extend({
  ancestors: z.array(z.object({ id: z.number().int(), title: z.string() })),
  isFavorite: z.boolean(),
  canEdit: z.boolean(),
});

export const kbPageListItemSchema = kbPageSchema.omit({ content: true, contentText: true });

export const kbPageListSchema = z.array(kbPageListItemSchema);

export const kbPageSearchResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      title: z.string(),
      icon: z.string().nullable(),
      snippet: z.string(),
    }),
  ),
  hasMore: z.boolean(),
  limit: z.number().int(),
});

export const kbPageTreeItemSchema = z.object({
  id: z.number().int(),
  parentPageId: z.number().int().nullable(),
  spaceId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  title: z.string(),
  icon: z.string().nullable(),
  coverImage: z.string().nullable(),
  sortOrder: z.number().int().nullable(),
  visibility: z.string(),
  createdById: z.string().nullable(),
  status: z.string(),
  updatedAt: wireDate(),
  hasChildren: z.boolean(),
});

export const kbPageTreeSchema = z.array(kbPageTreeItemSchema);

export const kbPageSoftDeleteSchema = z.object({ deletedCount: z.number().int() });

export const kbPageEmptyTrashSchema = z.object({ purgedCount: z.number().int() });

export const kbPageSuccessSchema = z.object({ success: z.boolean() });

export const kbPageBacklinkSchema = z.array(
  z.object({ id: z.number().int(), title: z.string(), icon: z.string().nullable() }),
);

const kbPageVersionItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  pageId: z.number().int(),
  versionNumber: z.number().int(),
  title: z.string(),
  content: kbPageContentSchema,
  contentText: z.string().nullable(),
  changeSummary: z.string().nullable(),
  authorId: z.string().nullable(),
  authorMembershipId: z.number().int().nullable(),
  authorName: z.string().nullable(),
  createdAt: wireDate(),
});

export const kbPageVersionListSchema = cursorPageSchema(kbPageVersionItemSchema);

export const kbPageVersionSchema = kbPageVersionItemSchema;

export const kbPublicPageSchema = z.object({
  title: z.string(),
  icon: z.string().nullable(),
  coverImage: z.string().nullable(),
  content: kbPageContentSchema,
  updatedAt: wireDate(),
});

export const kbBulkPageResultItemSchema = z.object({
  pageId: z.number().int(),
  result: z.enum(["succeeded", "denied", "conflict", "notFound"]),
});

export const kbBulkPageResultSchema = z.object({
  results: z.array(kbBulkPageResultItemSchema),
});

export const kbTrashPageListSchema = cursorPageSchema(kbPageListItemSchema);
