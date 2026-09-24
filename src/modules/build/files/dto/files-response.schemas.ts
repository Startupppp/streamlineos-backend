import { z } from "zod";
import { nullableWireDate, wireTimestamp } from "../../../../common/openapi/wire-types";

export const fileRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  uploadedByMembershipId: z.number().int(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  createdAt: wireTimestamp(),
  deletedAt: nullableWireDate(),
});

export const fileCursorPaginationSchema = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const fileListPageSchema = z.object({
  data: z.array(fileRowSchema),
  pagination: fileCursorPaginationSchema,
});

export const signedUrlResponseSchema = z.object({
  url: z.string(),
  expiresIn: z.number().int(),
});
