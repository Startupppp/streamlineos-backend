import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { ATTACHABLE_DOCUMENT_TYPES } from "../../../../db/schema";

/**
 * What the attachments surface returns — `AttachmentView` and its page.
 *
 * The bytes route is not here: it writes to the `Response` itself, so it
 * declares a binary body with `@ApiOkResponse` instead.
 */

const attachmentSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  documentType: z.enum(ATTACHABLE_DOCUMENT_TYPES),
  documentId: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  /** Null while object storage is absent and the bytes live in the row. */
  storageUrl: z.string().nullable(),
  uploadedBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const getAttachmentResponseSchema = attachmentSchema;
export const attachDocumentFileResponseSchema = attachmentSchema;

export const listAttachmentsResponseSchema = z.object({
  items: z.array(attachmentSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

/** Soft delete: the file leaves the list and the document is untouched. */
export const removeAttachmentResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
