import { z } from "zod";
export const videoSignalSchema = z.object({
  type: z.enum(["offer", "answer", "ice-candidate"]),
  targetUserId: z.string().min(1),
  payload: z.unknown(),
});
export type VideoSignalInput = z.infer<typeof videoSignalSchema>;
