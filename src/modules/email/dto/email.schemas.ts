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
});

export type DispatchInput = z.infer<typeof dispatchSchema>;

export const resendInvitationSchema = z.object({
  invitationId: z.string().min(1),
});

export type ResendInvitationInput = z.infer<typeof resendInvitationSchema>;

export const emailTemplateTestSchema = z.object({
  templateId: z.string().min(1),
  testEmail: z.string().email(),
});

export type EmailTemplateTestInput = z.infer<typeof emailTemplateTestSchema>;
