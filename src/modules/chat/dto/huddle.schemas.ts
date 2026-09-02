import { z } from "zod";

import { HUDDLE_MESH_MAX_PARTICIPANTS } from "../../billing/core/plan-entitlements.constants";

export const huddleSignalSchema = z.object({
  type: z.enum(["offer", "answer", "ice-candidate"]),
  targetUserId: z.string().min(1),
  payload: z.unknown(),
}).strict();

export const muteSchema = z.object({ muted: z.boolean() }).strict();
export const raiseHandSchema = z.object({ raised: z.boolean() }).strict();
export const deafenSchema = z.object({ deafened: z.boolean() }).strict();

export const screenShareSchema = z.object({ isScreenSharing: z.boolean() }).strict();
export const kickSchema = z.object({ targetUserId: z.string().min(1) }).strict();

export const huddleInviteSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(HUDDLE_MESH_MAX_PARTICIPANTS),
}).strict();

export type HuddleSignalInput = z.infer<typeof huddleSignalSchema>;
export type MuteInput = z.infer<typeof muteSchema>;
export type RaiseHandInput = z.infer<typeof raiseHandSchema>;
export type DeafenInput = z.infer<typeof deafenSchema>;
export type ScreenShareInput = z.infer<typeof screenShareSchema>;
export type KickInput = z.infer<typeof kickSchema>;
export type HuddleInviteInput = z.infer<typeof huddleInviteSchema>;
