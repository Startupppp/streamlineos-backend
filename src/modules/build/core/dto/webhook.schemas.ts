import { z } from "zod";
import { optionalPageSizeField } from "../../../../common/pagination/list-query.schema";

const webhookUrlField = z.string().url();
const webhookEventsField = z.array(z.string().min(1)).min(1);

export const createWebhookSchema = z.object({
  url: webhookUrlField,
  events: webhookEventsField,
  secret: z.string().optional(),
}).strict();

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z.object({
  version: z.number().int().positive(),
  url: webhookUrlField.optional(),
  events: webhookEventsField.optional(),
  isActive: z.boolean().optional(),
}).strict().refine(
  (data) => data.url !== undefined || data.events !== undefined || data.isActive !== undefined,
  { message: "Provide at least one of url, events or isActive" },
);

export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

export const listWebhooksQuerySchema = z.object({
  state: z.enum(["active", "inactive"]).optional(),
  event: z.string().optional(),
  q: z.string().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: optionalPageSizeField(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).strict().refine(
  (data) =>
    data.from === undefined ||
    data.to === undefined ||
    data.to.getTime() >= data.from.getTime(),
  { path: ["to"], message: "to must be the same as or later than from" },
);

export type ListWebhooksQuery = z.infer<typeof listWebhooksQuerySchema>;
