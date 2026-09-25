import { z } from "zod";
import { nullableWireDate } from "../../../../common/openapi/wire-types";

const versionSchema = z.object({
  version: z.number().int(),
  status: z.enum(["pending", "approved", "rejected"]),
  fileName: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  mimeType: z.string().nullable(),
  effectiveDate: z.string().nullable(),
  approvedAt: nullableWireDate(),
  isCurrent: z.boolean(),
});

/** The file history of one document. Storage keys are never returned; a version is identified by its number. */
export const documentVersionsResponseSchema = z.object({
  documentId: z.number().int(),
  currentVersion: z.number().int(),
  versions: z.array(versionSchema),
});
export type DocumentVersionsView = z.infer<typeof documentVersionsResponseSchema>;
