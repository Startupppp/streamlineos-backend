import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { blogAuthors, blogCategories, blogPosts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { cardColumns, publishedPostPredicate, toCard } from "./blog-public.projection";
import type { PostListQuery } from "./dto/blog.schemas";

const RELATED_LIMIT = 3;

/** Anonymous reads of published articles. Nothing here is cached: every read is authoritative. */
@Injectable()
export class BlogService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * One numbered archive page. Order is `published_at DESC, id DESC` so equal timestamps never
   * swap between pages. Offset paging is deliberate here: archive pages are stable crawlable URLs.
   */
  async listPublishedPosts(query: PostListQuery) {
    const conditions: SQL[] = [publishedPostPredicate()];
    if (query.featured) conditions.push(eq(blogPosts.isFeatured, true));
    if (query.category) conditions.push(eq(blogCategories.slug, query.category));
    if (query.author) conditions.push(eq(blogAuthors.slug, query.author));
    if (query.tag) conditions.push(sql`${blogPosts.tags} @> ARRAY[${query.tag}]::text[]`);
    const where = and(...conditions);

    const [rows, totals] = await Promise.all([
      this.selectCards(where, [desc(blogPosts.publishedAt), desc(blogPosts.id)], query.limit)
        .offset((query.page - 1) * query.limit),
      this.db
        .select({ value: count() })
        .from(blogPosts)
        .leftJoin(blogCategories, eq(blogCategories.id, blogPosts.categoryId))
        .leftJoin(blogAuthors, eq(blogAuthors.id, blogPosts.authorId))
        .where(where),
    ]);
    const total = totals[0]?.value ?? 0;
    return {
      posts: rows.map(toCard),
      total,
      page: query.page,
      pageSize: query.limit,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  /** Body, metadata and structured data all come from this one row: the published projection. */
  async getPublishedPostBySlug(slug: string) {
    const [row] = await this.db
      .select({
        ...cardColumns,
        revisionId: blogPosts.publishedRevisionId,
        standfirst: blogPosts.standfirst,
        contentHtml: blogPosts.content,
        metaTitle: blogPosts.metaTitle,
        metaDescription: blogPosts.metaDescription,
        socialImage: blogPosts.socialImage,
        ctaKey: blogPosts.ctaKey,
        authorBio: blogAuthors.bio,
        authorTwitter: blogAuthors.twitter,
        authorLinkedin: blogAuthors.linkedin,
      })
      .from(blogPosts)
      .leftJoin(blogCategories, eq(blogCategories.id, blogPosts.categoryId))
      .leftJoin(blogAuthors, eq(blogAuthors.id, blogPosts.authorId))
      .where(and(eq(blogPosts.slug, slug), publishedPostPredicate()))
      .limit(1);
    if (!row?.revisionId) return null;

    const card = toCard(row);
    return {
      ...card,
      revisionId: row.revisionId,
      standfirst: row.standfirst,
      contentHtml: row.contentHtml,
      metaTitle: row.metaTitle,
      metaDescription: row.metaDescription,
      socialImage: row.socialImage,
      ctaKey: row.ctaKey,
      author: card.author
        ? { ...card.author, bio: row.authorBio, twitter: row.authorTwitter, linkedin: row.authorLinkedin }
        : null,
    };
  }

  /** Same category first, then shared tags, then recency. Never the post itself. */
  async getRelatedPosts(slug: string) {
    const [post] = await this.db
      .select({ id: blogPosts.id, categoryId: blogPosts.categoryId, tags: blogPosts.tags })
      .from(blogPosts)
      .where(and(eq(blogPosts.slug, slug), publishedPostPredicate()))
      .limit(1);
    if (!post) return null;

    // Candidates share the category (b-tree) or a tag (GIN on tags), so this never sorts the
    // whole archive; the latest posts fill any remaining slots.
    // Drizzle spreads a JS array into a parameter list, so the tag array is built element-wise.
    const postTags = sql`ARRAY[${sql.join(post.tags.map((tag) => sql`${tag}`), sql`, `)}]::text[]`;
    const topical = post.categoryId
      ? or(eq(blogPosts.categoryId, post.categoryId), sql`${blogPosts.tags} && ${postTags}`)
      : sql`${blogPosts.tags} && ${postTags}`;
    const sameCategory = post.categoryId ? sql`(${blogPosts.categoryId} = ${post.categoryId})` : sql`false`;
    const sharedTags = sql`cardinality(ARRAY(SELECT unnest(${blogPosts.tags}) INTERSECT SELECT unnest(${postTags})))`;
    const related = await this.selectCards(
      and(publishedPostPredicate(), ne(blogPosts.id, post.id), topical),
      [desc(sameCategory), desc(sharedTags), desc(blogPosts.publishedAt), desc(blogPosts.id)],
      RELATED_LIMIT,
    );
    if (related.length >= RELATED_LIMIT) return related.map(toCard);

    const exclude = [post.id, ...related.map((r) => r.id)];
    const latest = await this.selectCards(
      and(publishedPostPredicate(), notInArray(blogPosts.id, exclude)),
      [desc(blogPosts.publishedAt), desc(blogPosts.id)],
      RELATED_LIMIT - related.length,
    );
    return [...related, ...latest].map(toCard);
  }

  private selectCards(where: SQL | undefined, orderBy: SQL[], limit: number) {
    return this.db
      .select(cardColumns)
      .from(blogPosts)
      .leftJoin(blogCategories, eq(blogCategories.id, blogPosts.categoryId))
      .leftJoin(blogAuthors, eq(blogAuthors.id, blogPosts.authorId))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit);
  }
}
