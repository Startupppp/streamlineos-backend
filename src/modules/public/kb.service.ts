import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { kbArticleFeedback, kbArticles, kbCategories } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { KbFeedbackInput, KbListInput } from "./dto/public.schemas";

@Injectable()
export class KbService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(input: KbListInput) {
    const { org, categoryId, search } = input;

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
        tags: kbArticles.tags,
        publishedAt: kbArticles.publishedAt,
      })
      .from(kbArticles)
      .where(and(...conditions))
      .orderBy(desc(kbArticles.publishedAt));

    return { categories, articles };
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
        tags: kbArticles.tags,
        publishedAt: kbArticles.publishedAt,
      })
      .from(kbArticles)
      .leftJoin(kbCategories, eq(kbArticles.categoryId, kbCategories.id))
      .where(
        and(
          eq(kbArticles.orgId, org),
          eq(kbArticles.slug, slug),
          eq(kbArticles.status, "published"),
          eq(kbArticles.visibility, "public"),
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
      .where(
        and(
          eq(kbArticles.orgId, org),
          eq(kbArticles.slug, slug),
          eq(kbArticles.status, "published"),
          eq(kbArticles.visibility, "public"),
        ),
      );

    if (!article) throw new NotFoundException("Article not found");

    await this.db.transaction(async (tx) => {
      await tx.insert(kbArticleFeedback).values({
        orgId: org,
        articleId: article.id,
        helpful,
        comment: comment ?? null,
        visitorId: visitorId ?? null,
      });
      await tx
        .update(kbArticles)
        .set(
          helpful
            ? { helpfulCount: sql`${kbArticles.helpfulCount} + 1` }
            : { notHelpfulCount: sql`${kbArticles.notHelpfulCount} + 1` },
        )
        .where(eq(kbArticles.id, article.id));
    });

    return { success: true };
  }
}
