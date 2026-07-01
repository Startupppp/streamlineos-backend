import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, and, desc, ne } from "drizzle-orm";
import { announcements, announcementReads } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

@Injectable()
export class AnnouncementsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string) {
    return this.db.select().from(announcements)
      .where(and(eq(announcements.orgId, orgId), ne(announcements.status, "DRAFT")))
      .orderBy(desc(announcements.isPinned), desc(announcements.createdAt))
      .limit(50);
  }

  async listAll(orgId: string) {
    return this.db.select().from(announcements)
      .where(eq(announcements.orgId, orgId))
      .orderBy(desc(announcements.createdAt))
      .limit(100);
  }

  async create(orgId: string, authorId: string, data: Omit<typeof announcements.$inferInsert, "id" | "orgId" | "authorId" | "readCount" | "createdAt" | "updatedAt">) {
    const [announcement] = await this.db.insert(announcements)
      .values({ ...data, orgId, authorId, readCount: 0 })
      .returning();
    return announcement;
  }

  async update(orgId: string, id: number, data: Partial<typeof announcements.$inferInsert>) {
    const [announcement] = await this.db.update(announcements)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(announcements.id, id), eq(announcements.orgId, orgId)))
      .returning();
    if (!announcement) throw new NotFoundException("Announcement not found");
    return announcement;
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
