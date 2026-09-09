import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, or, inArray } from "drizzle-orm";
import {
  kbSpaces,
  kbSpaceMembers,
  kbArticles,
  kbArticleRestrictions,
  roles,
  roleAssignments,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { accountableMembershipId, actingMembershipId } from "../../../common/auth/principal";
import { CacheService } from "../../../common/cache/cache.service";
import { getAccessibleProjectIds } from "../retrieval/kb-project-access.util";
import { AccessService } from "../../access/access.service";
import { kbAclCacheKey, type KbAclDimension } from "./kb-acl-cache-key";

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
    const rows = await this.db
      .select({ slug: roles.slug })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .innerJoin(
        organizationMembers,
        eq(organizationMembers.id, roleAssignments.organizationMembershipId),
      )
      .where(
        and(
          eq(roleAssignments.orgId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.orgId, orgId),
        ),
      );
    return rows.map((r) => r.slug);
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
    const spaces = await this.db
      .select({ id: kbSpaces.id, audience: kbSpaces.audience })
      .from(kbSpaces)
      .where(and(eq(kbSpaces.orgId, user.orgId), isNull(kbSpaces.deletedAt)));

    if (await this.isAdmin(user)) return spaces.map((s) => s.id);

    const membershipId = acl.membershipId;
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    const roleSlugs = await this.resolveRoleSlugs(user.orgId, user.userId);
    const directMatch = eq(kbSpaceMembers.membershipId, membershipId);
    const grantedRows = await this.db
      .selectDistinct({ spaceId: kbSpaceMembers.spaceId })
      .from(kbSpaceMembers)
      .where(
        and(
          eq(kbSpaceMembers.orgId, user.orgId),
          roleSlugs.length > 0
            ? or(directMatch, inArray(kbSpaceMembers.role, roleSlugs))
            : directMatch,
        ),
      );

    const granted = new Set(grantedRows.map((m) => m.spaceId));

    return spaces
      .filter((s) => s.audience === "public" || s.audience === "mixed" || granted.has(s.id))
      .map((s) => s.id);
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
