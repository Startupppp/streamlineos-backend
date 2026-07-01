import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { jobRequisitions } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";

@Injectable()
export class RecruitmentRequisitionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, status?: string) {
    const conditions = [eq(jobRequisitions.orgId, orgId)];
    if (status) conditions.push(eq(jobRequisitions.status, status));
    return this.db.select().from(jobRequisitions)
      .where(and(...conditions))
      .orderBy(desc(jobRequisitions.createdAt))
      .limit(100);
  }

  async create(orgId: string, requestedBy: string, data: Omit<typeof jobRequisitions.$inferInsert, "id" | "orgId" | "requestedBy" | "status" | "createdAt" | "updatedAt">) {
    const [req] = await this.db.insert(jobRequisitions)
      .values({ ...data, orgId, requestedBy, status: "DRAFT" }).returning();
    return req;
  }

  async submit(orgId: string, id: number) {
    const [req] = await this.db.update(jobRequisitions)
      .set({ status: "PENDING_APPROVAL", updatedAt: new Date() })
      .where(and(eq(jobRequisitions.id, id), eq(jobRequisitions.orgId, orgId))).returning();
    if (!req) throw new NotFoundException("Requisition not found");
    return req;
  }

  async approve(orgId: string, id: number, approverId: string) {
    const [req] = await this.db.update(jobRequisitions)
      .set({ status: "APPROVED", approverId, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(jobRequisitions.id, id), eq(jobRequisitions.orgId, orgId))).returning();
    if (!req) throw new NotFoundException("Requisition not found");
    return req;
  }

  async reject(orgId: string, id: number, approverId: string, reason: string) {
    const [req] = await this.db.update(jobRequisitions)
      .set({ status: "REJECTED", approverId, rejectionReason: reason, updatedAt: new Date() })
      .where(and(eq(jobRequisitions.id, id), eq(jobRequisitions.orgId, orgId))).returning();
    if (!req) throw new NotFoundException("Requisition not found");
    return req;
  }

  async update(orgId: string, id: number, data: Partial<typeof jobRequisitions.$inferInsert>) {
    const [req] = await this.db.update(jobRequisitions)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(jobRequisitions.id, id), eq(jobRequisitions.orgId, orgId))).returning();
    if (!req) throw new NotFoundException("Requisition not found");
    return req;
  }
}
