import { z } from "zod";

export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
}).strict();

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
