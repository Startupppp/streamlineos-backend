import { z } from "zod";

export const huddleSignalSchema = z.object({
  type: z.enum(["offer", "answer", "ice-candidate"]),
  targetUserId: z.string().min(1),
  payload: z.unknown(),
});

export const muteSchema = z.object({ muted: z.boolean() });
export const raiseHandSchema = z.object({ raised: z.boolean() });

export type HuddleSignalInput = z.infer<typeof huddleSignalSchema>;
export type MuteInput = z.infer<typeof muteSchema>;
export type RaiseHandInput = z.infer<typeof raiseHandSchema>;
