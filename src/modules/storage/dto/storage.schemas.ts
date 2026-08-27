import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const kbAttachmentsQuerySchema = z.object({
  org: z.string().min(1),
  page: pageNumberField,
  limit: pageSizeField(20, 100),
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
