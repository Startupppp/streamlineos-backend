import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, isNull, lt, max, or, sql } from "drizzle-orm";
import { blogAuthors, blogCategories, blogPosts, blogRedirects } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { cardColumns, publishedPostPredicate, toCard } from "./blog-public.projection";
import type { SearchQuery, SitemapQuery } from "./dto/blog.schemas";

const SITEMAP_PAGE = 100;
const TAXONOMY_CAP = 100;
const RSS_ITEMS = 20;
const SEARCH_TIMEOUT_MS = 2_000;

/**
 * The search expression. It must stay byte-identical to `idx_blog_posts_public_search` (1703):
 * the planner only uses an expression index for the exact expression.
 */
const searchVector = sql`to_tsvector('english', ${blogPosts.title} || ' ' || ${blogPosts.excerpt} || ' ' || ${blogPosts.searchText})`;

/** Search, sitemap, RSS, redirects and author profiles — discovery surfaces over published posts. */
@Injectable()
export class BlogDiscoveryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Parameterised, length-bounded, result-bounded and time-bounded full-text search. */
  search(query: SearchQuery) {
    const tsQuery = sql`websearch_to_tsquery('english', ${query.q})`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${SEARCH_TIMEOUT_MS}`));
      const rows = await tx
        .select(cardColumns)
        .from(blogPosts)
        .leftJoin(blogCategories, eq(blogCategories.id, blogPosts.categoryId))
        .leftJoin(blogAuthors, eq(blogAuthors.id, blogPosts.authorId))
        .where(and(publishedPostPredicate(), sql`${searchVector} @@ ${tsQuery}`))
        .orderBy(desc(sql`ts_rank(${searchVector}, ${tsQuery})`), desc(blogPosts.publishedAt), desc(blogPosts.id))
        .limit(query.limit);
      return rows.map(toCard);
    });
  }

  /** Keyset page of published post URLs, newest first. The cursor is `publishedAt|id`. */
  async sitemapPosts(query: SitemapQuery) {
    const conditions = [publishedPostPredicate()];
    if (query.cursor) {
      const [at, id] = query.cursor.split("|");
      const cursorAt = sql`(${at}::timestamptz AT TIME ZONE 'UTC')`;
      const keyset = or(lt(blogPosts.publishedAt, cursorAt), and(eq(blogPosts.publishedAt, cursorAt), lt(blogPosts.id, id)));
      if (keyset) conditions.push(keyset);
    }
    const rows = await this.db
      .select({
        id: blogPosts.id,
        slug: blogPosts.slug,
        publishedAt: blogPosts.publishedAt,
        modifiedAt: blogPosts.modifiedAt,
        // Microsecond text, not a JS Date: a millisecond cursor would skip a row published
        // within the same millisecond as the page's last row.
        cursorAt: sql<string>`to_char(${blogPosts.publishedAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(blogPosts)
      .where(and(...conditions))
      .orderBy(desc(blogPosts.publishedAt), desc(blogPosts.id))
      .limit(SITEMAP_PAGE + 1);
    const page = rows.slice(0, SITEMAP_PAGE);
    const last = page[page.length - 1];
    return {
      posts: page.map((r) => ({ slug: r.slug, modifiedAt: r.modifiedAt ?? r.publishedAt })),
      nextCursor: rows.length > SITEMAP_PAGE && last ? `${last.cursorAt}|${last.id}` : null,
    };
  }

  /** Categories and authors that have at least one published post; empty archives are left out. */
  async sitemapTaxonomy() {
    const [categories, authors] = await Promise.all([
      this.db
        .select({ slug: blogCategories.slug, modifiedAt: max(blogPosts.modifiedAt) })
        .from(blogCategories)
        .innerJoin(blogPosts, and(eq(blogPosts.categoryId, blogCategories.id), publishedPostPredicate()))
        .where(isNull(blogCategories.archivedAt))
        .groupBy(blogCategories.slug)
        .orderBy(asc(blogCategories.slug))
        .limit(TAXONOMY_CAP),
      this.db
        .select({ slug: blogAuthors.slug, modifiedAt: max(blogPosts.modifiedAt) })
        .from(blogAuthors)
        .innerJoin(blogPosts, and(eq(blogPosts.authorId, blogAuthors.id), publishedPostPredicate()))
        .where(isNull(blogAuthors.archivedAt))
        .groupBy(blogAuthors.slug)
        .orderBy(asc(blogAuthors.slug))
        .limit(TAXONOMY_CAP),
    ]);
    return { categories, authors };
  }

  /** The newest published posts for the RSS feed. */
  async rssItems() {
    const rows = await this.db
      .select(cardColumns)
      .from(blogPosts)
      .leftJoin(blogCategories, eq(blogCategories.id, blogPosts.categoryId))
      .leftJoin(blogAuthors, eq(blogAuthors.id, blogPosts.authorId))
      .where(publishedPostPredicate())
      .orderBy(desc(blogPosts.publishedAt), desc(blogPosts.id))
      .limit(RSS_ITEMS);
    return rows.map(toCard);
  }

  /** A redirect or retirement recorded for an old `/blogs/...` path, if any. */
  async resolveRedirect(path: string) {
    const [row] = await this.db
      .select({ statusCode: blogRedirects.statusCode, targetPath: blogRedirects.targetPath })
      .from(blogRedirects)
      .where(eq(blogRedirects.sourcePath, path))
      .limit(1);
    if (!row) return null;
    return row.statusCode === 410
      ? { statusCode: 410 as const, targetPath: null }
      : { statusCode: 301 as const, targetPath: row.targetPath };
  }

  /** Public author profile. Email is never selected. An author with no published post is a 404. */
  async getAuthor(slug: string) {
    const [row] = await this.db
      .select({
        name: blogAuthors.name,
        slug: blogAuthors.slug,
        avatar: blogAuthors.avatar,
        role: blogAuthors.role,
        bio: blogAuthors.bio,
        twitter: blogAuthors.twitter,
        linkedin: blogAuthors.linkedin,
        count: count(blogPosts.id),
      })
      .from(blogAuthors)
      .innerJoin(blogPosts, and(eq(blogPosts.authorId, blogAuthors.id), publishedPostPredicate()))
      .where(and(eq(blogAuthors.slug, slug), isNull(blogAuthors.archivedAt)))
      .groupBy(blogAuthors.id)
      .limit(1);
    return row ?? null;
  }
}
