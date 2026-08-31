import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleVersions } from "../../../db/schema";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ListArticlesInput } from "../core/dto/kb.schemas";

type ArticleRow = typeof kbArticles.$inferSelect;

type ArticleListItem = Pick<
  ArticleRow,
  | "id"
  | "spaceId"
  | "categoryId"
  | "title"
  | "slug"
  | "excerpt"
  | "status"
  | "visibility"
  | "ownerId"
  | "helpfulCount"
  | "notHelpfulCount"
  | "lastVerifiedAt"
  | "updatedAt"
> & { tags: string[] };

type ArticleListResult = {
  items: ArticleListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

@Injectable()
export class KbArticleQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
  ) {}

  async list(user: CurrentUserContext, query: ListArticlesInput, scope?: DataScope): Promise<ArticleListResult> {
    if (scope === "none")
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0 };

    const ids = await this.access.getAccessibleSpaceIds(user);
    if (ids.length === 0)
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0 };

    const conditions: SQL[] = [eq(kbArticles.orgId, user.orgId), inArray(kbArticles.spaceId, ids)];
    if (scope && scope !== "all")
      conditions.push(applyScope(scope, user.orgId, user.userId, { ownerColumn: kbArticles.ownerId }));
    if (query.spaceId) conditions.push(eq(kbArticles.spaceId, query.spaceId));
    if (query.categoryId) conditions.push(eq(kbArticles.categoryId, query.categoryId));
    if (query.status) conditions.push(eq(kbArticles.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(kbArticles.title, term), ilike(kbArticles.excerpt, term));
      if (match) conditions.push(match);
    }

    const where = and(...conditions);
    const offset = (query.page - 1) * query.pageSize;

    const rows = await this.db
      .select({
        id: kbArticles.id,
        spaceId: kbArticles.spaceId,
        categoryId: kbArticles.categoryId,
        title: kbArticles.title,
        slug: kbArticles.slug,
        excerpt: kbArticles.excerpt,
        status: kbArticles.status,
        visibility: kbArticles.visibility,
        tags: sql<string[]>`ARRAY(
          SELECT kt.name FROM kb_article_tags kat
          JOIN kb_tags kt ON kt.id = kat.tag_id
          WHERE kat.article_id = ${kbArticles.id}
          ORDER BY kt.name
        )`,
        ownerId: kbArticles.ownerId,
        helpfulCount: kbArticles.helpfulCount,
        notHelpfulCount: kbArticles.notHelpfulCount,
        lastVerifiedAt: kbArticles.lastVerifiedAt,
        updatedAt: kbArticles.updatedAt,
        totalCount: sql<string>`count(*) OVER ()`,
      })
      .from(kbArticles)
      .where(where)
      .orderBy(desc(kbArticles.updatedAt))
      .limit(query.pageSize)
      .offset(offset);

    const first = rows[0];
    let total: number;
    if (first) {
      total = Number(first.totalCount);
    } else if (offset === 0) {
      total = 0;
    } else {
      const [countRow] = await this.db.select({ count: sql<number>`count(*)::int` }).from(kbArticles).where(where);
      total = countRow?.count ?? 0;
    }

    const items: ArticleListItem[] = rows.map((row) => {
      const { totalCount: _, ...item } = row;
      return item;
    });

    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async listVersions(user: CurrentUserContext, articleId: number): Promise<(typeof kbArticleVersions.$inferSelect)[]> {
    await this.access.assertArticleViewable(user, articleId);
    return this.db.query.kbArticleVersions.findMany({
      where: and(eq(kbArticleVersions.articleId, articleId), eq(kbArticleVersions.orgId, user.orgId)),
      orderBy: [desc(kbArticleVersions.versionNumber)],
      limit: 100,
    });
  }
}
