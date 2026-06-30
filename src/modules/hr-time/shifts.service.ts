import { Injectable, NotFoundException } from "@nestjs/common";
import { db } from "../../db";
import { shiftTemplates, employeeShiftAssignments, shiftSwapRequests } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";

@Injectable()
export class ShiftsService {
  async listShifts(orgId: string) {
    return db.select().from(shiftTemplates)
      .where(and(eq(shiftTemplates.orgId, orgId), eq(shiftTemplates.isActive, true)))
      .orderBy(desc(shiftTemplates.createdAt))
      .limit(100);
  }

  async createShift(orgId: string, data: { name: string; type: string; startTime: string; endTime: string; breakMinutes?: number; isNightShift?: boolean; gracePeriodMinutes?: number }) {
    const [shift] = await db.insert(shiftTemplates).values({ orgId, ...data }).returning();
    return shift;
  }

  async updateShift(orgId: string, id: number, data: Partial<typeof shiftTemplates.$inferInsert>) {
    const [shift] = await db.update(shiftTemplates)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(shiftTemplates.id, id), eq(shiftTemplates.orgId, orgId)))
      .returning();
    if (!shift) throw new NotFoundException("Shift not found");
    return shift;
  }

  async deleteShift(orgId: string, id: number) {
    await db.update(shiftTemplates)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(shiftTemplates.id, id), eq(shiftTemplates.orgId, orgId)));
  }

  async getEmployeeShifts(orgId: string) {
    return db.select().from(employeeShiftAssignments)
      .where(and(eq(employeeShiftAssignments.orgId, orgId), eq(employeeShiftAssignments.isActive, true)))
      .orderBy(desc(employeeShiftAssignments.createdAt))
      .limit(200);
  }

  async assignShift(orgId: string, data: { userId: string; shiftId: number; effectiveFrom: string; effectiveTo?: string }) {
    const [assignment] = await db.insert(employeeShiftAssignments).values({ orgId, ...data }).returning();
    return assignment;
  }

  async listSwapRequests(orgId: string) {
    return db.select().from(shiftSwapRequests)
      .where(eq(shiftSwapRequests.orgId, orgId))
      .orderBy(desc(shiftSwapRequests.createdAt))
      .limit(100);
  }

  async createSwapRequest(orgId: string, data: { requesterId: string; targetUserId: string; requestDate: string; targetDate: string; reason?: string }) {
    const [swap] = await db.insert(shiftSwapRequests).values({ orgId, ...data }).returning();
    return swap;
  }

  async updateSwapStatus(orgId: string, id: number, status: string, approverId: string) {
    const [swap] = await db.update(shiftSwapRequests)
      .set({ status, approverId })
      .where(and(eq(shiftSwapRequests.id, id), eq(shiftSwapRequests.orgId, orgId)))
      .returning();
    if (!swap) throw new NotFoundException("Swap request not found");
    return swap;
  }
}
