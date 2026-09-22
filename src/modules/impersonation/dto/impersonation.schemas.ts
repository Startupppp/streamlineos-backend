import { z } from "zod";

export const startImpersonationSchema = z.object({
  targetUserId: z.string().uuid(),
});

export type StartImpersonationInput = z.infer<typeof startImpersonationSchema>;
