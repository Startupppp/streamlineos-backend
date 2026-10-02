import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const rangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).strict();
export type RangeInput = z.infer<typeof rangeSchema>;

export const rangeWithSpaceSchema = rangeSchema.extend({
  spaceId: z.coerce.number().int().positive().optional(),
}).strict();
export type RangeWithSpaceInput = z.infer<typeof rangeWithSpaceSchema>;

export const overviewQuerySchema = rangeSchema.extend({
  spaceId: z.coerce.number().int().positive().optional(),
  scope: z.enum(["support", "wiki"]).default("support"),
}).strict();
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

export const gapsQuerySchema = rangeSchema.extend({
  cursor: z.string().optional(),
  limit: pageSizeField(50),
}).strict();
export type GapsQueryInput = z.infer<typeof gapsQuerySchema>;

export const gapRelatedPagesQuerySchema = z
  .object({
    query: z.string().min(1).max(500),
    cursor: z.string().optional(),
    limit: pageSizeField(20),
  })
  .strict();
export type GapRelatedPagesQuery = z.infer<typeof gapRelatedPagesQuerySchema>;

export const gapAssignBodySchema = z
  .object({
    query: z.string().min(1).max(500),
    assigneeUserId: z.string().min(1),
  })
  .strict();
export type GapAssignBody = z.infer<typeof gapAssignBodySchema>;

export const gapDismissBodySchema = z
  .object({
    query: z.string().min(1).max(500),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type GapDismissBody = z.infer<typeof gapDismissBodySchema>;

export const gapCreateFixBodySchema = z
  .object({
    query: z.string().min(1).max(500),
    spaceId: z.number().int().positive().optional(),
  })
  .strict();
export type GapCreateFixBody = z.infer<typeof gapCreateFixBodySchema>;
