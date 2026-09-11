import { z } from "zod";

export const HUDDLE_INVITE_MAX_TARGETS = 10;

export const kickSchema = z.object({ targetUserId: z.string().min(1) }).strict();

export const huddleInviteSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(HUDDLE_INVITE_MAX_TARGETS),
}).strict();

export type KickInput = z.infer<typeof kickSchema>;
export type HuddleInviteInput = z.infer<typeof huddleInviteSchema>;
