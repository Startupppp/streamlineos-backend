import { z } from "zod";

export const subscribeSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

export const listSubprocessorsQuerySchema = z
  .object({
    /** Retired entries are included by default; a reviewer needs the history. */
    includeRetired: z.coerce.boolean().default(true),
  })
  .strict();

export type SubscribeInput = z.infer<typeof subscribeSchema>;
export type ListSubprocessorsQuery = z.infer<typeof listSubprocessorsQuerySchema>;
