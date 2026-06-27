import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  kbSpaces,
  kbSpaceMembers,
  kbArticles,
  kbArticleRestrictions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const KB_MANAGE_SPACES = "kb:spaces:manage";

@Injectable()
export class KbAccessService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  isAdmin(user: CurrentUserContext): boolean {
    return (
      user.isPlatformAdmin || user.isOrgOwner || user.permissions.includes(KB_MANAGE_SPACES)
    );
  }

  async getAccessibleSpaceIds(user: CurrentUserContext): Promise<number[]> {
    const spaces = await this.db
      .select({ id: kbSpaces.id, audience: kbSpaces.audience })
      .from(kbSpaces)
      .where(and(eq(kbSpaces.orgId, user.orgId), isNull(kbSpaces.deletedAt)));

    if (this.isAdmin(user)) return spaces.map((s) => s.id);

    const members = await this.db
      .select({ spaceId: kbSpaceMembers.spaceId, userId: kbSpaceMembers.userId, role: kbSpaceMembers.role })
      .from(kbSpaceMembers)
      .where(eq(kbSpaceMembers.orgId, user.orgId));

    const restricted = new Set(members.map((m) => m.spaceId));
    const granted = new Set(
      members
        .filter((m) => m.userId === user.userId || (m.role !== null && m.role === user.role))
        .map((m) => m.spaceId),
    );

    return spaces
      .filter((s) => s.audience === "public" || granted.has(s.id) || !restricted.has(s.id))
      .map((s) => s.id);
  }

  async assertSpaceAccessible(user: CurrentUserContext, spaceId: number): Promise<void> {
    const ids = await this.getAccessibleSpaceIds(user);
    if (!ids.includes(spaceId)) throw new NotFoundException("Space not found");
  }

  async assertArticleViewable(user: CurrentUserContext, articleId: number) {
    const article = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, user.orgId)),
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
          eq(kbArticleRestrictions.articleId, articleId),
          eq(kbArticleRestrictions.level, "view"),
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
