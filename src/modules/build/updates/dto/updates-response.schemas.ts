import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const updateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  authorMembershipId: z.number().int(),
  authorName: z.string(),
  body: z.string(),
  wins: z.string().nullable(),
  risks: z.string().nullable(),
  next: z.string().nullable(),
  citations: z.string().nullable(),
  status: z.enum(["draft", "published"]),
  audience: z.enum(["internal", "client"]),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const cursorPaginationSchema = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const updateListPageSchema = z.object({
  data: z.array(updateRowSchema),
  pagination: cursorPaginationSchema,
});
