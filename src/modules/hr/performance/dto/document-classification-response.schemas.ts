import { z } from "zod";
import { DOCUMENT_AUDIENCE_KINDS } from "../../../../db/schema/kb/linked-documents";
import { DOCUMENT_CLASSIFICATIONS } from "./document-classification.schemas";

const audienceSchema = z.object({
  id: z.number().int(),
  kind: z.enum(DOCUMENT_AUDIENCE_KINDS),
  refId: z.string().nullable(),
  label: z.string().nullable(),
});

const blockerSchema = z.object({
  code: z.enum([
    "CLASSIFICATION_NOT_SHAREABLE",
    "BELONGS_TO_AN_EMPLOYEE",
    "TYPE_NOT_ALLOWED",
    "DOCUMENT_INACTIVE",
    "HIRING_ARTEFACT",
  ]),
  message: z.string(),
});

export const documentClassificationResponseSchema = z.object({
  documentId: z.number().int(),
  classification: z.enum(DOCUMENT_CLASSIFICATIONS),
  effectiveDate: z.string().nullable(),
  audiences: z.array(audienceSchema),
  publishable: z.boolean(),
  blockers: z.array(blockerSchema),
});
export type DocumentClassificationView = z.infer<typeof documentClassificationResponseSchema>;

export const classifyDocumentResponseSchema = documentClassificationResponseSchema.extend({
  // Links to this document that the change took down, so the person is told what their edit just did.
  linksTakenDown: z.number().int(),
});
export type ClassifyDocumentResult = z.infer<typeof classifyDocumentResponseSchema>;

export const setDocumentAudiencesResponseSchema = documentClassificationResponseSchema.extend({
  // Audience rows removed from links because the new ceiling no longer covers them.
  linkAudiencesNarrowed: z.number().int(),
});
export type SetDocumentAudiencesResult = z.infer<typeof setDocumentAudiencesResponseSchema>;
