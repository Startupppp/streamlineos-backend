import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listPageTemplatesQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: pageSizeField(50),
  })
  .strict();
export type ListPageTemplatesQuery = z.infer<typeof listPageTemplatesQuerySchema>;

export const createPageTemplateSchema = z.object({
  fromPageId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
}).strict();
export type CreatePageTemplateInput = z.infer<typeof createPageTemplateSchema>;
