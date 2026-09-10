import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbArticleVersions } from "../../../db/schema";
import type { ScopedRead } from "../../access/scoped-read";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import { articleTsquery, resolveArticleKeywordSql } from "../core/kb-article-keyword-search";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ListArticlesInput } from "../core/dto/kb.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { actingMembershipId } from "../../../common/auth/principal";
import { articleOwnerScope } from "../retrieval/kb-article-owner-scope";

const ARTICLE_KEYWORD_ID_CAP = 500;

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
  | "ownerMembershipId"
  | "helpfulCount"
  | "notHelpfulCount"
  | "lastVerifiedAt"
  | "updatedAt"
> & { tags: string[] };

type ArticleListResult = {
  items: ArticleListItem[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
};

@Injectable()
export class KbArticleQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
  ) {}

  async list(user: CurrentUserContext, query: ListArticlesInput, scope: ScopedRead): Promise<ArticleListResult> {
    if (scope.denied)
      return { items: [], nextCursor: null, hasMore: false, limit: query.limit };

    const ids = await this.access.getAccessibleSpaceIds(user);
    if (ids.length === 0)
      return { items: [], nextCursor: null, hasMore: false, limit: query.limit };

    const domain: SQL[] = [inArray(kbArticles.spaceId, ids)];
    if (query.spaceId) domain.push(eq(kbArticles.spaceId, query.spaceId));
    if (query.categoryId) domain.push(eq(kbArticles.categoryId, query.categoryId));
    if (query.status) domain.push(eq(kbArticles.status, query.status));
    if (query.search) {
      const tsquery = articleTsquery(query.search);
      domain.push(
        await resolveArticleKeywordSql(this.db, query.search, tsquery, ARTICLE_KEYWORD_ID_CAP),
      );
    }

    const position = decodeCursor(query.cursor);
    if (position) domain.push(keysetBeforeId(kbArticles.updatedAt, kbArticles.id, position));

    const membershipId = actingMembershipId(user.principal);
    const where = scope
      ? scope.compose(
          { tenant: kbArticles.orgId, scope: articleOwnerScope(membershipId), and: domain },
          ({ sql: composed }) => composed,
          () => sql`false`,
        )
      : and(eq(kbArticles.orgId, user.orgId), ...domain);

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
        ownerMembershipId: kbArticles.ownerMembershipId,
        helpfulCount: kbArticles.helpfulCount,
        notHelpfulCount: kbArticles.notHelpfulCount,
        lastVerifiedAt: kbArticles.lastVerifiedAt,
        updatedAt: kbArticles.updatedAt,
      })
      .from(kbArticles)
      .where(where)
      .orderBy(desc(kbArticles.updatedAt), desc(kbArticles.id))
      .limit(query.limit + 1);

    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.updatedAt.toISOString(),
      id: String(row.id),
    }));

    return {
      items: page.data,
      nextCursor: page.pagination.nextCursor,
      hasMore: page.pagination.hasMore,
      limit: page.pagination.limit,
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
