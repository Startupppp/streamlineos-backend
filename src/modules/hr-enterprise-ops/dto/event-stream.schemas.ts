import { z } from "zod";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const listEventsSchema = paginationSchema.extend({
  eventType: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

export const exportEventsSchema = paginationSchema.extend({
  eventType: z.string().optional(),
  entityType: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

export type ListEventsInput = z.infer<typeof listEventsSchema>;
export type ExportEventsInput = z.infer<typeof exportEventsSchema>;
