import { z } from "zod";

export const laborTaskKindSchema = z.enum(["PICK", "PUTAWAY", "COUNT", "RECEIVE"]);

export const laborBoardQuerySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    taskKind: laborTaskKindSchema.optional(),
    /**
     * The window, in days. Defaults to a week - a shift board that averages a
     * quarter tells a supervisor nothing about today, which is the only day they
     * can change.
     */
    windowDays: z.coerce.number().int().positive().max(365).default(7),
  })
  .strict();

export const laborRecentQuerySchema = z
  .object({
    userId: z.string().min(1).max(128),
    // Capped at the platform's hard limit (§3: "All list endpoints paginated,
    // hard cap 100/page"). Was 200, and `labor.service.ts` passes this straight
    // into `.limit(limit)` with no clamp of its own.
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();

export type LaborBoardQuery = z.infer<typeof laborBoardQuerySchema>;
export type LaborRecentQuery = z.infer<typeof laborRecentQuerySchema>;
