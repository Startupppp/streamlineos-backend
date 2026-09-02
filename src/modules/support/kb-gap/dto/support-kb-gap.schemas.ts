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
