import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbPages, kbPageRestrictions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { CacheService } from "../../../common/cache/cache.service";
import { getAccessibleProjectIds } from "../retrieval/kb-project-access.util";
import { supportArticlePredicate } from "../help-centre/kb-article-page-scope";
import { AccessService } from "../../access/access.service";
import {
  KB_MANAGE_SPACES,
  resolveAccessibleSpaceScope,
  resolveAccessibleSpaceScopeWithOutcome,
  type KbAccessibleSpaceScope,
  type KbSpaceScopeDeps,
} from "./kb-acl-cache-key";
import { resolveRoleSlugs } from "./authorization/knowledge-space-scope";

@Injectable()
export class KbAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async isAdmin(user: CurrentUserContext): Promise<boolean> {
    return this.access.holds(user, KB_MANAGE_SPACES);
  }

  private async resolveRoleSlugs(orgId: string, userId: string): Promise<string[]> {
    return resolveRoleSlugs(this.db, orgId, userId);
  }

  private spaceScopeDeps(): KbSpaceScopeDeps {
    return { db: this.db, cache: this.cache, access: this.access };
  }

  private assertScopeReachable(scope: KbAccessibleSpaceScope): void {
    if (!scope.isAdmin && scope.membershipId === null) {
      throw new ForbiddenException("Organization membership required");
    }
  }

  async getAccessibleSpaceIds(user: CurrentUserContext): Promise<number[]> {
    const scope = await resolveAccessibleSpaceScope(this.spaceScopeDeps(), user);
    this.assertScopeReachable(scope);
    return scope.spaceIds;
  }

  async getAccessibleSpaceIdsWithCacheOutcome(
    user: CurrentUserContext,
  ): Promise<{ spaceIds: number[]; cacheOutcome: "hit" | "miss" | "bypass" }> {
    const scope = await resolveAccessibleSpaceScopeWithOutcome(this.spaceScopeDeps(), user);
    this.assertScopeReachable(scope);
    return { spaceIds: scope.spaceIds, cacheOutcome: scope.cacheOutcome };
  }

  async invalidateAccessibleSpaceIds(orgId: string): Promise<void> {
    await this.cache.invalidateNamespace(`kb:acc-spaces:${orgId}`);
  }

  async getAccessibleProjectIds(user: CurrentUserContext): Promise<number[]> {
    return getAccessibleProjectIds(this.db, user);
  }

  async assertSpaceAccessible(user: CurrentUserContext, spaceId: number): Promise<void> {
    const ids = await this.getAccessibleSpaceIds(user);
    if (!ids.includes(spaceId)) throw new NotFoundException("Space not found");
  }

  async getPrincipalIds(
    user: CurrentUserContext,
  ): Promise<{ userId: string; membershipId: number | null; roleSlugs: string[] }> {
    return {
      userId: user.userId,
      membershipId: user.principal !== undefined ? actingMembershipId(user.principal) : null,
      roleSlugs: await this.resolveRoleSlugs(user.orgId, user.userId),
    };
  }

  async assertCanViewArticle(
    user: CurrentUserContext,
    row: { id: number; orgId: string; spaceId: number | null },
  ): Promise<void> {
    if (await this.isAdmin(user)) return;

    if (row.spaceId !== null) {
      const accessible = await this.getAccessibleSpaceIds(user);
      if (!accessible.includes(row.spaceId)) {
        throw new NotFoundException("Article not found");
      }
    }

    const restrictions = await this.db
      .select({ membershipId: kbPageRestrictions.membershipId, role: kbPageRestrictions.role })
      .from(kbPageRestrictions)
      .where(
        and(
          eq(kbPageRestrictions.orgId, row.orgId),
          eq(kbPageRestrictions.pageId, row.id),
          eq(kbPageRestrictions.level, "view"),
        ),
      );
    if (restrictions.length > 0) {
      const membershipId = user.principal !== undefined ? actingMembershipId(user.principal) : null;
      const roleSlugs = await this.resolveRoleSlugs(user.orgId, user.userId);
      const allowed = restrictions.some(
        (r) =>
          (membershipId !== null && r.membershipId === membershipId) ||
          (r.role !== null && roleSlugs.includes(r.role)),
      );
      if (!allowed) throw new NotFoundException("Article not found");
    }
  }

  async assertArticleViewable(user: CurrentUserContext, articleId: number): Promise<void> {
    const article = await this.findArticle(user.orgId, articleId);
    if (!article) throw new NotFoundException("Article not found");
    await this.assertCanViewArticle(user, article);
  }

  async assertArticleEditable(
    user: CurrentUserContext,
    articleId: number,
  ): Promise<{ id: number; orgId: string; spaceId: number | null }> {
    const article = await this.findArticle(user.orgId, articleId);
    if (!article) throw new NotFoundException("Article not found");
    if (await this.isAdmin(user)) return article;

    if (article.spaceId !== null) {
      const accessible = await this.getAccessibleSpaceIds(user);
      if (!accessible.includes(article.spaceId)) {
        throw new NotFoundException("Article not found");
      }
    }

    const restrictions = await this.db
      .select({ membershipId: kbPageRestrictions.membershipId, role: kbPageRestrictions.role })
      .from(kbPageRestrictions)
      .where(
        and(
          eq(kbPageRestrictions.orgId, user.orgId),
          eq(kbPageRestrictions.pageId, articleId),
          eq(kbPageRestrictions.level, "edit"),
        ),
      );
    if (restrictions.length > 0) {
      const membershipId = user.principal !== undefined ? actingMembershipId(user.principal) : null;
      const roleSlugs = await this.resolveRoleSlugs(user.orgId, user.userId);
      const allowed = restrictions.some(
        (r) =>
          (membershipId !== null && r.membershipId === membershipId) ||
          (r.role !== null && roleSlugs.includes(r.role)),
      );
      if (!allowed) throw new NotFoundException("Article not found");
    }
    return article;
  }

  private async findArticle(
    orgId: string,
    articleId: number,
  ): Promise<{ id: number; orgId: string; spaceId: number | null } | undefined> {
    return this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, articleId),
        eq(kbPages.orgId, orgId),
        supportArticlePredicate(),
      ),
      columns: { id: true, orgId: true, spaceId: true },
    });
  }
}
