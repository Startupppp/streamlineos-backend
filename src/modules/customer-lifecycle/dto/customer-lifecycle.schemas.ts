import { z } from "zod";

/**
 * The list bound, as a refusal rather than a clamp.
 *
 * A limit above the cap is a 400 and not a silently smaller page: a caller that
 * asked for a thousand and got two hundred without being told will page wrongly
 * and quietly lose rows. The platform's rule everywhere else is the same.
 */
export const listLifecyclesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListLifecyclesQuery = z.infer<typeof listLifecyclesQuerySchema>;

export const listSignalsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListSignalsQuery = z.infer<typeof listSignalsQuerySchema>;
