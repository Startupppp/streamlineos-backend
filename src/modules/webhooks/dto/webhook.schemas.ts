import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";
import { assertSafeWebhookUrl } from "../../../common/security/ssrf-guard";

export const WEBHOOK_RESPONSE_BODY_LIMIT = 2000;

const PRIVATE_URL_MESSAGE =
  "URL must be a public http(s) endpoint; private, loopback, link-local and metadata addresses are not allowed";

function isSyntacticallySafeUrl(value: string): boolean {
  try {
    assertSafeWebhookUrl(value);
    return true;
  } catch {
    return false;
  }
}

const webhookUrl = z
  .string()
  .url()
  .refine(isSyntacticallySafeUrl, { message: PRIVATE_URL_MESSAGE });

export const listSchema = z
  .object({
    page: pageNumberField,
    limit: pageSizeField(20),
  })
  .strict();

export const logsSchema = z
  .object({
    page: pageNumberField,
    limit: pageSizeField(20),
  })
  .strict();

export const createSchema = z
  .object({
    url: webhookUrl,
    description: z.string().optional(),
    events: z.array(z.string()).default([]),
  })
  .strict();

export const updateSchema = z
  .object({
    url: webhookUrl.optional(),
    description: z.string().optional(),
    events: z.array(z.string()).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type ListInput = z.infer<typeof listSchema>;
export type LogsInput = z.infer<typeof logsSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
