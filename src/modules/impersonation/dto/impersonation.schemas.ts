import { z } from "zod";

export const startImpersonationSchema = z.object({
  targetUserId: z.string().uuid(),
});

export const stopImpersonationSchema = z.object({});

export type StartImpersonationInput = z.infer<typeof startImpersonationSchema>;
