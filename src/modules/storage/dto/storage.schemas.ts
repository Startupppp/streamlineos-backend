import { z } from "zod";

export const kbAttachmentsQuerySchema = z.object({ org: z.string().min(1) });
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
