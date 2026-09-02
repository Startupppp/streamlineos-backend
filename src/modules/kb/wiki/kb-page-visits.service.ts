import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
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
import { pageVisibleTo } from "../retrieval/kb-page-visibility";
import { getAccessibleProjectIds } from "../retrieval/kb-project-access.util";
import { assertPageAccessible } from "../retrieval/kb-page-access.util";
import { KB_PAGE_LIST_COLUMNS, type KbPageListItem, type KbPageRow } from "./kb-page-columns";

type PageRow = KbPageRow;


@Injectable()
export class KbPageVisitsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

  private getAccessibleProjectIds(user: CurrentUserContext): Promise<number[]> {
    return getAccessibleProjectIds(this.db, user);
  }

  async getRecent(user: CurrentUserContext): Promise<KbPageListItem[]> {
    const orgId = user.orgId;
    const membershipId = await this.activeMembershipId(user);
    const [visits, projectIds] = await Promise.all([
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
      this.getAccessibleProjectIds(user),
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
          pageVisibleTo(user, projectIds),
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
    const [favs, projectIds] = await Promise.all([
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
      this.getAccessibleProjectIds(user),
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
          pageVisibleTo(user, projectIds),
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
    await assertPageAccessible(this.db, user, pageId);
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
    await this.db
      .delete(kbPageFavorites)
      .where(
        and(
          eq(kbPageFavorites.pageId, pageId),
          eq(kbPageFavorites.userId, user.userId),
          eq(kbPageFavorites.orgId, orgId),
          eq(kbPageFavorites.membershipId, membershipId),
        ),
      );
    return { success: true };
  }

  async recordVisit(
    user: CurrentUserContext,
    pageId: number,
  ): Promise<{ success: boolean }> {
    const orgId = user.orgId;
    const membershipId = await this.activeMembershipId(user);
    await assertPageAccessible(this.db, user, pageId);
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
  ): Promise<Pick<PageRow, "id" | "title" | "icon">[]> {
    const orgId = user.orgId;
    await assertPageAccessible(this.db, user, pageId);
    const [links, projectIds] = await Promise.all([
      this.db
        .select({ sourcePageId: kbPageLinks.sourcePageId })
        .from(kbPageLinks)
        .where(
          and(
            eq(kbPageLinks.orgId, orgId),
            eq(kbPageLinks.targetPageId, pageId),
          ),
        )
        .limit(200),
      this.getAccessibleProjectIds(user),
    ]);

    if (links.length === 0) return [];
    const ids = links.map((l) => l.sourcePageId);
    return this.db
      .select({ id: kbPages.id, title: kbPages.title, icon: kbPages.icon })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          pageVisibleTo(user, projectIds),
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[])`,
        ),
      );
  }
}
