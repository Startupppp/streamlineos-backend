import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { shiftTemplates, employeeShiftAssignments, shiftSwapRequests } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { CreateShiftInput, UpdateShiftInput } from "./dto/shifts.schemas";

@Injectable()
export class ShiftsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listShifts(orgId: string) {
    return this.db.select().from(shiftTemplates)
      .where(and(eq(shiftTemplates.orgId, orgId), eq(shiftTemplates.isActive, true)))
      .orderBy(desc(shiftTemplates.createdAt))
      .limit(100);
  }

  async createShift(orgId: string, data: CreateShiftInput) {
    try {
      const [shift] = await this.db.insert(shiftTemplates).values({ orgId, ...data }).returning();
      return shift;
    } catch (err: unknown) {
      const pg = err as { code?: string };
      if (pg.code === "23505") {
        throw new ConflictException("A shift template with this name already exists.");
      }
      throw err;
    }
  }

  async updateShift(orgId: string, id: number, data: UpdateShiftInput) {
    const [shift] = await this.db.update(shiftTemplates)
      .set(data)
      .where(and(eq(shiftTemplates.id, id), eq(shiftTemplates.orgId, orgId)))
      .returning();
    if (!shift) throw new NotFoundException("Shift not found");
    return shift;
  }

  async deleteShift(orgId: string, id: number) {
    await this.db.update(shiftTemplates)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(shiftTemplates.id, id), eq(shiftTemplates.orgId, orgId)));
  }

  async getEmployeeShifts(orgId: string) {
    return this.db.select().from(employeeShiftAssignments)
      .where(and(eq(employeeShiftAssignments.orgId, orgId), eq(employeeShiftAssignments.isActive, true)))
      .orderBy(desc(employeeShiftAssignments.createdAt))
      .limit(200);
  }

  async assignShift(orgId: string, data: { userId: string; shiftId: number; effectiveFrom: string; effectiveTo?: string }) {
    const [assignment] = await this.db.insert(employeeShiftAssignments).values({ orgId, ...data }).returning();
    return assignment;
  }

  async listSwapRequests(orgId: string) {
    return this.db.select().from(shiftSwapRequests)
      .where(eq(shiftSwapRequests.orgId, orgId))
      .orderBy(desc(shiftSwapRequests.createdAt))
      .limit(100);
  }

  async createSwapRequest(orgId: string, data: { requesterId: string; targetUserId: string; requestDate: string; targetDate: string; reason?: string }) {
    const [swap] = await this.db.insert(shiftSwapRequests).values({ orgId, ...data }).returning();
    return swap;
  }

  async updateSwapStatus(orgId: string, id: number, status: string, approverId: string) {
    const [swap] = await this.db.update(shiftSwapRequests)
      .set({ status, approverId })
      .where(and(eq(shiftSwapRequests.id, id), eq(shiftSwapRequests.orgId, orgId)))
      .returning();
    if (!swap) throw new NotFoundException("Swap request not found");
    return swap;
  }
}
