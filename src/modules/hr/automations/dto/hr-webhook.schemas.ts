import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";
import { HR_AUTOMATION_EVENTS } from "../hr-automation-events";

const HTTPS_URL = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), "Webhook URL must use HTTPS");

export const createHrWebhookSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(150),
  url: HTTPS_URL,
  events: z
    .array(z.enum(HR_AUTOMATION_EVENTS))
    .min(1, "Select at least one event"),
  isActive: z.boolean().default(true),
}).strict();

export const updateHrWebhookSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  url: HTTPS_URL.optional(),
  events: z.array(z.enum(HR_AUTOMATION_EVENTS)).min(1).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const listDeliveriesSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();

export type CreateHrWebhookInput = z.infer<typeof createHrWebhookSchema>;
export type UpdateHrWebhookInput = z.infer<typeof updateHrWebhookSchema>;
export type ListDeliveriesInput = z.infer<typeof listDeliveriesSchema>;
