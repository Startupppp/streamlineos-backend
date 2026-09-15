import { z } from "zod";

export const startImpersonationResponseSchema = z.object({
  token: z.string(),
  targetUser: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
  }),
  expiresAt: z.string(),
  impersonationSessionId: z.string(),
});

export const stopImpersonationResponseSchema = z.object({
  success: z.boolean(),
});

export type StartImpersonationResponse = z.infer<typeof startImpersonationResponseSchema>;
export type StopImpersonationResponse = z.infer<typeof stopImpersonationResponseSchema>;
