import { z } from "zod";

export const downloadQuerySchema = z
  .object({
    url: z.string().max(2048).optional(),
    key: z.string().max(1024).optional(),
    expiresIn: z.string().optional(),
    attachment: z.enum(["0", "1"]).optional(),
  })
  .strict();

export type DownloadQuery = z.infer<typeof downloadQuerySchema>;

export const imageQuerySchema = z
  .object({
    key: z.string().min(1).max(1024),
  })
  .strict();

export type ImageQuery = z.infer<typeof imageQuerySchema>;

export const kbAttachmentsQuerySchema = z.object({
  org: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type KbAttachmentsQueryInput = z.infer<typeof kbAttachmentsQuerySchema>;

export const onboardingDocTypeSchema = z.string().min(1).max(100).trim();
