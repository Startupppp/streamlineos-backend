import { z } from "zod";
import { isWellFormedStorageKey } from "../../../storage/storage-key";

export const createKbCategorySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  icon: z.string().max(100).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isPublished: z.boolean().optional(),
}).strict();

export const updateKbCategorySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(100).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isPublished: z.boolean().optional(),
}).strict();

export const listKbArticlesSchema = z.object({
  status: z.enum(["draft", "published", "archived"]).optional(),
  visibility: z.enum(["public", "internal"]).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().min(1).max(200).optional(),
}).strict();

export const createKbArticleSchema = z.object({
  title: z.string().min(1).max(300),
  categoryId: z.number().int().positive().nullable().optional(),
  excerpt: z.string().max(500).optional(),
  content: z.string().optional(),
  status: z.enum(["draft", "published", "archived"]).default("draft"),
  visibility: z.enum(["public", "internal"]).default("internal"),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
}).strict();

export const updateKbArticleSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  excerpt: z.string().max(500).nullable().optional(),
  content: z.string().optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
  visibility: z.enum(["public", "internal"]).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).nullable().optional(),
}).strict();

export const createKbCommentSchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty").max(5000),
}).strict();

const KB_ATTACHMENT_MAX_FILE_SIZE = 10 * 1024 * 1024;

const KB_ATTACHMENT_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export const createKbAttachmentSchema = z.object({
  fileName: z.string().trim().min(1, "File name is required").max(255),
  fileKey: z
    .string()
    .trim()
    .min(1, "File key is required")
    .max(1024)
    .refine(isWellFormedStorageKey, "Invalid file key"),
  fileUrl: z.string().trim().max(2048).optional(),
  fileSize: z.number().int().positive().max(KB_ATTACHMENT_MAX_FILE_SIZE, "File too large (max 10MB)"),
  mimeType: z.enum(KB_ATTACHMENT_ALLOWED_MIME_TYPES, {
    message: "Unsupported file type. Allowed: PDF, images, Word, Excel.",
  }),
}).strict();

export const kbAskSchema = z.object({
  question: z.string().trim().min(3, "Question is too short").max(1000),
}).strict();

export type CreateKbCategoryInput = z.infer<typeof createKbCategorySchema>;
export type UpdateKbCategoryInput = z.infer<typeof updateKbCategorySchema>;
export type ListKbArticlesInput = z.infer<typeof listKbArticlesSchema>;
export type CreateKbArticleInput = z.infer<typeof createKbArticleSchema>;
export type UpdateKbArticleInput = z.infer<typeof updateKbArticleSchema>;
export type CreateKbCommentInput = z.infer<typeof createKbCommentSchema>;
export type CreateKbAttachmentInput = z.infer<typeof createKbAttachmentSchema>;
export type KbAskInput = z.infer<typeof kbAskSchema>;
