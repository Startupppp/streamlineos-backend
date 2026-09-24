import { z } from "zod";
export const documentVersionParams = z
  .object({ documentId: z.coerce.number().int().positive(), versionNumber: z.coerce.number().int().positive() })
  .strict();

export const documentVersionsParams = z.object({ documentId: z.coerce.number().int().positive() }).strict();

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date, YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Not a real calendar date");

// The tenant check needs the caller's organisation, so the shape is checked here and "is this OUR key" in the service.
export const uploadDocumentVersionSchema = z
  .object({
    fileUrl: z.string().trim().min(1).max(1024),
    fileName: z.string().trim().min(1).max(255).optional(),
    fileSize: z.number().int().positive().optional(),
    mimeType: z.string().trim().min(1).max(255).optional(),
    effectiveDate: isoDate.optional(),
  })
  .strict();
export type UploadDocumentVersionInput = z.infer<typeof uploadDocumentVersionSchema>;
