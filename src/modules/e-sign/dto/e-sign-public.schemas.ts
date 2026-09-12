import { z } from "zod";

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
