import { z } from "zod";

export const createUserApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string().min(1)).default([]),
  expiresAt: z.coerce.date().optional(),
});

export type CreateUserApiTokenInput = z.infer<typeof createUserApiTokenSchema>;
