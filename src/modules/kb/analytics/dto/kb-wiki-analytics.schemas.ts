import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const wikiAnalyticsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: pageSizeField(50),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    spaceId: z.coerce.number().int().positive().optional(),
  })
  .strict();

export type WikiAnalyticsQuery = z.infer<typeof wikiAnalyticsQuerySchema>;

const wikiPageStatItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  spaceId: z.number().int().nullable(),
  status: z.enum(["draft", "in_review", "published", "archived"]),
  trustState: z.enum(["unverified", "verified", "verification_expired"]),
  uniqueViewers: z.number().int(),
  updatedAt: wireDate(),
});

export type WikiPageStatItem = z.infer<typeof wikiPageStatItemSchema>;

export const wikiPageStatsPageSchema = cursorPageSchema(wikiPageStatItemSchema);

const wikiStalePageItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  spaceId: z.number().int().nullable(),
  status: z.enum(["draft", "in_review", "published", "archived"]),
  uniqueViewers: z.number().int(),
  updatedAt: wireDate(),
  ownerMembershipId: z.number().int().nullable(),
});

export type WikiStalePageItem = z.infer<typeof wikiStalePageItemSchema>;

export const wikiStalePagesPageSchema = cursorPageSchema(wikiStalePageItemSchema);

const wikiContributorItemSchema = z.object({
  membershipId: z.number().int().nullable(),
  editCount: z.number().int(),
});

export type WikiContributorItem = z.infer<typeof wikiContributorItemSchema>;

export const wikiContributorListSchema = z.array(wikiContributorItemSchema);
