import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  kbCategories,
  kbPageFeedback,
  kbPages,
  kbSpaces,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBeforeId } from "../../common/pagination/keyset";
import { PAGE_SIZE_CAP } from "../../common/pagination/list-query.schema";
import { supportArticlePredicate } from "../kb/help-centre/kb-article-page-scope";
import type { KbFeedbackInput, KbListInput } from "./dto/public.schemas";

function anonymouslyReadableArticle(org: string): (SQL | undefined)[] {
  return [
    eq(kbPages.orgId, org),
    supportArticlePredicate(),
    isNull(kbPages.deletedAt),
    eq(kbPages.status, "published"),
    eq(kbPages.visibility, "public"),
    inArray(kbSpaces.audience, ["public", "mixed"]),
    isNull(kbSpaces.deletedAt),
  ];
}

const articleTagNames = sql<string[]>`ARRAY(
  SELECT kt.name FROM kb_page_tags kpt
  JOIN kb_tags kt ON kt.id = kpt.tag_id
  WHERE kpt.page_id = ${kbPages.id}
  ORDER BY kt.name
)`;

@Injectable()
export class KbService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(input: KbListInput) {
    const { org, categoryId, search, cursor } = input;
    const pageSize = Math.min(input.pageSize, PAGE_SIZE_CAP);
    const position = cursor === undefined ? undefined : decodeCursor(cursor);
    if (cursor !== undefined && !position)
      throw new BadRequestException("Invalid pagination cursor");

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
      .where(
        and(eq(kbCategories.orgId, org), eq(kbCategories.isPublished, true)),
      )
      .orderBy(asc(kbCategories.sortOrder), asc(kbCategories.name));

    const conditions: (SQL | undefined)[] = anonymouslyReadableArticle(org);
    if (categoryId) conditions.push(eq(kbPages.categoryId, categoryId));
    if (search) {
      const term = `%${search}%`;
      const match = or(ilike(kbPages.title, term), ilike(kbPages.excerpt, term));
      if (match) conditions.push(match);
    }

    const articles = await this.db
      .select({
        id: kbPages.id,
        categoryId: kbPages.categoryId,
        title: kbPages.title,
        slug: kbPages.slug,
        excerpt: kbPages.excerpt,
        views: kbPages.views,
        helpfulCount: kbPages.helpfulCount,
        notHelpfulCount: kbPages.notHelpfulCount,
        tags: articleTagNames,
        publishedAt: kbPages.publishedAt,
      })
      .from(kbPages)
      .innerJoin(kbSpaces, eq(kbPages.spaceId, kbSpaces.id))
      .where(
        and(
          ...conditions,
          position
            ? keysetBeforeId(kbPages.publishedAt, kbPages.id, position)
            : undefined,
        ),
      )
      .orderBy(desc(kbPages.publishedAt), desc(kbPages.id))
      .limit(pageSize + 1);

    const page = buildCursorPage(articles, pageSize, (article) => ({
      sortValue: article.publishedAt?.toISOString() ?? "",
      id: String(article.id),
    }));
    return { categories, articles: page.data, pagination: page.pagination };
  }

  async getArticle(slug: string, org: string) {
    const [article] = await this.db
      .select({
        id: kbPages.id,
        title: kbPages.title,
        slug: kbPages.slug,
        excerpt: kbPages.excerpt,
        content: kbPages.contentText,
        categoryId: kbPages.categoryId,
        categoryName: kbCategories.name,
        categorySlug: kbCategories.slug,
        views: kbPages.views,
        helpfulCount: kbPages.helpfulCount,
        notHelpfulCount: kbPages.notHelpfulCount,
        tags: articleTagNames,
        seoTitle: kbPages.seoTitle,
        seoDescription: kbPages.seoDescription,
        publishedAt: kbPages.publishedAt,
        updatedAt: kbPages.updatedAt,
      })
      .from(kbPages)
      .leftJoin(kbCategories, eq(kbPages.categoryId, kbCategories.id))
      .innerJoin(kbSpaces, eq(kbPages.spaceId, kbSpaces.id))
      .where(and(...anonymouslyReadableArticle(org), eq(kbPages.slug, slug)));

    if (!article) throw new NotFoundException("Article not found");

    await this.db
      .update(kbPages)
      .set({ views: sql`coalesce(${kbPages.views}, 0) + 1` })
      .where(and(eq(kbPages.orgId, org), eq(kbPages.id, article.id)));

    return { ...article, views: (article.views ?? 0) + 1 };
  }

  async submitFeedback(slug: string, org: string, input: KbFeedbackInput) {
    const { helpful, comment, visitorId } = input;

    const [article] = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .innerJoin(kbSpaces, eq(kbPages.spaceId, kbSpaces.id))
      .where(and(...anonymouslyReadableArticle(org), eq(kbPages.slug, slug)));

    if (!article) throw new NotFoundException("Article not found");

    const recorded = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(kbPageFeedback)
        .values({
          orgId: org,
          pageId: article.id,
          helpful,
          comment: comment ?? null,
          visitorId: visitorId ?? null,
        })
        .onConflictDoNothing({
          target: [
            kbPageFeedback.orgId,
            kbPageFeedback.pageId,
            kbPageFeedback.visitorId,
          ],
        })
        .returning({ id: kbPageFeedback.id });

      if (inserted.length === 0) return false;

      await tx
        .update(kbPages)
        .set(
          helpful
            ? { helpfulCount: sql`coalesce(${kbPages.helpfulCount}, 0) + 1` }
            : {
                notHelpfulCount: sql`coalesce(${kbPages.notHelpfulCount}, 0) + 1`,
              },
        )
        .where(and(eq(kbPages.orgId, org), eq(kbPages.id, article.id)));
      return true;
    });

    return { success: true, recorded };
  }
}
