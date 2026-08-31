import { z } from "zod";

export const partyMergeBodySchema = z
  .object({
    leftPartyId: z.string().min(1),
    rightPartyId: z.string().min(1),
  })
  .strict();

export const partyRoleBodySchema = z
  .object({
    role: z.string().min(1),
  })
  .strict();

export type PartyMergeBody = z.infer<typeof partyMergeBodySchema>;
export type PartyRoleBody = z.infer<typeof partyRoleBodySchema>;
