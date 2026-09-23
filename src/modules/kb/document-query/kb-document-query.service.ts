import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { kbArticles, kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import { AccessService } from "../../access/access.service";
import { resolveKbArticlesViewScope } from "../core/kb-scope";
import { articleOwnerScope } from "../retrieval/kb-article-owner-scope";
import { buildArticleRestrictionPredicate } from "../retrieval/kb-article-restriction-predicate";
import { actingMembershipId } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";

export type KbDocumentHit =
  | {
      kind: "article";
      id: number;
      title: string;
      slug: string;
      spaceId: number | null;
      excerpt: string | null;
      status: "draft" | "in_review" | "published" | "archived";
      updatedAt: Date;
    }
  | {
      kind: "page";
      id: number;
      title: string;
      spaceId: number | null;
      status: string;
      updatedAt: Date;
    };

const KB_DOCUMENT_QUERY_CAP = 20;

@Injectable()
export class KbDocumentQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly kbAccess: KbAccessService,
    private readonly access: AccessService,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  async searchDocuments(
    user: CurrentUserContext,
    query: string,
    limit: number,
  ): Promise<KbDocumentHit[]> {
    const cap = Math.min(limit, KB_DOCUMENT_QUERY_CAP);
    const term = `%${query}%`;

    const [articleRead, spaceIds, predicate] = await Promise.all([
      resolveKbArticlesViewScope(this.access, user),
      this.kbAccess.getAccessibleSpaceIds(user),
      this.auth.visiblePagePredicate(user, "view"),
    ]);

    const results: KbDocumentHit[] = [];

    if (!articleRead.denied && spaceIds.length > 0) {
      const [isAdmin, principal] = await Promise.all([
        this.kbAccess.isAdmin(user),
        this.kbAccess.getPrincipalIds(user),
      ]);

      const membershipId =
        user.principal === undefined ? null : actingMembershipId(user.principal);
      const domain: SQL[] = [
        inArray(kbArticles.spaceId, spaceIds),
        ne(kbArticles.status, "archived"),
        sql`${kbArticles.title} ILIKE ${term}`,
      ];
      if (!isAdmin) domain.push(buildArticleRestrictionPredicate(user.orgId, principal));

      const where = articleRead.compose(
        { tenant: kbArticles.orgId, scope: articleOwnerScope(membershipId), and: domain },
        ({ sql: composed }) => composed,
        () => sql`false`,
      );

      const articleRows = await this.db
        .select({
          id: kbArticles.id,
          title: kbArticles.title,
          slug: kbArticles.slug,
          spaceId: kbArticles.spaceId,
          excerpt: kbArticles.excerpt,
          status: kbArticles.status,
          updatedAt: kbArticles.updatedAt,
        })
        .from(kbArticles)
        .where(where)
        .orderBy(desc(kbArticles.updatedAt))
        .limit(cap);

      for (const row of articleRows) results.push({ kind: "article", ...row });
    }

    const pageRows = await this.db
      .select({
        id: kbPages.id,
        title: kbPages.title,
        spaceId: kbPages.spaceId,
        status: kbPages.status,
        updatedAt: kbPages.updatedAt,
      })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, user.orgId),
          isNull(kbPages.deletedAt),
          ne(kbPages.status, "archived"),
          sql`${kbPages.title} ILIKE ${term}`,
          predicate,
        ),
      )
      .orderBy(desc(kbPages.updatedAt))
      .limit(cap);

    for (const row of pageRows) results.push({ kind: "page", ...row });

    return results;
  }
}
