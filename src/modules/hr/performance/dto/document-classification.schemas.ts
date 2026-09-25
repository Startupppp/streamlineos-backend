import { z } from "zod";
import { audienceEntrySchema, MAX_DOCUMENT_AUDIENCES } from "../../../kb/linked-documents/dto/document-audience-entry.schema";

export { MAX_DOCUMENT_AUDIENCES };

export const DOCUMENT_CLASSIFICATIONS = ["PERSONAL", "CONFIDENTIAL", "RESTRICTED", "INTERNAL"] as const;

export const documentClassificationParams = z
  .object({ documentId: z.coerce.number().int().positive() })
  .strict();

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date, YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Not a real calendar date");

// `effectiveDate` is left alone when omitted and cleared when null, matching how the rest of the documents API reads a PATCH.
export const classifyDocumentSchema = z
  .object({
    classification: z.enum(DOCUMENT_CLASSIFICATIONS),
    effectiveDate: isoDate.nullable().optional(),
  })
  .strict();
export type ClassifyDocumentInput = z.infer<typeof classifyDocumentSchema>;

// A replacement set, not a patch: what is sent is what the ceiling becomes, and an empty list means HR only.
export const setDocumentAudiencesSchema = z
  .object({ audiences: z.array(audienceEntrySchema).max(MAX_DOCUMENT_AUDIENCES) })
  .strict();
export type SetDocumentAudiencesInput = z.infer<typeof setDocumentAudiencesSchema>;
