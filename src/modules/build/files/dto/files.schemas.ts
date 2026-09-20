import { z } from "zod";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4 + 1024;

export const ALLOWED_FILE_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export const uploadFileSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().toLowerCase().pipe(z.enum(ALLOWED_FILE_MIME_TYPES)),
    contentBase64: z.string().min(4).max(MAX_BASE64_CHARS),
  })
  .strict();

export const listFilesQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type UploadFileInput = z.infer<typeof uploadFileSchema>;
export type ListFilesQuery = z.infer<typeof listFilesQuerySchema>;
