import { z } from "zod";

export const emailTemplatePreviewResponseSchema = z.array(
  z.object({
    id: z.string(),
    category: z.string(),
    name: z.string(),
    subject: z.string(),
    html: z.string(),
    version: z.number().int().positive(),
    locale: z.string(),
    supportedLocales: z.array(z.string()),
  }),
);

export const emailTemplateTestResponseSchema = z.object({
  sent: z.literal(true),
  to: z.string(),
  templateId: z.string(),
  locale: z.string(),
  version: z.number().int().positive(),
});

export const hrSendEmailResponseSchema = z.object({
  sent: z.literal(true),
  to: z.string(),
  subject: z.string(),
});

const channelResultSchema = z.object({
  channel: z.enum(["email", "sms", "whatsapp"]),
  sent: z.boolean(),
  sid: z.string().optional(),
  reason: z.string().optional(),
});

export const notificationsDispatchResponseSchema = z.object({
  results: z.array(channelResultSchema),
  allFailed: z.boolean(),
});

export const unsubscribeGetResponseSchema = z.union([
  z.object({ ok: z.literal(false), applied: z.literal(false), message: z.string() }),
  z.object({ ok: z.literal(true), applied: z.literal(false), scope: z.string(), message: z.string() }),
]);

export const unsubscribePostResponseSchema = z.union([
  z.object({ ok: z.literal(false), applied: z.literal(false), message: z.string() }),
  z.object({ ok: z.literal(true), applied: z.literal(false), scope: z.string(), message: z.string() }),
  z.object({ ok: z.literal(true), applied: z.literal(true), scope: z.string(), message: z.string() }),
]);
