import { z } from "zod";
import { DOCUMENT_AUDIENCE_KINDS } from "../../../../db/schema/kb/linked-documents";

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

export const MAX_DOCUMENT_AUDIENCES = 50;

const audienceEntrySchema = z
  .object({
    kind: z.enum(DOCUMENT_AUDIENCE_KINDS),
    refId: z.string().trim().min(1).max(64).nullish(),
  })
  .strict()
  .refine((entry) => (entry.kind === "ALL_EMPLOYEES") === (entry.refId == null), {
    message: "ALL_EMPLOYEES names no department or location; DEPARTMENT and LOCATION must name one.",
    path: ["refId"],
  });

// A replacement set, not a patch: what is sent is what the ceiling becomes, and an empty list means HR only.
export const setDocumentAudiencesSchema = z
  .object({ audiences: z.array(audienceEntrySchema).max(MAX_DOCUMENT_AUDIENCES) })
  .strict();
export type SetDocumentAudiencesInput = z.infer<typeof setDocumentAudiencesSchema>;
