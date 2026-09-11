import { z } from "zod";

export const chatInviteLinkMintSchema = z
  .object({
    ttlSeconds: z.number().int().positive().optional(),
    maxUses: z.number().int().positive().optional(),
  })
  .strict();

export type ChatInviteLinkMintOptions = z.infer<
  typeof chatInviteLinkMintSchema
>;
