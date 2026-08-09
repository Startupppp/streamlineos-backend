import { z } from "zod";

export const createDelegationSchema = z
  .object({
    delegateeId: z.string().min(1),
    permissions: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(200)
      .refine((items) => new Set(items).size === items.length, {
        message: "Permissions must be unique",
      }),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const listDelegationsQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce
      .number()
      .int()
      .refine((value) => [10, 20, 50].includes(value), {
        message: "Limit must be 10, 20, or 50",
      })
      .default(20),
    search: z.string().trim().max(100).optional(),
  })
  .strict();

export type CreateDelegationInput = z.infer<typeof createDelegationSchema>;
export type ListDelegationsQuery = z.infer<typeof listDelegationsQuerySchema>;
