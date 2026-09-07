import { z, type ZodType } from "zod";

export function cursorPageSchema<T extends ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    pagination: z.object({
      limit: z.number().int(),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  });
}

export function idCursorPageSchema<T extends ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    hasMore: z.boolean(),
    nextCursor: z.number().int().nullable(),
  });
}

export function itemsTotalSchema<T extends ZodType>(item: T) {
  return z.object({ items: z.array(item), total: z.number().int() });
}

export function itemsPagedSchema<T extends ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    totalPages: z.number().int(),
  });
}

export const successSchema = z.object({ success: z.literal(true) });

export const idSchema = z.object({ id: z.string() });

export const numericIdSchema = z.object({ id: z.number().int() });
