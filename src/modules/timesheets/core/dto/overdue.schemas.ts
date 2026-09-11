import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

/**
 * TS-11. The overdue queue's query.
 *
 * `asOf` exists for the same reason the reminder sweep takes a date: the
 * arithmetic is in whole UTC days, and a queue that reads the clock per row can
 * straddle midnight and disagree with itself halfway down the page. Fixing it
 * once at the top makes the whole response answer for a single date, and lets a
 * test assert a number instead of a range.
 */
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
