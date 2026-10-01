import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { blogAuthors, blogCategories, blogPosts, type BlogCoverProjection } from "../../db/schema";

/**
 * The one publication predicate. Every anonymous read — detail, lists, counts, search, related,
 * author and category pages, sitemap and RSS — goes through it, so a draft, a scheduled post, an
 * archived or deleted post can never be eligible on one surface and not another.
 *
 * `published_at` is `timestamp without time zone` holding UTC clock time, so it is compared with
 * `now() AT TIME ZONE 'UTC'` rather than `now()`: the implicit cast would use the session zone.
 */
export function publishedPostPredicate(): SQL {
  const predicate = and(
    eq(blogPosts.status, "published"),
    isNotNull(blogPosts.publishedRevisionId),
    isNull(blogPosts.archivedAt),
    isNull(blogPosts.deletedAt),
    sql`${blogPosts.publishedAt} <= (now() AT TIME ZONE 'UTC')`,
  );
  if (!predicate) throw new Error("publication predicate is empty");
  return predicate;
}

/** Columns for a listing card; joined author and category are flattened, then nested by `toCard`. */
export const cardColumns = {
  id: blogPosts.id,
  title: blogPosts.title,
  slug: blogPosts.slug,
  excerpt: blogPosts.excerpt,
  coverImage: blogPosts.coverImage,
  cover: blogPosts.cover,
  isFeatured: blogPosts.isFeatured,
  readingTime: blogPosts.readingTime,
  tags: blogPosts.tags,
  publishedAt: blogPosts.publishedAt,
  modifiedAt: blogPosts.modifiedAt,
  categoryName: blogCategories.name,
  categorySlug: blogCategories.slug,
  categoryColor: blogCategories.color,
  authorName: blogAuthors.name,
  authorSlug: blogAuthors.slug,
  authorAvatar: blogAuthors.avatar,
  authorRole: blogAuthors.role,
};

interface CardRow {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  coverImage: string;
  cover: BlogCoverProjection | null;
  isFeatured: boolean;
  readingTime: number | null;
  tags: string[];
  publishedAt: Date | null;
  modifiedAt: Date | null;
  categoryName: string | null;
  categorySlug: string | null;
  categoryColor: string | null;
  authorName: string | null;
  authorSlug: string | null;
  authorAvatar: string | null;
  authorRole: string | null;
}

export function toCard(row: CardRow) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    coverImage: row.coverImage,
    cover: row.cover,
    isFeatured: row.isFeatured,
    readingTime: Math.max(1, row.readingTime ?? 1),
    tags: row.tags,
    publishedAt: row.publishedAt,
    modifiedAt: row.modifiedAt ?? row.publishedAt,
    category: row.categorySlug && row.categoryName
      ? { name: row.categoryName, slug: row.categorySlug, color: row.categoryColor }
      : null,
    author: row.authorSlug && row.authorName
      ? { name: row.authorName, slug: row.authorSlug, avatar: row.authorAvatar, role: row.authorRole }
      : null,
  };
}

export type BlogCard = ReturnType<typeof toCard>;
