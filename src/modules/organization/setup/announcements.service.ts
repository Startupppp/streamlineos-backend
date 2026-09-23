import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ne } from "drizzle-orm";
import { broadcastReadReceipts, broadcasts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import {
  ANNOUNCEMENT_COLUMNS,
  audienceTypeFor,
  broadcastStatusFor,
  buildAudience,
  orgAnnouncementRowScope,
  orgAnnouncementScope,
  projectAnnouncement,
  type AnnouncementRow,
  type OrgAnnouncementWrite,
} from "./org-announcement-broadcast";
import {
  clearAnnouncementTargets,
  dedupeTargetIds,
  readAnnouncementReadCounts,
  resolveAnnouncementRecipients,
  writeAnnouncementTargets,
} from "./org-announcement-broadcast.queries";

const LIST_CAP = 50;
const LIST_ALL_CAP = 100;

@Injectable()
export class AnnouncementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async list(orgId: string) {
    const rows = await this.db
      .select(ANNOUNCEMENT_COLUMNS)
      .from(broadcasts)
      .where(
        and(
          eq(broadcasts.orgId, orgId),
          orgAnnouncementScope(),
          ne(broadcasts.status, "DRAFT"),
        ),
      )
      .orderBy(desc(broadcasts.isPinned), desc(broadcasts.createdAt))
      .limit(LIST_CAP);
    return this.project(orgId, rows);
  }

  async listAll(orgId: string) {
    const rows = await this.db
      .select(ANNOUNCEMENT_COLUMNS)
      .from(broadcasts)
      .where(and(eq(broadcasts.orgId, orgId), orgAnnouncementScope()))
      .orderBy(desc(broadcasts.createdAt))
      .limit(LIST_ALL_CAP);
    return this.project(orgId, rows);
  }

  async create(
    orgId: string,
    authorId: string,
    targetIds: string[],
    data: OrgAnnouncementWrite,
  ) {
    const targetType = data.targetType;
    const requested = targetType === "ALL" ? [] : dedupeTargetIds(targetIds);
    const broadcastStatus = broadcastStatusFor(data.status);

    const created = await this.db.transaction(async (tx) => {
      const recipients = await resolveAnnouncementRecipients(
        tx,
        orgId,
        targetType,
        requested,
      );
      const [row] = await tx
        .insert(broadcasts)
        .values({
          orgId,
          title: data.title,
          message: data.content,
          type: "INFO",
          priority: "NORMAL",
          category: "HRMS",
          channels: ["IN_APP"],
          audience: buildAudience(
            targetType,
            requested,
            recipients,
            data.attachmentUrls,
          ),
          audienceType: audienceTypeFor(targetType),
          status: broadcastStatus,
          scheduledAt: data.publishAt,
          sentAt:
            broadcastStatus === "SENT" ? (data.publishAt ?? new Date()) : null,
          isPinned: data.isPinned,
          expiresAt: data.expiresAt,
          createdBy: authorId,
        })
        .returning(ANNOUNCEMENT_COLUMNS);
      if (!row) {
        throw new BadRequestException("Announcement could not be created");
      }
      await writeAnnouncementTargets(tx, orgId, row.id, targetType, recipients);
      return row;
    });

    await this.invalidate(orgId);
    return projectAnnouncement(created, 0, new Date());
  }

  async update(
    orgId: string,
    id: number,
    targetIds: string[] | undefined,
    data: Partial<OrgAnnouncementWrite>,
  ) {
    const existing = await this.findOwned(orgId, id);
    const meta = existing.audience.orgAnnouncement;
    const targetType = data.targetType ?? meta?.targetType ?? "ALL";
    const attachmentUrls = data.attachmentUrls ?? meta?.attachmentUrls ?? [];
    const retarget = targetIds !== undefined || data.targetType !== undefined;
    const requested =
      targetType === "ALL"
        ? []
        : dedupeTargetIds(targetIds ?? meta?.targetIds ?? []);

    const updated = await this.db.transaction(async (tx) => {
      const recipients = retarget
        ? await resolveAnnouncementRecipients(tx, orgId, targetType, requested)
        : [];
      const audience = retarget
        ? buildAudience(targetType, requested, recipients, attachmentUrls)
        : {
            ...existing.audience,
            orgAnnouncement: {
              targetType,
              targetIds: meta?.targetIds ?? [],
              attachmentUrls,
            },
          };

      const [row] = await tx
        .update(broadcasts)
        .set({
          ...(data.title !== undefined && { title: data.title }),
          ...(data.content !== undefined && { message: data.content }),
          ...(data.isPinned !== undefined && { isPinned: data.isPinned }),
          ...(data.publishAt !== undefined && { scheduledAt: data.publishAt }),
          ...(data.expiresAt !== undefined && { expiresAt: data.expiresAt }),
          ...(data.status !== undefined && {
            status: broadcastStatusFor(data.status),
            ...(broadcastStatusFor(data.status) === "SENT" &&
            existing.status !== "SENT"
              ? { sentAt: data.publishAt ?? new Date() }
              : {}),
          }),
          audience,
          audienceType: audienceTypeFor(targetType),
          updatedAt: new Date(),
        })
        .where(orgAnnouncementRowScope(orgId, id))
        .returning(ANNOUNCEMENT_COLUMNS);
      if (!row) throw new NotFoundException("Announcement not found");

      if (retarget) {
        await clearAnnouncementTargets(tx, orgId, id);
        await writeAnnouncementTargets(tx, orgId, id, targetType, recipients);
      }
      return row;
    });

    await this.invalidate(orgId);
    const counts = await readAnnouncementReadCounts(this.db, orgId, [updated.id]);
    return projectAnnouncement(updated, counts.get(updated.id) ?? 0, new Date());
  }

  async remove(orgId: string, id: number) {
    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(broadcasts)
        .where(orgAnnouncementRowScope(orgId, id))
        .returning({ id: broadcasts.id });
      if (removed.length === 0) {
        throw new NotFoundException("Announcement not found");
      }
      await clearAnnouncementTargets(tx, orgId, id);
    });
    await this.invalidate(orgId);
  }

  async markRead(
    orgId: string,
    announcementId: number,
    membershipId: number | null,
  ) {
    if (membershipId === null) {
      throw new ForbiddenException("Organization membership required");
    }
    const [row] = await this.db
      .select({ id: broadcasts.id })
      .from(broadcasts)
      .where(orgAnnouncementRowScope(orgId, announcementId))
      .limit(1);
    if (!row) throw new NotFoundException("Announcement not found");

    await this.db
      .insert(broadcastReadReceipts)
      .values({ orgId, broadcastId: announcementId, membershipId })
      .onConflictDoNothing({
        target: [
          broadcastReadReceipts.orgId,
          broadcastReadReceipts.broadcastId,
          broadcastReadReceipts.membershipId,
        ],
      });
  }

  private async findOwned(orgId: string, id: number): Promise<AnnouncementRow> {
    const [row] = await this.db
      .select(ANNOUNCEMENT_COLUMNS)
      .from(broadcasts)
      .where(orgAnnouncementRowScope(orgId, id))
      .limit(1);
    if (!row) throw new NotFoundException("Announcement not found");
    return row;
  }

  private async project(orgId: string, rows: AnnouncementRow[]) {
    const counts = await readAnnouncementReadCounts(
      this.db,
      orgId,
      rows.map((row) => row.id),
    );
    const now = new Date();
    return rows.map((row) =>
      projectAnnouncement(row, counts.get(row.id) ?? 0, now),
    );
  }

  private async invalidate(orgId: string) {
    await this.cache.invalidateForOrg(
      orgId,
      CACHE_KEYS.announcementsList(orgId),
    );
    await this.cache.invalidateNamespace(
      CACHE_KEYS.broadcastsListNamespace(orgId),
    );
  }
}
