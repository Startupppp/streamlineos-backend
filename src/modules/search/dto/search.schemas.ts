import { z } from "zod";

import { pageSizeField } from "../../../common/pagination/list-query.schema";

export const searchQuerySchema = z.object({
  q: z.string().min(2, "Query must be at least 2 characters"),
  limit: pageSizeField(5, 10),
});

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
