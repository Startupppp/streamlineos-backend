import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  expiresAt: z.coerce
    .date()
    .refine((value) => value.getTime() > Date.now(), {
      message: "Expiration must be in the future",
    })
    .refine(
      (value) => value.getTime() <= Date.now() + 90 * 24 * 60 * 60 * 1000,
      { message: "CRM API keys cannot exceed 90 days" },
    ),
}).strict();

export const listApiTokensSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
});

export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
export type ListApiTokensQuery = z.infer<typeof listApiTokensSchema>;
