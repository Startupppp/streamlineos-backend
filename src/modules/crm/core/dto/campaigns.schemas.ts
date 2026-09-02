import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const campaignListSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 50),
  status: z.string().optional(),
}).strict();

/**
 * Every optional field is `.nullish()`, not `.optional()`. The columns are
 * nullable and the campaign sheet sends `values.x || null` for each, but
 * `.optional()` accepts only `undefined` — so a blank channel or date made the
 * whole request 400. `budgetAllocated` is coerced because it arrives as the raw
 * string from a text input; `.nullish()` short-circuits before coercion, so
 * `null` stays null instead of becoming 0 and failing `.positive()`.
 */
export const campaignCreateSchema = z
  .object({
    name: z.string().min(1, "Name required").max(200),
    channel: z.string().nullish(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
    utmCampaignKey: z.string().nullish(),
    budgetAllocated: z.coerce.number().positive().nullish(),
    description: z.string().nullish(),
    targetAudience: z.string().nullish(),
    ownerId: z.string().nullish(),
  })
  .strict();

export const campaignUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    channel: z.string().nullish(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
    utmCampaignKey: z.string().nullish(),
    budgetAllocated: z.coerce.number().positive().nullish(),
    status: z.enum(["active", "paused", "completed", "draft"]).optional(),
    description: z.string().nullish(),
    targetAudience: z.string().nullish(),
    ownerId: z.string().nullish(),
  })
  .strict();

export type CampaignListQuery = z.infer<typeof campaignListSchema>;
export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdateInput = z.infer<typeof campaignUpdateSchema>;
