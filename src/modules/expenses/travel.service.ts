import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { travelRequests } from "../../db/schema";
import { eq, and, desc, or } from "drizzle-orm";

@Injectable()
export class TravelService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listMine(orgId: string, userId: string) {
    return this.db.select().from(travelRequests)
      .where(and(eq(travelRequests.orgId, orgId), eq(travelRequests.userId, userId)))
      .orderBy(desc(travelRequests.createdAt)).limit(50);
  }

  async listPending(orgId: string) {
    return this.db.select().from(travelRequests)
      .where(and(eq(travelRequests.orgId, orgId),
        or(eq(travelRequests.status, "PENDING"), eq(travelRequests.status, "MANAGER_APPROVED"))))
      .orderBy(desc(travelRequests.createdAt)).limit(100);
  }

  async create(orgId: string, userId: string, data: Omit<typeof travelRequests.$inferInsert, "id" | "orgId" | "userId" | "createdAt" | "updatedAt">) {
    const [req] = await this.db.insert(travelRequests).values({ ...data, orgId, userId, status: "PENDING" }).returning();
    return req;
  }

  async managerApprove(orgId: string, id: number, approverId: string) {
    const [req] = await this.db.update(travelRequests)
      .set({ status: "MANAGER_APPROVED", managerApproverId: approverId, managerApprovedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(travelRequests.id, id), eq(travelRequests.orgId, orgId), eq(travelRequests.status, "PENDING")))
      .returning();
    if (req) return req;

    const existing = await this.db.query.travelRequests.findFirst({
      where: and(eq(travelRequests.id, id), eq(travelRequests.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Travel request not found");
    throw new BadRequestException(`Travel request must be pending manager approval (current status: ${existing.status})`);
  }

  async financeApprove(orgId: string, id: number, approverId: string) {
    const [req] = await this.db.update(travelRequests)
      .set({ status: "FINANCE_APPROVED", financeApproverId: approverId, financeApprovedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(travelRequests.id, id), eq(travelRequests.orgId, orgId), eq(travelRequests.status, "MANAGER_APPROVED")))
      .returning();
    if (req) return req;

    const existing = await this.db.query.travelRequests.findFirst({
      where: and(eq(travelRequests.id, id), eq(travelRequests.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Travel request not found");
    throw new BadRequestException(`Travel request must be manager-approved before finance approval (current status: ${existing.status})`);
  }

  async reject(orgId: string, id: number, reason: string) {
    const [req] = await this.db.update(travelRequests)
      .set({ status: "REJECTED", rejectionReason: reason, updatedAt: new Date() })
      .where(and(eq(travelRequests.id, id), eq(travelRequests.orgId, orgId))).returning();
    if (!req) throw new NotFoundException("Travel request not found");
    return req;
  }
}
