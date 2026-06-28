import { z } from "zod";

export const kbAttachmentsQuerySchema = z.object({
  org: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type KbAttachmentsQueryInput = z.infer<typeof kbAttachmentsQuerySchema>;

export const onboardingDocTypeSchema = z.enum([
  "CONTRACT",
  "CERTIFICATE",
  "ID_PROOF",
  "PAYSLIP",
  "POLICY",
  "OFFER_LETTER",
  "RESUME",
  "OTHER",
]);
