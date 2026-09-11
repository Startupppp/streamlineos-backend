import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listProjectCustomersSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20),
  search: z.string().optional(),
}).strict();

export type ListProjectCustomersInput = z.infer<typeof listProjectCustomersSchema>;
