import { z } from "zod";

export const publishPublicFormSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens"),
  accessCode: z.string().trim().min(4).max(50).optional(),
  maxSubmissions: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  completionRedirectUrl: z.string().trim().url().optional(),
  webhookUrl: z.string().trim().url().optional(),
  embedAllowed: z.boolean().default(false),
}).strict();
export type PublishPublicFormInput = z.infer<typeof publishPublicFormSchema>;

export const publicAuthSchema = z.object({
  accessCode: z.string().trim().max(50).optional(),
  otpCode: z.string().trim().max(10).optional(),
}).strict();
export type PublicAuthInput = z.infer<typeof publicAuthSchema>;

export const publicConsentSchema = z.object({
  disclosureVersion: z.string().trim().min(1).max(50),
}).strict();
export type PublicConsentInput = z.infer<typeof publicConsentSchema>;

export const publicFieldValueSchema = z.object({
  value: z.union([z.string().max(5000), z.boolean(), z.null()]),
}).strict();
export type PublicFieldValueInput = z.infer<typeof publicFieldValueSchema>;

export const adoptSignatureSchema = z.object({
  assetType: z.enum(["signature", "initials", "stamp"]),
  method: z.enum(["drawn", "typed", "uploaded", "saved"]),
  imageDataUrl: z.string().trim().max(2_000_000).optional(),
  typedText: z.string().trim().max(200).optional(),
  typedFontStyle: z.string().trim().max(100).optional(),
}).strict();
export type AdoptSignatureInput = z.infer<typeof adoptSignatureSchema>;

export const declineSchema = z.object({
  reason: z.string().trim().min(1, "Decline reason is required").max(1000),
}).strict();
export type DeclineInput = z.infer<typeof declineSchema>;

export const publicFormSubmitSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  phone: z.string().trim().max(30).optional(),
  accessCode: z.string().trim().max(50).optional(),
}).strict();
export type PublicFormESignSubmitInput = z.infer<typeof publicFormSubmitSchema>;
