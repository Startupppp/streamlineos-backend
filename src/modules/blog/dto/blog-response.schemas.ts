import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { successSchema } from "../../../common/openapi/response-envelopes";

export const blogAuthorSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().nullable(),
  avatar: z.string().nullable(),
  bio: z.string().nullable(),
  role: z.string().nullable(),
  twitter: z.string().nullable(),
  linkedin: z.string().nullable(),
  createdAt: wireDate(),
});

export const blogCategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  createdAt: wireDate(),
});

export const blogPostSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  coverImage: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  content: z.string().nullable(),
  contentText: z.string().nullable(),
  contentJson: z.record(z.string(), z.unknown()).nullable(),
  categoryId: z.string().uuid().nullable(),
  authorId: z.string().uuid().nullable(),
  status: z.enum(["draft", "published"]),
  isFeatured: z.boolean(),
  readingTime: z.number().int().nullable(),
  publishedAt: nullableWireDate(),
  tags: z.array(z.string()),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const blogPostWithRelationsSchema = blogPostSchema.extend({
  category: blogCategorySchema.nullable(),
  author: blogAuthorSchema.nullable(),
});

export const blogAdjacentPostsSchema = z.object({
  prev: z.object({ slug: z.string(), title: z.string() }).nullable(),
  next: z.object({ slug: z.string(), title: z.string() }).nullable(),
});

export const blogPublicCategoryListSchema = z.array(
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    color: z.string().nullable(),
    description: z.string().nullable(),
    count: z.number().int(),
  }),
);

export const blogFeedSchema = z.object({
  posts: z.array(blogPostWithRelationsSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const blogAdminCategoryListSchema = z.array(
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    color: z.string().nullable(),
    createdAt: wireDate(),
    postCount: z.number().int(),
  }),
);

export { successSchema as blogDeleteSchema };
