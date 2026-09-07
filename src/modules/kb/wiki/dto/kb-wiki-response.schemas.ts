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

export const kbImportJobSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  sourceType: z.string(),
  fileKey: z.string().nullable(),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  totalItems: z.number().int(),
  processedItems: z.number().int(),
  succeededItems: z.number().int(),
  failedItems: z.number().int(),
  duplicateItems: z.number().int(),
  errorReport: z.record(z.string(), z.unknown()).nullable(),
  createdById: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbExportJobSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  scopeType: z.string(),
  scopeId: z.number().int().nullable(),
  format: z.enum(["markdown", "html"]),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  fileKey: z.string().nullable(),
  expiresAt: nullableWireDate(),
  createdById: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const kbImportJobListSchema = z.array(kbImportJobSchema);
export const kbExportJobListSchema = z.array(kbExportJobSchema);

export const kbImportResultSchema = z.object({
  jobId: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  total: z.number().int(),
});

export const kbExportResultSchema = z.object({
  jobId: z.number().int(),
  format: z.enum(["markdown", "html"]),
  content: z.string(),
});

export const kbMediaUploadSchema = z.object({
  key: z.string(),
  size: z.number().int(),
  mimeType: z.string(),
  sha256: z.string(),
  name: z.string(),
});

export const kbSpaceMemberSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  spaceId: z.number().int(),
  membershipId: z.number().int().nullable(),
  role: z.string().nullable(),
  team: z.string().nullable(),
  spaceRole: z.string(),
  createdAt: wireDate(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  userImage: z.string().nullable(),
});

export const kbSpaceMemberListSchema = z.array(kbSpaceMemberSchema);

export const kbSpaceMemberSuccessSchema = z.object({ success: z.boolean() });

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
  status: z.enum(["pending", "approved", "rejected", "expired"]),
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

export const kbPageReviewListSchema = z.array(kbPageReviewWithContextSchema);

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
  sortOrder: z.number().int().nullable(),
  visibility: z.string(),
  createdById: z.string().nullable(),
  status: z.string(),
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

const kbSpaceRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  audience: z.enum(["internal", "public", "mixed"]),
  icon: z.string().nullable(),
  branding: z.record(z.string(), z.unknown()).nullable(),
  isPublicHelpCenter: z.boolean(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
  type: z.string(),
  color: z.string().nullable(),
  defaultVisibility: z.string(),
  owningTeamId: z.string().nullable(),
  archivedAt: nullableWireDate(),
});

export const kbSpaceListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  audience: z.enum(["internal", "public", "mixed"]),
  icon: z.string().nullable(),
  isPublicHelpCenter: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  articleCount: z.number().int(),
});

export const kbSpaceListSchema = z.array(kbSpaceListItemSchema);

export const kbSpaceFullSchema = kbSpaceRowSchema;

export const kbSpaceSuccessSchema = z.object({ success: z.boolean() });

export const kbSourceListItemSchema = z.object({
  id: z.number().int(),
  kind: z.string(),
  title: z.string(),
  mimeType: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  fileUrl: z.string().nullable(),
  status: z.string(),
  chunkCount: z.number().int(),
  errorMessage: z.string().nullable(),
  spaceId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const kbSourcePageSchema = cursorPageSchema(kbSourceListItemSchema);

export const kbSourceSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  spaceId: z.number().int().nullable(),
  kind: z.string(),
  title: z.string(),
  fileKey: z.string().nullable(),
  fileUrl: z.string().nullable(),
  mimeType: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  noteText: z.string().nullable(),
  status: z.string(),
  chunkCount: z.number().int(),
  errorMessage: z.string().nullable(),
  createdById: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const kbSourceSuccessSchema = z.object({ success: z.boolean() });

export const kbPublicPageSchema = z.object({
  title: z.string(),
  icon: z.string().nullable(),
  coverImage: z.string().nullable(),
  content: kbPageContentSchema,
  updatedAt: wireDate(),
});
