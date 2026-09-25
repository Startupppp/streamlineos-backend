import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { DOCUMENT_AUDIENCE_KINDS, KB_LINKED_DOCUMENT_STATUSES, KB_LINKED_DOCUMENT_VERSION_MODES } from "../../../../db/schema/kb/linked-documents";

const linkedDocumentItemSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  documentType: z.string().nullable(),
  effectiveDate: z.string().nullable(),
  version: z.number().int().nullable(),
  publishedAt: wireDate(),
  source: z.literal("HR_DOCUMENT"),
  hasFile: z.boolean(),
  fileName: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  mimeType: z.string().nullable(),
  status: z.enum(KB_LINKED_DOCUMENT_STATUSES),
  versionMode: z.enum(KB_LINKED_DOCUMENT_VERSION_MODES),
  pinnedVersion: z.number().int().nullable(),
});
export type LinkedDocumentItem = z.infer<typeof linkedDocumentItemSchema>;

export const listLinkedDocumentsResponseSchema = cursorPageSchema(linkedDocumentItemSchema);

export const linkedDocumentDetailSchema = linkedDocumentItemSchema.extend({
  audiences: z
    .array(z.object({ kind: z.enum(DOCUMENT_AUDIENCE_KINDS), refId: z.string().nullable(), label: z.string().nullable() }))
    .nullable(),
  newerVersionAvailable: z.boolean().nullable(),
  unpublishReason: z.string().nullable(),
});
export type LinkedDocumentDetail = z.infer<typeof linkedDocumentDetailSchema>;

export const openLinkedDocumentResponseSchema = z.object({
  url: z.string(),
  fileName: z.string(),
  expiresIn: z.number().int(),
});
