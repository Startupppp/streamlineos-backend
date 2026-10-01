import { z } from "zod";
import { nullableWireDate } from "../../../common/openapi/wire-types";

/**
 * Public projections only. No email, editor identity, revision history, internal notes, draft
 * content or storage key is ever part of these shapes (PUB-08).
 */
const coverSchema = z.object({
  src: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  alt: z.string(),
  caption: z.string().nullable(),
  credit: z.string().nullable(),
  sources: z.array(z.object({ src: z.string(), width: z.number().int(), type: z.string() })),
});

const cardCategorySchema = z.object({ name: z.string(), slug: z.string(), color: z.string().nullable() });
const cardAuthorSchema = z.object({
  name: z.string(),
  slug: z.string(),
  avatar: z.string().nullable(),
  role: z.string().nullable(),
});

export const blogCardSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string(),
  coverImage: z.string(),
  cover: coverSchema.nullable(),
  isFeatured: z.boolean(),
  readingTime: z.number().int(),
  tags: z.array(z.string()),
  publishedAt: nullableWireDate(),
  modifiedAt: nullableWireDate(),
  category: cardCategorySchema.nullable(),
  author: cardAuthorSchema.nullable(),
});

export const blogPostPageSchema = z.object({
  posts: z.array(blogCardSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export const blogArticleSchema = blogCardSchema.extend({
  revisionId: z.string().uuid(),
  standfirst: z.string().nullable(),
  contentHtml: z.string(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  socialImage: z.string().nullable(),
  ctaKey: z.string().nullable(),
  author: cardAuthorSchema.extend({
    bio: z.string().nullable(),
    twitter: z.string().nullable(),
    linkedin: z.string().nullable(),
  }).nullable(),
});

export const blogCardListSchema = z.array(blogCardSchema);

export const blogPublicCategoryListSchema = z.array(
  z.object({
    name: z.string(),
    slug: z.string(),
    color: z.string().nullable(),
    description: z.string().nullable(),
    count: z.number().int(),
  }),
);

export const blogCategoryDetailSchema = z.object({
  name: z.string(),
  slug: z.string(),
  color: z.string().nullable(),
  description: z.string().nullable(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  count: z.number().int(),
});

export const blogAuthorDetailSchema = z.object({
  name: z.string(),
  slug: z.string(),
  avatar: z.string().nullable(),
  role: z.string().nullable(),
  bio: z.string().nullable(),
  twitter: z.string().nullable(),
  linkedin: z.string().nullable(),
  count: z.number().int(),
});

export const blogRedirectSchema = z.object({
  statusCode: z.union([z.literal(301), z.literal(410)]),
  targetPath: z.string().nullable(),
});

export const blogSitemapPageSchema = z.object({
  posts: z.array(z.object({ slug: z.string(), modifiedAt: nullableWireDate() })),
  nextCursor: z.string().nullable(),
});

export const blogSitemapTaxonomySchema = z.object({
  categories: z.array(z.object({ slug: z.string(), modifiedAt: nullableWireDate() })),
  authors: z.array(z.object({ slug: z.string(), modifiedAt: nullableWireDate() })),
});

export const blogInvalidationAckSchema = z.object({
  acknowledged: z.literal(true),
  duplicate: z.boolean(),
  publishedRevisionId: z.string().uuid().nullable(),
});
