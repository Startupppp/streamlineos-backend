import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, or, inArray } from "drizzle-orm";
import {
  kbSpaces,
  kbSpaceMembers,
  kbArticles,
  kbArticleRestrictions,
  kbSpaceGrants,
  roles,
  roleAssignments,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CacheService } from "../../common/cache/cache.service";

const KB_MANAGE_SPACES = "kb:spaces:manage";
const KB_SPACE_VIEWER_PERMISSION = "kb:space:viewer";

@Injectable()
export class KbAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  isAdmin(user: CurrentUserContext): boolean {
    return (
      user.isOrgOwner || user.permissions.includes(KB_MANAGE_SPACES)
    );
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

  private accessibleSpacesKey(orgId: string, userId: string): string {
    return `kb:acc-spaces:${orgId}:${userId}`;
  }

  async getAccessibleSpaceIds(user: CurrentUserContext): Promise<number[]> {
    return this.cache.cached(
      this.accessibleSpacesKey(user.orgId, user.userId),
      () => this.computeAccessibleSpaceIds(user),
      60,
    );
  }

  async invalidateAccessibleSpaceIds(orgId: string): Promise<void> {
    await this.cache.invalidatePattern(`kb:acc-spaces:${orgId}:*`);
  }

  private async computeAccessibleSpaceIds(user: CurrentUserContext): Promise<number[]> {
    const spaces = await this.db
      .select({ id: kbSpaces.id, audience: kbSpaces.audience })
      .from(kbSpaces)
      .where(and(eq(kbSpaces.orgId, user.orgId), isNull(kbSpaces.deletedAt)));

    if (this.isAdmin(user)) return spaces.map((s) => s.id);

    const roleSlugs = await this.resolveRoleSlugs(user.orgId, user.userId);
    const grantedRows = await this.db
      .selectDistinct({ spaceId: kbSpaceMembers.spaceId })
      .from(kbSpaceMembers)
      .where(
        and(
          eq(kbSpaceMembers.orgId, user.orgId),
          roleSlugs.length > 0
            ? or(
                eq(kbSpaceMembers.userId, user.userId),
                inArray(kbSpaceMembers.role, roleSlugs),
              )
            : eq(kbSpaceMembers.userId, user.userId),
        ),
      );

    const restrictedRows = await this.db
      .selectDistinct({ spaceId: kbSpaceMembers.spaceId })
      .from(kbSpaceMembers)
      .where(eq(kbSpaceMembers.orgId, user.orgId));

    const granted = new Set(grantedRows.map((m) => m.spaceId));
    const restricted = new Set(restrictedRows.map((m) => m.spaceId));

    const memberAccessIds = spaces
      .filter(
        (s) =>
          s.audience === "public" ||
          s.audience === "mixed" ||
          granted.has(s.id) ||
          !restricted.has(s.id),
      )
      .map((s) => s.id);

    const explicitGrantRows = await this.db
      .selectDistinct({ spaceId: kbSpaceGrants.spaceId })
      .from(kbSpaceGrants)
      .where(
        and(
          eq(kbSpaceGrants.orgId, user.orgId),
          eq(kbSpaceGrants.principalType, "user"),
          eq(kbSpaceGrants.principalId, user.userId),
          eq(kbSpaceGrants.permissionKey, KB_SPACE_VIEWER_PERMISSION),
        ),
      );
    const explicitGrantedIds = explicitGrantRows.map((r) => r.spaceId);

    return [...new Set([...memberAccessIds, ...explicitGrantedIds])];
  }

  async assertSpaceAccessible(user: CurrentUserContext, spaceId: number): Promise<void> {
    const ids = await this.getAccessibleSpaceIds(user);
    if (!ids.includes(spaceId)) throw new NotFoundException("Space not found");
  }

  async getPrincipalIds(
    user: CurrentUserContext,
  ): Promise<{ userId: string; roleSlugs: string[] }> {
    return {
      userId: user.userId,
      roleSlugs: await this.resolveRoleSlugs(user.orgId, user.userId),
    };
  }

  async assertCanViewArticle(
    user: CurrentUserContext,
    row: { id: number; orgId: string; spaceId: number | null },
  ): Promise<void> {
    if (this.isAdmin(user)) return;

    if (row.spaceId !== null) {
      const accessible = await this.getAccessibleSpaceIds(user);
      if (!accessible.includes(row.spaceId)) {
        throw new NotFoundException("Article not found");
      }
    }

    const restrictions = await this.db
      .select({ userId: kbArticleRestrictions.userId, role: kbArticleRestrictions.role })
      .from(kbArticleRestrictions)
      .where(
        and(
          eq(kbArticleRestrictions.orgId, row.orgId),
          eq(kbArticleRestrictions.articleId, row.id),
          eq(kbArticleRestrictions.level, "view"),
        ),
      );
    if (restrictions.length > 0) {
      const roleSlugs = await this.resolveRoleSlugs(user.orgId, user.userId);
      const allowed = restrictions.some(
        (r) => r.userId === user.userId || (r.role !== null && roleSlugs.includes(r.role)),
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
    if (this.isAdmin(user)) return article;

    if (article.spaceId !== null) {
      const accessible = await this.getAccessibleSpaceIds(user);
      if (!accessible.includes(article.spaceId)) {
        throw new NotFoundException("Article not found");
      }
    }

    const restrictions = await this.db
      .select({ userId: kbArticleRestrictions.userId, role: kbArticleRestrictions.role })
      .from(kbArticleRestrictions)
      .where(
        and(
          eq(kbArticleRestrictions.orgId, user.orgId),
          eq(kbArticleRestrictions.articleId, articleId),
          eq(kbArticleRestrictions.level, "edit"),
        ),
      );
    if (restrictions.length > 0) {
      const roleSlugs = await this.resolveRoleSlugs(user.orgId, user.userId);
      const allowed = restrictions.some(
        (r) => r.userId === user.userId || (r.role !== null && roleSlugs.includes(r.role)),
      );
      if (!allowed) throw new NotFoundException("Article not found");
    }
    return article;
  }
}
