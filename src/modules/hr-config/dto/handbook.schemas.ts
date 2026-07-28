import { z } from "zod";

const VERSION_FORMAT = /^\d+\.\d+$/;
const CONSECUTIVE_SPECIAL_CHARS = /[^a-zA-Z0-9 ]{2,}/;

export const createHandbookSchema = z.object({
  version: z
    .string()
    .min(1, "Version is required")
    .max(10, "Version must be at most 10 characters")
    .regex(VERSION_FORMAT, "Version must be in MAJOR.MINOR format (e.g., 1.0, 2.3)"),
  title: z
    .string()
    .trim()
    .min(2, "Title must be at least 2 characters")
    .max(100, "Title must be at most 100 characters")
    .refine((v) => v.length > 0, "Title is required")
    .refine((v) => !/ {2}/.test(v), "Title must not contain consecutive spaces")
    .refine((v) => !CONSECUTIVE_SPECIAL_CHARS.test(v), "Title must not contain consecutive special characters"),
  documentId: z.number().int().positive().optional(),
  documentUrl: z
    .string()
    .url("Document URL must be a valid URL")
    .startsWith("https://", "Document URL must start with https://")
    .optional(),
  changelog: z.string().max(2000).optional(),
});

export const updateHandbookSchema = z.object({
  status: z.enum(["PUBLISHED", "DRAFT"]).optional(),
  title: z.string().min(2).max(100).optional(),
  version: z.string().min(1).max(10).regex(VERSION_FORMAT, "Version must be in MAJOR.MINOR format (e.g., 1.0, 2.3)").optional(),
  documentUrl: z.string().url().optional().or(z.literal("")),
  changelog: z.string().max(2000).optional(),
});

export type CreateHandbookInput = z.infer<typeof createHandbookSchema>;
export type UpdateHandbookInput = z.infer<typeof updateHandbookSchema>;
