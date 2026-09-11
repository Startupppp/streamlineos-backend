import { z } from "zod";
import { ATTACHABLE_DOCUMENT_TYPES } from "../../../../db/schema";

/**
 * The largest file an attachment may carry, in bytes.
 *
 * The JSON body parser is capped at 3 MB (`main.ts`), and base64 costs 4 bytes
 * per 3 bytes of payload, so 2 MB of file is the largest that fits with room
 * for the envelope. A bigger cap here would fail at the parser instead, with a
 * far worse error.
 */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 1024;

/** Evidence formats. Anything else is rejected before it reaches the bucket. */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export const attachableDocumentTypeSchema = z.enum(ATTACHABLE_DOCUMENT_TYPES);

export const documentIdParamSchema = z.string().trim().min(1).max(128);

/**
 * Base64 rather than multipart on purpose: adding a multipart parser for one
 * endpoint would put a second body-parsing path in front of every accounting
 * route. A `data:` prefix is tolerated because that is what a browser's
 * `FileReader.readAsDataURL` produces.
 */
export const attachDocumentFileSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(ALLOWED_ATTACHMENT_MIME_TYPES)),
    contentBase64: z.string().min(4).max(MAX_BASE64_CHARS),
  })
  .strict();

export const listAttachmentsSchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type AttachDocumentFileInput = z.infer<typeof attachDocumentFileSchema>;
export type ListAttachmentsQuery = z.infer<typeof listAttachmentsSchema>;
