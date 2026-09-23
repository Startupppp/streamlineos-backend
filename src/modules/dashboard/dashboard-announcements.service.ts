import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { broadcasts, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { type DashboardActor, type DashboardForbidden } from "./dashboard.errors";
import { type CreateAnnouncementInput } from "./dto/dashboard.schemas";
import { AccessService } from "../access/access.service";

const HOME_ANNOUNCEMENTS_CAP = 20;

@Injectable()
export class DashboardAnnouncementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  getActiveAnnouncements(orgId: string) {
    return this.cache.cachedForOrg(
      orgId,
      CACHE_KEYS.announcementsList(orgId),
      () => {
        const now = new Date();
        return this.db
          .select({
            id: broadcasts.id,
            content: broadcasts.message,
            isPinned: broadcasts.isPinned,
            expiresAt: broadcasts.expiresAt,
            createdAt: broadcasts.createdAt,
            authorId: broadcasts.createdBy,
            authorName: users.name,
            authorFirstName: users.firstName,
            authorLastName: users.lastName,
          })
          .from(broadcasts)
          .innerJoin(users, eq(broadcasts.createdBy, users.id))
          .where(
            and(
              eq(broadcasts.orgId, orgId),
              eq(broadcasts.status, "SENT"),
              eq(broadcasts.audienceType, "all"),
              or(isNull(broadcasts.expiresAt), gt(broadcasts.expiresAt, now)),
            ),
          )
          .orderBy(desc(broadcasts.isPinned), desc(broadcasts.createdAt))
          .limit(HOME_ANNOUNCEMENTS_CAP);
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async createAnnouncement(
    orgId: string,
    authorId: string,
    actor: DashboardActor,
    input: CreateAnnouncementInput,
  ) {
    if (!(await this.access.holds(actor, "settings:manage"))) {
      return { error: "forbidden", message: "Forbidden" } as DashboardForbidden;
    }

    const sentAt = new Date();
    const [row] = await this.db
      .insert(broadcasts)
      .values({
        orgId,
        createdBy: authorId,
        title: input.title,
        message: input.content,
        channels: ["IN_APP"],
        audience: { type: "all" },
        audienceType: "all",
        status: "SENT",
        sentAt,
        isPinned: input.isPinned ?? false,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning({
        id: broadcasts.id,
        orgId: broadcasts.orgId,
        title: broadcasts.title,
        content: broadcasts.message,
        isPinned: broadcasts.isPinned,
        expiresAt: broadcasts.expiresAt,
        status: broadcasts.status,
        authorId: broadcasts.createdBy,
        createdAt: broadcasts.createdAt,
        updatedAt: broadcasts.updatedAt,
      });

    await this.invalidate(orgId);
    return row;
  }

  async deleteAnnouncement(orgId: string, actor: DashboardActor, id: number) {
    if (!(await this.access.holds(actor, "settings:manage"))) {
      return { error: "forbidden", message: "Forbidden" } as DashboardForbidden;
    }

    await this.db
      .delete(broadcasts)
      .where(and(eq(broadcasts.id, id), eq(broadcasts.orgId, orgId)));

    await this.invalidate(orgId);
    return { success: true };
  }

  private async invalidate(orgId: string) {
    await this.cache.invalidateForOrg(orgId, CACHE_KEYS.announcementsList(orgId));
    await this.cache.invalidateNamespace(CACHE_KEYS.broadcastsListNamespace(orgId));
  }
}
