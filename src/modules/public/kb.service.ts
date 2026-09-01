import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { kbArticleFeedback, kbArticles, kbCategories, kbSpaces } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBeforeId } from "../../common/pagination/keyset";
import type { KbFeedbackInput, KbListInput } from "./dto/public.schemas";

@Injectable()
export class KbService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(input: KbListInput) {
    const { org, categoryId, search, pageSize, cursor } = input;
    const position = cursor === undefined ? undefined : decodeCursor(cursor);
    if (cursor !== undefined && !position) throw new BadRequestException("Invalid pagination cursor");

    const categories = await this.db
      .select({
        id: kbCategories.id,
        name: kbCategories.name,
        slug: kbCategories.slug,
        description: kbCategories.description,
        icon: kbCategories.icon,
        sortOrder: kbCategories.sortOrder,
      })
      .from(kbCategories)
      .where(and(eq(kbCategories.orgId, org), eq(kbCategories.isPublished, true)))
      .orderBy(asc(kbCategories.sortOrder), asc(kbCategories.name));

    const conditions: SQL[] = [
      eq(kbArticles.orgId, org),
      eq(kbArticles.status, "published"),
      eq(kbArticles.visibility, "public"),
      inArray(kbSpaces.audience, ["public", "mixed"]),
      isNull(kbSpaces.deletedAt),
    ];
    if (categoryId) conditions.push(eq(kbArticles.categoryId, categoryId));
    if (search) {
      const term = `%${search}%`;
      const match = or(ilike(kbArticles.title, term), ilike(kbArticles.excerpt, term));
      if (match) conditions.push(match);
    }

    const articles = await this.db
      .select({
        id: kbArticles.id,
        categoryId: kbArticles.categoryId,
        title: kbArticles.title,
        slug: kbArticles.slug,
        excerpt: kbArticles.excerpt,
        views: kbArticles.views,
        helpfulCount: kbArticles.helpfulCount,
        notHelpfulCount: kbArticles.notHelpfulCount,
        tags: sql<string[]>`ARRAY(
          SELECT kt.name FROM kb_article_tags kat
          JOIN kb_tags kt ON kt.id = kat.tag_id
          WHERE kat.article_id = ${kbArticles.id}
          ORDER BY kt.name
        )`,
        publishedAt: kbArticles.publishedAt,
      })
      .from(kbArticles)
      .innerJoin(kbSpaces, eq(kbArticles.spaceId, kbSpaces.id))
      .where(and(...conditions, position ? keysetBeforeId(kbArticles.publishedAt, kbArticles.id, position) : undefined))
      .orderBy(desc(kbArticles.publishedAt), desc(kbArticles.id))
      .limit(pageSize + 1);

    return { categories, ...buildCursorPage(articles, pageSize, (article) => ({ sortValue: article.publishedAt?.toISOString() ?? "", id: String(article.id) })) };
  }

  async getArticle(slug: string, org: string) {
    const [article] = await this.db
      .select({
        id: kbArticles.id,
        title: kbArticles.title,
        slug: kbArticles.slug,
        excerpt: kbArticles.excerpt,
        content: kbArticles.content,
        categoryId: kbArticles.categoryId,
        categoryName: kbCategories.name,
        categorySlug: kbCategories.slug,
        views: kbArticles.views,
        helpfulCount: kbArticles.helpfulCount,
        notHelpfulCount: kbArticles.notHelpfulCount,
        tags: sql<string[]>`ARRAY(
          SELECT kt.name FROM kb_article_tags kat
          JOIN kb_tags kt ON kt.id = kat.tag_id
          WHERE kat.article_id = ${kbArticles.id}
          ORDER BY kt.name
        )`,
        seoTitle: kbArticles.seoTitle,
        seoDescription: kbArticles.seoDescription,
        publishedAt: kbArticles.publishedAt,
        updatedAt: kbArticles.updatedAt,
      })
      .from(kbArticles)
      .leftJoin(kbCategories, eq(kbArticles.categoryId, kbCategories.id))
      .innerJoin(kbSpaces, eq(kbArticles.spaceId, kbSpaces.id))
      .where(
        and(
          eq(kbArticles.orgId, org),
          eq(kbArticles.slug, slug),
          eq(kbArticles.status, "published"),
          eq(kbArticles.visibility, "public"),
          inArray(kbSpaces.audience, ["public", "mixed"]),
          isNull(kbSpaces.deletedAt),
        ),
      );

    if (!article) throw new NotFoundException("Article not found");

    await this.db
      .update(kbArticles)
      .set({ views: sql`${kbArticles.views} + 1` })
      .where(eq(kbArticles.id, article.id));

    return { ...article, views: article.views + 1 };
  }

  async submitFeedback(slug: string, org: string, input: KbFeedbackInput) {
    const { helpful, comment, visitorId } = input;

    const [article] = await this.db
      .select({ id: kbArticles.id })
      .from(kbArticles)
      .innerJoin(kbSpaces, eq(kbArticles.spaceId, kbSpaces.id))
      .where(
        and(
          eq(kbArticles.orgId, org),
          eq(kbArticles.slug, slug),
          eq(kbArticles.status, "published"),
          eq(kbArticles.visibility, "public"),
          inArray(kbSpaces.audience, ["public", "mixed"]),
          isNull(kbSpaces.deletedAt),
        ),
      );

    if (!article) throw new NotFoundException("Article not found");

    const recorded = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(kbArticleFeedback)
        .values({
          orgId: org,
          articleId: article.id,
          helpful,
          comment: comment ?? null,
          visitorId: visitorId ?? null,
        })
        .onConflictDoNothing({
          target: [kbArticleFeedback.orgId, kbArticleFeedback.articleId, kbArticleFeedback.visitorId],
        })
        .returning({ id: kbArticleFeedback.id });

      if (inserted.length === 0) return false;

      await tx
        .update(kbArticles)
        .set(
          helpful
            ? { helpfulCount: sql`${kbArticles.helpfulCount} + 1` }
            : { notHelpfulCount: sql`${kbArticles.notHelpfulCount} + 1` },
        )
        .where(eq(kbArticles.id, article.id));
      return true;
    });

    return { success: true, recorded };
  }
}
