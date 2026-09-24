import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbArticles, kbArticleRestrictions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { accountableMembershipId, actingMembershipId } from "../../../common/auth/principal";
import { CacheService } from "../../../common/cache/cache.service";
import { getAccessibleProjectIds } from "../retrieval/kb-project-access.util";
import { AccessService } from "../../access/access.service";
import { kbAclCacheKey, type KbAclDimension } from "./kb-acl-cache-key";
import {
  computeAccessibleSpaceIds,
  resolveRoleSlugs,
} from "./authorization/knowledge-space-scope";

const KB_MANAGE_SPACES = "kb:spaces:manage";

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

  private async resolveAclDimension(user: CurrentUserContext): Promise<KbAclDimension> {
    return {
      orgId: user.orgId,
      permissionsVersion: await this.access.getPermissionsVersion(user.orgId),
      membershipId: user.principal !== undefined ? accountableMembershipId(user.principal) : null,
    };
  }

  async getAccessibleSpaceIds(user: CurrentUserContext): Promise<number[]> {
    const acl = await this.resolveAclDimension(user);
    return this.cache.cachedVersioned(
      `kb:acc-spaces:${user.orgId}`,
      kbAclCacheKey(user.userId, acl),
      () => this.computeAccessibleSpaceIds(user, acl),
      60,
    );
  }

  async invalidateAccessibleSpaceIds(orgId: string): Promise<void> {
    await this.cache.invalidateNamespace(`kb:acc-spaces:${orgId}`);
  }

  async getAccessibleProjectIds(user: CurrentUserContext): Promise<number[]> {
    return getAccessibleProjectIds(this.db, user);
  }

  private async computeAccessibleSpaceIds(
    user: CurrentUserContext,
    acl: KbAclDimension,
  ): Promise<number[]> {
    const isAdmin = await this.isAdmin(user);
    if (!isAdmin && acl.membershipId === null) {
      throw new ForbiddenException("Organization membership required");
    }
    return computeAccessibleSpaceIds(this.db, user.orgId, acl.membershipId, isAdmin, () =>
      this.resolveRoleSlugs(user.orgId, user.userId),
    );
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
      .select({ membershipId: kbArticleRestrictions.membershipId, role: kbArticleRestrictions.role })
      .from(kbArticleRestrictions)
      .where(
        and(
          eq(kbArticleRestrictions.orgId, row.orgId),
          eq(kbArticleRestrictions.articleId, row.id),
          eq(kbArticleRestrictions.level, "view"),
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
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, user.orgId)),
      columns: { id: true, orgId: true, spaceId: true },
    });
    if (!article) throw new NotFoundException("Article not found");
    await this.assertCanViewArticle(user, article);
  }

  async assertArticleEditable(
    user: CurrentUserContext,
    articleId: number,
  ): Promise<{ id: number; orgId: string; spaceId: number | null }> {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, user.orgId)),
      columns: { id: true, orgId: true, spaceId: true },
    });
    if (!article) throw new NotFoundException("Article not found");
    if (await this.isAdmin(user)) return article;

    if (article.spaceId !== null) {
      const accessible = await this.getAccessibleSpaceIds(user);
      if (!accessible.includes(article.spaceId)) {
        throw new NotFoundException("Article not found");
      }
    }

    const restrictions = await this.db
      .select({ membershipId: kbArticleRestrictions.membershipId, role: kbArticleRestrictions.role })
      .from(kbArticleRestrictions)
      .where(
        and(
          eq(kbArticleRestrictions.orgId, user.orgId),
          eq(kbArticleRestrictions.articleId, articleId),
          eq(kbArticleRestrictions.level, "edit"),
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
}
