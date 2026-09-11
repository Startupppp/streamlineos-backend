import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
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

/**
 * PRD-C048 — `GET /hr/webhooks` used to bind `@Query("page")`/`@Query("limit")` raw and
 * clamp them by hand (`Math.min(100, Math.max(1, parseInt(limit ?? "50", 10) || 50))`).
 * A hand-rolled clamp is not a Zod boundary: it is invisible to `@Validate`, so the
 * page-size cap never reached `openapi.json` and no gate could see it. Same shape as
 * `listDeliveriesSchema` below, which the same file already got right.
 */
export const listHrWebhooksSchema = z.object({
  limit: pageSizeField(50, 100),
}).strict();

export const listDeliveriesSchema = z.object({
  limit: pageSizeField(50, 100),
}).strict();

export type CreateHrWebhookInput = z.infer<typeof createHrWebhookSchema>;
export type UpdateHrWebhookInput = z.infer<typeof updateHrWebhookSchema>;
export type ListDeliveriesInput = z.infer<typeof listDeliveriesSchema>;
export type ListHrWebhooksInput = z.infer<typeof listHrWebhooksSchema>;
