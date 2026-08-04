import { z } from "zod";

export const createDelegationSchema = z
  .object({
    delegateeId: z.string().min(1),
    permissions: z.array(z.string().min(1)).min(1),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export type CreateDelegationInput = z.infer<typeof createDelegationSchema>;
