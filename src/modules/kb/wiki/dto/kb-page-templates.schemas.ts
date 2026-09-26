import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listPageTemplatesQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: pageSizeField(50),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type ListPageTemplatesQuery = z.infer<typeof listPageTemplatesQuerySchema>;

export const createPageTemplateSchema = z.object({
  fromPageId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
}).strict();
export type CreatePageTemplateInput = z.infer<typeof createPageTemplateSchema>;

export const updatePageTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: "At least one field must be provided",
  });
export type UpdatePageTemplateInput = z.infer<typeof updatePageTemplateSchema>;
