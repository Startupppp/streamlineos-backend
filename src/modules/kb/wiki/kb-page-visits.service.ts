import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  kbPages,
  kbPageFavorites,
  kbPageLinks,
  kbPageVisits,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  KB_PAGE_LIST_COLUMNS,
  type KbPageListItem,
  type KbPageRow,
} from "./kb-page-columns";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { buildCursorPage, decodeIntegerCursor, type CursorPage } from "../../../common/pagination/cursor";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

type PageRow = KbPageRow;

@Injectable()
export class KbPageVisitsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  private async activeMembershipId(user: CurrentUserContext): Promise<number> {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, user.orgId),
        eq(organizationMembers.userId, user.userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!membership)
      throw new ForbiddenException(
        "Active organization membership is required",
      );
    return membership.id;
  }

  async getRecent(user: CurrentUserContext): Promise<KbPageListItem[]> {
    const orgId = user.orgId;
    const membershipId = await this.activeMembershipId(user);
    const [visits, predicate] = await Promise.all([
      this.db
        .select({ pageId: kbPageVisits.pageId })
        .from(kbPageVisits)
        .where(
          and(
            eq(kbPageVisits.orgId, orgId),
            eq(kbPageVisits.membershipId, membershipId),
          ),
        )
        .orderBy(desc(kbPageVisits.visitedAt))
        .limit(20),
      this.auth.visiblePagePredicate(user, "view"),
    ]);

    if (visits.length === 0) return [];
    const ids = visits.map((v) => v.pageId);
    const pages = await this.db
      .select(KB_PAGE_LIST_COLUMNS)
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          predicate,
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[])`,
        ),
      );
    const pageMap = new Map(pages.map((p) => [p.id, p]));
    return ids
      .map((id) => pageMap.get(id))
      .filter((p): p is KbPageListItem => p !== undefined);
  }

  async getFavorites(user: CurrentUserContext): Promise<KbPageListItem[]> {
    const orgId = user.orgId;
    const membershipId = await this.activeMembershipId(user);
    const [favs, predicate] = await Promise.all([
      this.db
        .select({ pageId: kbPageFavorites.pageId })
        .from(kbPageFavorites)
        .where(
          and(
            eq(kbPageFavorites.orgId, orgId),
            eq(kbPageFavorites.membershipId, membershipId),
          ),
        )
        .orderBy(asc(kbPageFavorites.sortOrder), asc(kbPageFavorites.createdAt))
        .limit(50),
      this.auth.visiblePagePredicate(user, "view"),
    ]);

    if (favs.length === 0) return [];
    const ids = favs.map((f) => f.pageId);
    const pages = await this.db
      .select(KB_PAGE_LIST_COLUMNS)
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          predicate,
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[])`,
        ),
      );
    const pageMap = new Map(pages.map((p) => [p.id, p]));
    return ids
      .map((id) => pageMap.get(id))
      .filter((p): p is KbPageListItem => p !== undefined);
  }

  async addFavorite(
    user: CurrentUserContext,
    pageId: number,
  ): Promise<{ success: boolean }> {
    const orgId = user.orgId;
    const membershipId = await this.activeMembershipId(user);
    await this.auth.assertPageAccess(user, pageId, "view");
    await this.db
      .insert(kbPageFavorites)
      .values({ orgId, pageId, userId: user.userId, membershipId })
      .onConflictDoNothing();
    return { success: true };
  }

  async removeFavorite(
    user: CurrentUserContext,
    pageId: number,
  ): Promise<{ success: boolean }> {
    const orgId = user.orgId;
    const membershipId = await this.activeMembershipId(user);
    const removed = await this.db
      .delete(kbPageFavorites)
      .where(
        and(
          eq(kbPageFavorites.pageId, pageId),
          eq(kbPageFavorites.userId, user.userId),
          eq(kbPageFavorites.orgId, orgId),
          eq(kbPageFavorites.membershipId, membershipId),
        ),
      )
      .returning({ pageId: kbPageFavorites.pageId });
    if (removed.length === 0) throw new NotFoundException("Favorite not found");
    return { success: true };
  }

  async recordVisit(
    user: CurrentUserContext,
    pageId: number,
  ): Promise<{ success: boolean }> {
    const orgId = user.orgId;
    const membershipId = await this.activeMembershipId(user);
    await this.auth.assertPageAccess(user, pageId, "view");
    await this.db
      .insert(kbPageVisits)
      .values({
        orgId,
        pageId,
        userId: user.userId,
        membershipId,
        visitedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          kbPageVisits.orgId,
          kbPageVisits.pageId,
          kbPageVisits.membershipId,
        ],
        set: { visitedAt: new Date() },
      });
    return { success: true };
  }

  async getBacklinks(
    user: CurrentUserContext,
    pageId: number,
    cursor?: string,
    limit = 50,
  ): Promise<CursorPage<Pick<PageRow, "id" | "title" | "icon">>> {
    const orgId = user.orgId;
    await this.auth.assertPageAccess(user, pageId, "view");
    const pageSize = Math.min(Math.max(1, limit), PAGE_SIZE_CAP);
    const position = decodeIntegerCursor(cursor);
    const afterLink = position
      ? sql`${kbPageLinks.id} > ${sql.param(position.id, kbPageLinks.id)}`
      : undefined;
    const [linksResult, predicate] = await Promise.all([
      this.db
        .select({ id: kbPageLinks.id, sourcePageId: kbPageLinks.sourcePageId })
        .from(kbPageLinks)
        .where(
          and(
            eq(kbPageLinks.orgId, orgId),
            eq(kbPageLinks.targetPageId, pageId),
            afterLink,
          ),
        )
        .orderBy(asc(kbPageLinks.id))
        .limit(pageSize + 1),
      this.auth.visiblePagePredicate(user, "view"),
    ]);

    const { data: linksPage, pagination } = buildCursorPage(linksResult, pageSize, (link) => ({
      sortValue: String(link.id),
      id: String(link.id),
    }));

    if (linksPage.length === 0) {
      return { data: [], pagination };
    }

    const ids = linksPage.map((l) => l.sourcePageId);
    const pages = await this.db
      .select({ id: kbPages.id, title: kbPages.title, icon: kbPages.icon })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          predicate,
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[])`,
        ),
      );
    const pageMap = new Map(pages.map((p) => [p.id, p]));
    const data = ids
      .map((id) => pageMap.get(id))
      .filter((p): p is Pick<PageRow, "id" | "title" | "icon"> => p !== undefined);
    return { data, pagination };
  }
}
