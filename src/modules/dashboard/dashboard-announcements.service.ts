import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { announcements, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { type DashboardForbidden } from "./dashboard.errors";
import { type CreateAnnouncementInput } from "./dto/dashboard.schemas";

function canManageAnnouncements(role: string): boolean {
  return role === "CEO" || role === "HR" || role === "ADMIN";
}

@Injectable()
export class DashboardAnnouncementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  getActiveAnnouncements(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.announcementsList(orgId),
      () => {
        const now = new Date();
        return this.db
          .select({
            id: announcements.id,
            content: announcements.content,
            isPinned: announcements.isPinned,
            expiresAt: announcements.expiresAt,
            createdAt: announcements.createdAt,
            authorId: announcements.authorId,
            authorName: users.name,
            authorFirstName: users.firstName,
            authorLastName: users.lastName,
          })
          .from(announcements)
          .innerJoin(users, eq(announcements.authorId, users.id))
          .where(
            and(
              eq(announcements.orgId, orgId),
              or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)),
            ),
          )
          .orderBy(desc(announcements.isPinned), desc(announcements.createdAt))
          .limit(20);
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async createAnnouncement(
    orgId: string,
    authorId: string,
    role: string,
    input: CreateAnnouncementInput,
  ) {
    if (!canManageAnnouncements(role)) {
      return { error: "forbidden", message: "Forbidden" } as DashboardForbidden;
    }

    const [row] = await this.db
      .insert(announcements)
      .values({
        orgId,
        authorId,
        content: input.content,
        isPinned: input.isPinned ?? false,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning();

    await this.cache.invalidate(CACHE_KEYS.announcementsList(orgId));
    return row;
  }

  async deleteAnnouncement(orgId: string, role: string, id: number) {
    if (!canManageAnnouncements(role)) {
      return { error: "forbidden", message: "Forbidden" } as DashboardForbidden;
    }

    await this.db
      .delete(announcements)
      .where(and(eq(announcements.id, id), eq(announcements.orgId, orgId)));

    await this.cache.invalidate(CACHE_KEYS.announcementsList(orgId));
    return { success: true };
  }
}
