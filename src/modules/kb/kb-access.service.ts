import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  kbSpaces,
  kbSpaceMembers,
  kbArticles,
  kbArticleRestrictions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ResourceGrantsService } from "../access/resource-grants.service";
import { CacheService } from "../../common/cache/cache.service";

const KB_MANAGE_SPACES = "kb:spaces:manage";
const KB_SPACE_RESOURCE_TYPE = "kb:space";
const KB_SPACE_VIEWER_PERMISSION = "kb:space:viewer";

@Injectable()
export class KbAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly resourceGrants: ResourceGrantsService,
    private readonly cache: CacheService,
  ) {}

  isAdmin(user: CurrentUserContext): boolean {
    return (
      user.isPlatformAdmin || user.isOrgOwner || user.permissions.includes(KB_MANAGE_SPACES)
    );
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

    const grantedRows = await this.db
      .selectDistinct({ spaceId: kbSpaceMembers.spaceId })
      .from(kbSpaceMembers)
      .where(
        and(
          eq(kbSpaceMembers.orgId, user.orgId),
          or(eq(kbSpaceMembers.userId, user.userId), eq(kbSpaceMembers.role, user.role)),
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

    const grantedSpaceIdStrings = await Promise.all(
      spaces.map(async (s) => {
        const has = await this.resourceGrants.hasGrant(
          user.orgId,
          user.userId,
          KB_SPACE_RESOURCE_TYPE,
          String(s.id),
          KB_SPACE_VIEWER_PERMISSION,
        );
        return has ? s.id : null;
      }),
    );
    const resourceGrantedIds = grantedSpaceIdStrings.filter((id): id is number => id !== null);

    return [...new Set([...memberAccessIds, ...resourceGrantedIds])];
  }

  async assertSpaceAccessible(user: CurrentUserContext, spaceId: number): Promise<void> {
    const ids = await this.getAccessibleSpaceIds(user);
    if (!ids.includes(spaceId)) throw new NotFoundException("Space not found");
  }

  getPrincipalIds(user: CurrentUserContext): { userId: string; role: string } {
    return { userId: user.userId, role: user.role };
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
      const allowed = restrictions.some(
        (r) => r.userId === user.userId || (r.role !== null && r.role === user.role),
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
      const allowed = restrictions.some(
        (r) => r.userId === user.userId || (r.role !== null && r.role === user.role),
      );
      if (!allowed) throw new NotFoundException("Article not found");
    }
    return article;
  }
}
