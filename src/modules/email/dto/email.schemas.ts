import { z } from "zod";

export const dispatchSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  channels: z
    .array(z.enum(["email", "sms", "whatsapp"]))
    .min(1)
    .default(["email"]),
  whatsappSmsFallback: z.boolean().default(true),
}).strict();

export type DispatchInput = z.infer<typeof dispatchSchema>;

export const emailTemplateTestSchema = z.object({
  templateId: z.string().min(1),
  testEmail: z.string().email(),
  locale: z.string().min(2).max(35).default("en"),
}).strict();

export type EmailTemplateTestInput = z.infer<typeof emailTemplateTestSchema>;

export const sendEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  templateId: z.number().int().positive().optional(),
  candidateId: z.number().int().positive().optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

export type SendEmailInput = z.infer<typeof sendEmailSchema>;
