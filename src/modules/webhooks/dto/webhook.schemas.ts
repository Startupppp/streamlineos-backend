import { z } from "zod";
import { isPubliclyRoutableUrl } from "../../../common/security/safe-external-url";

export const WEBHOOK_RESPONSE_BODY_LIMIT = 2000;

const PRIVATE_URL_MESSAGE =
  "URL must be a public http(s) endpoint; private, loopback, link-local and metadata addresses are not allowed";

const webhookUrl = z
  .string()
  .url()
  .refine(isPubliclyRoutableUrl, { message: PRIVATE_URL_MESSAGE });

export const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const logsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
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
