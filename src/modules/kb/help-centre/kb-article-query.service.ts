import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { kbPages, kbPageVersions } from "../../../db/schema";
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
import { pageContentToArticleContent, pageVisibilityToArticle, supportArticlePredicate } from "./kb-article-page-scope";
import type {
  kbArticleListItemSchema,
  kbArticleVersionSchema,
} from "./dto/kb-helpcenter-response.schemas";

const ARTICLE_KEYWORD_ID_CAP = 500;

type ArticleListItem = z.infer<typeof kbArticleListItemSchema>;

type ArticleVersion = z.infer<typeof kbArticleVersionSchema>;

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

    const domain: SQL[] = [supportArticlePredicate(), inArray(kbPages.spaceId, ids)];
    if (query.spaceId) domain.push(eq(kbPages.spaceId, query.spaceId));
    if (query.categoryId) domain.push(eq(kbPages.categoryId, query.categoryId));
    if (query.status) domain.push(eq(kbPages.status, query.status));
    if (query.search) {
      const tsquery = articleTsquery(query.search);
      domain.push(
        await resolveArticleKeywordSql(this.db, query.search, tsquery, ARTICLE_KEYWORD_ID_CAP),
      );
    }

    const position = decodeCursor(query.cursor);
    if (position) domain.push(keysetBeforeId(kbPages.updatedAt, kbPages.id, position));

    const membershipId = actingMembershipId(user.principal);
    const where = scope
      ? scope.compose(
          { tenant: kbPages.orgId, scope: articleOwnerScope(membershipId), and: domain },
          ({ sql: composed }) => composed,
          () => sql`false`,
        )
      : and(eq(kbPages.orgId, user.orgId), ...domain);

    const rows = await this.db
      .select({
        id: kbPages.id,
        spaceId: kbPages.spaceId,
        categoryId: kbPages.categoryId,
        title: kbPages.title,
        slug: kbPages.slug,
        excerpt: kbPages.excerpt,
        status: kbPages.status,
        visibility: kbPages.visibility,
        tags: sql<string[]>`ARRAY(
          SELECT kt.name FROM kb_page_tags kpt
          JOIN kb_tags kt ON kt.id = kpt.tag_id
          WHERE kpt.page_id = ${kbPages.id}
          ORDER BY kt.name
        )`,
        ownerMembershipId: kbPages.ownerMembershipId,
        helpfulCount: kbPages.helpfulCount,
        notHelpfulCount: kbPages.notHelpfulCount,
        verifiedAt: kbPages.verifiedAt,
        updatedAt: kbPages.updatedAt,
      })
      .from(kbPages)
      .where(where)
      .orderBy(desc(kbPages.updatedAt), desc(kbPages.id))
      .limit(query.limit + 1);

    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.updatedAt.toISOString(),
      id: String(row.id),
    }));

    return {
      items: page.data.map(function toListItem(row): ArticleListItem {
        return {
          id: row.id,
          spaceId: row.spaceId,
          categoryId: row.categoryId,
          title: row.title,
          slug: row.slug ?? "",
          excerpt: row.excerpt,
          status: row.status,
          visibility: pageVisibilityToArticle(row.visibility),
          ownerMembershipId: row.ownerMembershipId,
          helpfulCount: row.helpfulCount ?? 0,
          notHelpfulCount: row.notHelpfulCount ?? 0,
          lastVerifiedAt: row.verifiedAt,
          updatedAt: row.updatedAt,
          tags: row.tags,
        };
      }),
      nextCursor: page.pagination.nextCursor,
      hasMore: page.pagination.hasMore,
      limit: page.pagination.limit,
    };
  }

  async listVersions(user: CurrentUserContext, articleId: number): Promise<ArticleVersion[]> {
    await this.access.assertArticleViewable(user, articleId);
    const rows = await this.db
      .select({
        id: kbPageVersions.id,
        orgId: kbPageVersions.orgId,
        pageId: kbPageVersions.pageId,
        versionNumber: kbPageVersions.versionNumber,
        title: kbPageVersions.title,
        content: kbPageVersions.content,
        excerpt: kbPageVersions.excerpt,
        changeSummary: kbPageVersions.changeSummary,
        authorId: kbPageVersions.authorId,
        authorMembershipId: kbPageVersions.authorMembershipId,
        createdAt: kbPageVersions.createdAt,
      })
      .from(kbPageVersions)
      .where(and(eq(kbPageVersions.pageId, articleId), eq(kbPageVersions.orgId, user.orgId)))
      .orderBy(desc(kbPageVersions.versionNumber))
      .limit(100);

    return rows.map(function toArticleVersion(row): ArticleVersion {
      return {
        id: row.id,
        orgId: row.orgId,
        articleId: row.pageId,
        versionNumber: row.versionNumber,
        title: row.title,
        content: pageContentToArticleContent(row.content),
        excerpt: row.excerpt,
        changeSummary: row.changeSummary,
        authorId: row.authorId,
        authorMembershipId: row.authorMembershipId,
        createdAt: row.createdAt,
      };
    });
  }
}
