import { z } from "zod";
import { idCursorSchema } from "../../../common/pagination/cursor.schema";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

export const chatPollQuerySchema = z
  .object({
    since: z.string().optional(),
    cursor: idCursorSchema,
    limit: pageSizeField(50),
  })
  .strict()
  .refine((q) => q.since !== undefined || q.cursor !== undefined, {
    message: "Provide 'since' (ISO timestamp) for the initial poll or 'cursor' (channel position) for subsequent pages",
  });

export type ChatPollQuery = z.infer<typeof chatPollQuerySchema>;
