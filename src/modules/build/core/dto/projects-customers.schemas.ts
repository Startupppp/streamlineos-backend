import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listProjectCustomersSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20),
  search: z.string().optional(),
});

export type ListProjectCustomersInput = z.infer<typeof listProjectCustomersSchema>;
