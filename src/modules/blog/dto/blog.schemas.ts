import { z } from "zod";

export const postCreateSchema = z.object({
  title: z.string().min(1).max(256),
  excerpt: z.string().min(1).max(500),
  content: z.string().min(1),
  contentJson: z.record(z.string(), z.unknown()).optional().nullable(),
  coverImage: z.string().min(1),
  categoryId: z.string().uuid().optional().nullable(),
  authorId: z.string().uuid().optional().nullable(),
  status: z.enum(["draft", "published", "archived"]).default("draft"),
  isFeatured: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  metaTitle: z.string().max(256).optional().nullable(),
  metaDescription: z.string().max(320).optional().nullable(),
  slug: z.string().max(256).optional(),
});

export const postUpdateSchema = postCreateSchema.partial();

export const categoryCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional().nullable(),
  color: z
    .string()
    .regex(/^#([0-9a-fA-F]{6})$/, "Color must be a hex value like #3B82F6")
    .optional()
    .nullable(),
});

export const categoryUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional().nullable(),
  color: z
    .string()
    .regex(/^#([0-9a-fA-F]{6})$/, "Color must be a hex value like #3B82F6")
    .optional()
    .nullable(),
});

export const feedSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
  search: z.string().optional(),
});

export type PostCreateInput = z.infer<typeof postCreateSchema>;
export type PostUpdateInput = z.infer<typeof postUpdateSchema>;
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;
export type FeedInput = z.infer<typeof feedSchema>;
