import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const rangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).strict();
export type RangeInput = z.infer<typeof rangeSchema>;

export const overviewQuerySchema = rangeSchema.extend({
  spaceId: z.coerce.number().int().positive().optional(),
});
export type OverviewQueryInput = z.infer<typeof overviewQuerySchema>;

export const pageAnalyticsQuerySchema = z
  .object({
    spaceId: z.coerce.number().int().positive().optional(),
    staleOnly: queryBoolean.optional(),
    cursor: z.string().optional(),
    limit: pageSizeField(50),
  })
  .strict();
export type PageAnalyticsQueryInput = z.infer<typeof pageAnalyticsQuerySchema>;
