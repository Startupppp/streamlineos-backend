import { z } from "zod";
import {
  wireDate,
  nullableWireDate,
} from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

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
  archivedAt: nullableWireDate(),
  articleCount: z.number().int(),
  pageCount: z.number().int(),
  memberCount: z.number().int(),
});

export const kbSpaceListSchema = z.array(kbSpaceListItemSchema);
export const kbSpaceListPageSchema = cursorPageSchema(kbSpaceListItemSchema);

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

export const kbSpaceArchiveImpactSchema = z.object({
  pageCount: z.number().int(),
  publicLinkCount: z.number().int(),
  recordLinkCount: z.number().int(),
  askIndexed: z.boolean(),
});
