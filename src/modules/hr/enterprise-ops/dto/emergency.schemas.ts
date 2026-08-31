import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

const paginationSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
});

export const createEmergencyEventSchema = z.object({
  name: z.string().min(1).max(300),
  type: z.enum(["office_closure", "disaster", "safety_check", "other"]),
  locationId: z.string().optional(),
  message: z.string().min(1).max(10000),
});

export const updateEmergencyEventSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  message: z.string().min(1).max(10000).optional(),
  status: z.enum(["active", "resolved"]).optional(),
});

export const listEmergencyEventsSchema = paginationSchema.extend({
  status: z.enum(["active", "resolved"]).optional(),
});

export const broadcastSchema = z.object({
  message: z.string().min(1).max(10000).optional(),
});

export const respondSchema = z.object({
  status: z.enum(["safe", "need_help"]),
  note: z.string().max(2000).optional(),
});

export type CreateEmergencyEventInput = z.infer<typeof createEmergencyEventSchema>;
export type UpdateEmergencyEventInput = z.infer<typeof updateEmergencyEventSchema>;
export type ListEmergencyEventsInput = z.infer<typeof listEmergencyEventsSchema>;
export type BroadcastInput = z.infer<typeof broadcastSchema>;
export type RespondInput = z.infer<typeof respondSchema>;
