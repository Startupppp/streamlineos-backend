import { z } from "zod";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const startTimerSchema = z.object({
  projectId: z.number().int().positive().optional(),
  ticketId: z.number().int().positive().optional(),
  description: z.string().max(500).optional(),
  billable: z.boolean().optional(),
}).strict();
export type StartTimerInput = z.infer<typeof startTimerSchema>;

export const convertTimerSchema = z.object({
  date: dateString.optional(),
  hours: z.number().positive().optional(),
  isBillable: z.boolean().optional(),
  description: z.string().max(2000).optional(),
}).strict();
export type ConvertTimerInput = z.infer<typeof convertTimerSchema>;
