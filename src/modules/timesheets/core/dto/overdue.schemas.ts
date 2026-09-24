import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const overdueQuerySchema = z
  .object({
    userId: z.string().optional(),
    asOf: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    page: pageNumberField,
    limit: pageSizeField(50, 100),
  })
  .strict();

export type OverdueQuery = z.infer<typeof overdueQuerySchema>;
