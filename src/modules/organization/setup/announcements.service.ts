import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, desc, ne, inArray } from "drizzle-orm";
import { announcements, announcementTargets, announcementReads } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

type AnnouncementRow = typeof announcements.$inferSelect;
const MAX_ANNOUNCEMENT_TARGETS = 1000;

@Injectable()
export class AnnouncementsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async attachTargetIds(rows: AnnouncementRow[], orgId: string) {
    if (!rows.length) return rows.map((r) => ({ ...r, targetIds: [] as string[] }));
    const ids = rows.map((r) => r.id);
    const targets = await this.db
      .select({ announcementId: announcementTargets.announcementId, targetId: announcementTargets.targetId })
      .from(announcementTargets)
      .where(and(
        eq(announcementTargets.orgId, orgId),
        inArray(announcementTargets.announcementId, ids),
      ))
      .limit(rows.length * MAX_ANNOUNCEMENT_TARGETS);
    const byId = new Map<number, string[]>();
    for (const t of targets) {
      const list = byId.get(t.announcementId) ?? [];
      list.push(t.targetId);
      byId.set(t.announcementId, list);
    }
    return rows.map((r) => ({ ...r, targetIds: byId.get(r.id) ?? [] }));
  }

  private async insertTargets(announcementId: number, orgId: string, targetType: string, targetIds: string[]) {
    if (targetType === "ALL" || !targetIds.length) return;
    await this.db.insert(announcementTargets).values(
      targetIds.map((targetId) => ({ announcementId, orgId, targetType, targetId })),
    );
  }

  async list(orgId: string) {
    const rows = await this.db.select().from(announcements)
      .where(and(eq(announcements.orgId, orgId), ne(announcements.status, "DRAFT")))
      .orderBy(desc(announcements.isPinned), desc(announcements.createdAt))
      .limit(50);
    return this.attachTargetIds(rows, orgId);
  }

  async listAll(orgId: string) {
    const rows = await this.db.select().from(announcements)
      .where(eq(announcements.orgId, orgId))
      .orderBy(desc(announcements.createdAt))
      .limit(100);
    return this.attachTargetIds(rows, orgId);
  }

  async create(
    orgId: string,
    authorId: string,
    targetIds: string[],
    data: Omit<typeof announcements.$inferInsert, "id" | "orgId" | "authorId" | "readCount" | "createdAt" | "updatedAt">,
  ) {
    const [announcement] = await this.db.insert(announcements)
      .values({ ...data, orgId, authorId, readCount: 0 })
      .returning();
    const effectiveTargetType = data.targetType ?? "ALL";
    await this.insertTargets(announcement.id, orgId, effectiveTargetType, targetIds);
    return { ...announcement, targetIds: effectiveTargetType === "ALL" ? [] : targetIds };
  }

  async update(orgId: string, id: number, targetIds: string[] | undefined, data: Partial<typeof announcements.$inferInsert>) {
    const [announcement] = await this.db.update(announcements)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(announcements.id, id), eq(announcements.orgId, orgId)))
      .returning();
    if (!announcement) throw new NotFoundException("Announcement not found");

    if (targetIds !== undefined) {
      await this.db.delete(announcementTargets).where(and(
        eq(announcementTargets.announcementId, id),
        eq(announcementTargets.orgId, orgId),
      ));
      const effectiveTargetType = data.targetType ?? announcement.targetType;
      await this.insertTargets(id, orgId, effectiveTargetType, targetIds);
    }

    const rows = await this.db
      .select({ targetId: announcementTargets.targetId })
      .from(announcementTargets)
      .where(and(
        eq(announcementTargets.announcementId, id),
        eq(announcementTargets.orgId, orgId),
      ))
      .limit(MAX_ANNOUNCEMENT_TARGETS);
    return { ...announcement, targetIds: rows.map((r) => r.targetId) };
  }

  async remove(orgId: string, id: number) {
    await this.db.delete(announcements)
      .where(and(eq(announcements.id, id), eq(announcements.orgId, orgId)));
  }

  async markRead(announcementId: number, userId: string) {
    await this.db.insert(announcementReads)
      .values({ announcementId, userId })
      .onConflictDoNothing();
  }
}
