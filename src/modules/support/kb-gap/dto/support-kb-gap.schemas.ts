import { z } from "zod";

import { idCursorSchema } from "../../../../common/pagination/cursor.schema";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listGapsQuerySchema = z
  .object({
    cursor: idCursorSchema,
    limit: pageSizeField(50),
  })
  .strict();

export type ListGapsQuery = z.infer<typeof listGapsQuerySchema>;

export const dismissGapPatchSchema = z
  .object({
    action: z.literal("dismiss"),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type DismissGapPatchInput = z.infer<typeof dismissGapPatchSchema>;
