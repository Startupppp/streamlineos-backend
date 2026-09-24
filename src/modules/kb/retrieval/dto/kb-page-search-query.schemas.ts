import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { wireDate } from "../../../../common/openapi/wire-types";

export const KB_PAGE_FULL_SEARCH_MAX_LIMIT = 50;

export const pageFullSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    spaceId: z.coerce.number().int().positive().optional(),
    status: z
      .enum(["draft", "in_review", "published", "archived"])
      .optional(),
    verified: z.coerce.boolean().optional(),
    facets: z.coerce.boolean().optional().default(false),
    limit: pageSizeField(20, KB_PAGE_FULL_SEARCH_MAX_LIMIT),
  })
  .strict();

export type PageFullSearchQuery = z.infer<typeof pageFullSearchQuerySchema>;

const kbPageFullSearchItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  spaceId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  status: z.string(),
  trustState: z.string(),
  visibility: z.string(),
  contentType: z.string(),
  updatedAt: wireDate(),
  snippet: z.string(),
});

const kbPageFullSearchFacetsSchema = z.object({
  status: z.array(
    z.object({ value: z.string(), count: z.number().int() }),
  ),
  space: z.array(
    z.object({ spaceId: z.number().int().nullable(), count: z.number().int() }),
  ),
});

export const kbPageFullSearchResponseSchema = z.object({
  items: z.array(kbPageFullSearchItemSchema),
  hasMore: z.boolean(),
  limit: z.number().int(),
  facets: kbPageFullSearchFacetsSchema.nullable(),
});

export type KbPageFullSearchResponse = z.infer<
  typeof kbPageFullSearchResponseSchema
>;
