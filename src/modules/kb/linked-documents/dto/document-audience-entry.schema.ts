import { z } from "zod";
import { DOCUMENT_AUDIENCE_KINDS } from "../../../../db/schema/kb/linked-documents";

export const MAX_DOCUMENT_AUDIENCES = 50;

/** One audience: everyone, or one department, or one location. The same shape sets a document's ceiling and an entry's own audience. */
export const audienceEntrySchema = z
  .object({
    kind: z.enum(DOCUMENT_AUDIENCE_KINDS),
    refId: z.string().trim().min(1).max(64).nullish(),
  })
  .strict()
  .refine((entry) => (entry.kind === "ALL_EMPLOYEES") === (entry.refId == null), {
    message: "ALL_EMPLOYEES names no department or location; DEPARTMENT and LOCATION must name one.",
    path: ["refId"],
  });
