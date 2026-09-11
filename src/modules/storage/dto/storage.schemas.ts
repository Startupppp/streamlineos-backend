import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const kbAttachmentsQuerySchema = z.object({
  org: z.string().min(1),
  page: pageNumberField,
  limit: pageSizeField(20, 100),
}).strict();
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

export const downloadQuerySchema = z
  .object({
    url: z.string().url().max(2000).optional(),
    key: z.string().min(1).max(1000).optional(),
    expiresIn: z.coerce.number().int().min(60).max(86400).default(3600),
    attachment: z.enum(["0", "1"]).optional(),
  })
  .strict()
  .refine((d) => d.url !== undefined || d.key !== undefined, {
    message: "url or key is required",
  });
export type DownloadQueryInput = z.infer<typeof downloadQuerySchema>;

export const imageQuerySchema = z
  .object({
    key: z.string().min(1).max(1000),
  })
  .strict();
export type ImageQueryInput = z.infer<typeof imageQuerySchema>;

export const uploadBodySchema = z.object({ type: onboardingDocTypeSchema });
export type UploadBodyInput = z.infer<typeof uploadBodySchema>;
