import { z } from "zod";

export const burnupQuerySchema = z.object({
  sprintId: z.string().regex(/^\d+$/).optional(),
}).strict();

export const cfdQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).default(30),
}).strict();

export type BurnupQuery = z.infer<typeof burnupQuerySchema>;
export type CfdQuery = z.infer<typeof cfdQuerySchema>;
