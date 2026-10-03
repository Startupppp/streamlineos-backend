import { z } from "zod";
import { optionalPageSizeField } from "../../../common/pagination/list-query.schema";

const slugField = z.string().trim().min(1).max(256).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const tagField = z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** Numbered archive pages. A page past the end is an empty page the site turns into a 404. */
export const postListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(24).default(12),
  category: slugField.optional(),
  tag: tagField.optional(),
  author: slugField.optional(),
  featured: z.enum(["true"]).optional(),
}).strict();

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(20).default(20),
}).strict();

export const sitemapQuerySchema = z.object({
  cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/).optional(),
  limit: optionalPageSizeField(),
}).strict();

export const redirectQuerySchema = z.object({
  path: z.string().min(8).max(600).regex(/^\/blogs\/[^?#\s]*$/),
}).strict();

export const slugParamsSchema = z.object({ slug: slugField }).strict();
export const categorySlugParamsSchema = z.object({ categorySlug: slugField }).strict();
export const authorSlugParamsSchema = z.object({ authorSlug: slugField }).strict();

/** Body of the signed notification the blog admin sends after publish, rename or withdraw. */
export const invalidationBodySchema = z.object({
  eventId: z.string().uuid(),
  postId: z.string().uuid(),
  generation: z.number().int().min(0),
  reason: z.enum(["publish", "unpublish", "rename", "update", "delete"]),
}).strict();

export type PostListQuery = z.infer<typeof postListQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SitemapQuery = z.infer<typeof sitemapQuerySchema>;
export type InvalidationBody = z.infer<typeof invalidationBodySchema>;
