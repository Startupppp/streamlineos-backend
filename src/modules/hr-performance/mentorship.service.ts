import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { eq, and, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrMentorships } from "../../db/schema/hr/succession";

@Injectable()
export class MentorshipService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, userId: string, isManager: boolean) {
    if (isManager) {
      return this.db.select().from(hrMentorships).where(eq(hrMentorships.orgId, orgId));
    }
    return this.db
      .select()
      .from(hrMentorships)
      .where(
        and(
          eq(hrMentorships.orgId, orgId),
          or(eq(hrMentorships.mentorId, userId), eq(hrMentorships.menteeId, userId)),
        ),
      );
  }

  async create(orgId: string, data: { mentorId: string; menteeId: string; goal?: string; startedAt?: string }) {
    const [created] = await this.db
      .insert(hrMentorships)
      .values({ orgId, status: "active", ...data })
      .returning();
    return created;
  }

  async update(orgId: string, id: number, data: Partial<{ status: string; endedAt: string; goal: string }>) {
    const existing = await this.db
      .select({ id: hrMentorships.id })
      .from(hrMentorships)
      .where(and(eq(hrMentorships.id, id), eq(hrMentorships.orgId, orgId)))
      .limit(1);
    if (!existing.length) throw new NotFoundException("Mentorship not found");

    const [updated] = await this.db
      .update(hrMentorships)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(hrMentorships.id, id))
      .returning();
    return updated;
  }
}
