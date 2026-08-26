import { z } from "zod";

const PAGE_SIZE_CAP = 100;

export const baseListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(50)
    .transform((v) => Math.min(v, PAGE_SIZE_CAP)),
  cursor: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export type BaseListQuery = z.infer<typeof baseListQuerySchema>;

export function withSortField<const T extends [string, ...string[]]>(
  sortFields: T,
) {
  return baseListQuerySchema.extend({
    sortField: z.enum(sortFields).optional(),
  });
}
