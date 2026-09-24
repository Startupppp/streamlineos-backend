import { z } from "zod";

export const listAffectedTicketsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const linkAffectedTicketSchema = z
  .object({
    ticketId: z.number().int().positive(),
  })
  .strict();

export type ListAffectedTicketsQuery = z.infer<typeof listAffectedTicketsQuerySchema>;
export type LinkAffectedTicketInput = z.infer<typeof linkAffectedTicketSchema>;
