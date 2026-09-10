import { z } from "zod";

export const createRosterSchema = z.object({
  name: z.string().min(1).max(100),
  weekStart: z.string().min(1),
  weekEnd: z.string().min(1),
});

export const upsertRosterEntrySchema = z.object({
  userId: z.string().min(1),
  shiftId: z.number().int().positive().optional(),
  date: z.string().min(1),
  isDayOff: z.boolean().optional(),
  notes: z.string().max(500).optional(),
});

export type CreateRosterInput = z.infer<typeof createRosterSchema>;
export type UpsertRosterEntryInput = z.infer<typeof upsertRosterEntrySchema>;
