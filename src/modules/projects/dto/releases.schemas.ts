import { z } from "zod";

export const createReleaseSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  description: z.string().optional().nullable(),
  status: z.enum(["draft", "released", "archived"]).default("draft"),
  releaseDate: z.string().optional().nullable(),
});

export const updateReleaseSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  version: z.string().min(1).max(50).optional(),
  description: z.string().optional().nullable(),
  status: z.enum(["draft", "released", "archived"]).optional(),
  releaseDate: z.string().optional().nullable(),
});

export const addReleaseTicketSchema = z.object({
  ticketId: z.number().int(),
});

export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;
export type UpdateReleaseInput = z.infer<typeof updateReleaseSchema>;
export type AddReleaseTicketInput = z.infer<typeof addReleaseTicketSchema>;
