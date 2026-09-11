import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

const signDocumentRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int(),
  originalFileKey: z.string(),
  currentFileKey: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  pageCount: z.number().int().nullable(),
  fileSize: z.number().int(),
  sha256Hash: z.string(),
  conversionStatus: z.enum(["pending", "converted", "failed", "not_needed"]),
  conversionError: z.string().nullable(),
  orderIndex: z.number().int(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const uploadDocumentResponseSchema = signDocumentRowSchema;

export const listDocumentsResponseSchema = z.array(signDocumentRowSchema);

export const previewDocumentResponseSchema = z.object({
  document: signDocumentRowSchema,
  url: z.string(),
  expiresInSeconds: z.number().int(),
});
