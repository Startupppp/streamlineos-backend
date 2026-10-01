import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { DB_ENUMS } from "../../../../db/enums.generated";

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
  status: z.enum(DB_ENUMS.project_update_status),
  audience: z.enum(DB_ENUMS.project_update_audience),
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
