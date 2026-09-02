import { z } from "zod";

export const MAX_MULTIPART_BYTES = 5 * 1024 * 1024 * 1024;

export const initiateMultipartSchema = z
  .object({
    folder: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/),
    fileName: z.string().min(1).max(500),
    mimeType: z.string().min(1).max(200),
    sizeBytes: z.coerce.number().int().min(1).max(MAX_MULTIPART_BYTES),
    partCount: z.coerce.number().int().min(1).max(10000),
  })
  .strict();
export type InitiateMultipartInput = z.infer<typeof initiateMultipartSchema>;

export const completeMultipartSchema = z
  .object({
    key: z.string().min(1).max(1000),
    uploadId: z.string().min(1).max(500),
    parts: z
      .array(
        z.object({ partNumber: z.number().int().min(1), eTag: z.string().min(1) }),
      )
      .min(1)
      .max(10000),
  })
  .strict();
export type CompleteMultipartInput = z.infer<typeof completeMultipartSchema>;

export const abortMultipartSchema = z
  .object({
    key: z.string().min(1).max(1000),
    uploadId: z.string().min(1).max(500),
  })
  .strict();
export type AbortMultipartInput = z.infer<typeof abortMultipartSchema>;
