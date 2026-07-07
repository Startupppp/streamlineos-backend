import { z } from "zod";

export const createKbSourceNoteSchema = z.object({
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(200000),
  spaceId: z.number().int().positive().nullable().optional(),
});

export type CreateKbSourceNoteInput = z.infer<typeof createKbSourceNoteSchema>;
