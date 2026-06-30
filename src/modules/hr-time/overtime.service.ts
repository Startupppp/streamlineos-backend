import { Injectable, NotFoundException } from "@nestjs/common";
import { db } from "../../db";
import { overtimeRequests, compOffBalances } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";

@Injectable()
export class OvertimeService {
  async listRequests(orgId: string) {
    return db.select().from(overtimeRequests).where(eq(overtimeRequests.orgId, orgId)).orderBy(desc(overtimeRequests.createdAt)).limit(100);
  }

  async createRequest(orgId: string, userId: string, data: { date: string; hours: string; reason?: string; convertToCompOff?: boolean }) {
    const [req] = await db.insert(overtimeRequests).values({ orgId, userId, ...data }).returning();
    return req;
  }

  async approveRequest(orgId: string, id: number, approverId: string) {
    const [req] = await db.update(overtimeRequests)
      .set({ status: "APPROVED", approverId, updatedAt: new Date() })
      .where(and(eq(overtimeRequests.id, id), eq(overtimeRequests.orgId, orgId)))
      .returning();
    if (!req) throw new NotFoundException("Request not found");
    if (req.convertToCompOff) {
      await db.insert(compOffBalances)
        .values({ orgId, userId: req.userId, earnedDays: (parseFloat(req.hours) / 8).toFixed(2) })
        .onConflictDoNothing();
    }
    return req;
  }

  async rejectRequest(orgId: string, id: number, approverId: string) {
    const [req] = await db.update(overtimeRequests)
      .set({ status: "REJECTED", approverId, updatedAt: new Date() })
      .where(and(eq(overtimeRequests.id, id), eq(overtimeRequests.orgId, orgId)))
      .returning();
    if (!req) throw new NotFoundException("Request not found");
    return req;
  }

  async getCompOffBalance(orgId: string, userId: string) {
    return db.select().from(compOffBalances).where(and(eq(compOffBalances.orgId, orgId), eq(compOffBalances.userId, userId)));
  }
}
