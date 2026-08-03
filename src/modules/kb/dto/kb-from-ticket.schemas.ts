import { z } from "zod";

export const fromTicketSchema = z.object({
  spaceId: z.coerce.number().int().positive(),
});

export type FromTicketInput = z.infer<typeof fromTicketSchema>;

export const kbFromTicketDraftSchema = z.object({
  title: z.string(),
  content: z.string(),
});
