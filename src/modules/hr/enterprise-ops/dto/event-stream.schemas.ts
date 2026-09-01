import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
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
