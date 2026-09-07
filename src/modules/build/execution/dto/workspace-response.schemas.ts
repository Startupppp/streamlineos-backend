import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const milestoneRowSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int().nullable(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  targetDate: z.string().nullable(),
  status: z.string().nullable(),
  createdBy: z.string().nullable(),
  clientVisible: z.boolean(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const intakeItemSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int().nullable(),
  orgId: z.string(),
  title: z.string(),
  description: z.unknown(),
  source: z.string(),
  status: z.string(),
  submitterEmail: z.string().nullable(),
  submitterName: z.string().nullable(),
  priority: z.string().nullable(),
  requestType: z.string().nullable(),
  linkedWorkItemId: z.number().int().nullable(),
  declineReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const intakeListSchema = z.object({
  data: z.array(intakeItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const viewRowSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int().nullable(),
  orgId: z.string(),
  createdBy: z.string().nullable(),
  name: z.string(),
  filters: z.unknown(),
  groupBy: z.string().nullable(),
  orderBy: z.string().nullable(),
  layoutType: z.string(),
  isPinned: z.boolean(),
  visibility: z.string().nullable(),
  displayOptions: z.unknown(),
  scope: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const whiteboardShareSchema = z.object({
  userId: z.string(),
  role: z.string(),
  name: z.string().nullable(),
  email: z.string(),
});

const whiteboardSharingInfoSchema = z.object({
  visibility: z.string(),
  publicAccess: z.string().nullable(),
  shareToken: z.string().nullable(),
  linkExpiresAt: nullableWireDate(),
  allowExport: z.boolean(),
});

export const whiteboardListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  elementCount: z.number().int(),
  visibility: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: wireDate(),
});

export const whiteboardHubItemSchema = whiteboardListItemSchema.extend({
  projectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
});

export const whiteboardDetailSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int().nullable(),
  name: z.string(),
  data: z.unknown(),
  visibility: z.string(),
  access: z.enum(["view", "edit", "manage"]),
  sharing: whiteboardSharingInfoSchema.nullable(),
  shares: z.array(whiteboardShareSchema).nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const whiteboardSharingUpdateSchema = z.object({
  visibility: z.string(),
  publicAccess: z.string().nullable(),
  shareToken: z.string().nullable(),
  linkExpiresAt: nullableWireDate(),
  allowExport: z.boolean(),
});

export const whiteboardSharesSchema = z.array(whiteboardShareSchema);

export const publicWhiteboardSchema = z.object({
  name: z.string(),
  data: z.unknown(),
  access: z.enum(["edit", "view"]),
  allowExport: z.boolean(),
  updatedAt: wireDate(),
});

export const publicWhiteboardUpdateSchema = z.object({
  success: z.literal(true),
  updatedAt: wireDate(),
});

