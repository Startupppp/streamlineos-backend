import { Inject, Injectable, NotFoundException, BadRequestException, ConflictException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { jobRequisitions, jobPostings, headcountRequests } from "../../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { CreateRequisitionInput, UpdateRequisitionInput } from "./dto/requisitions.schemas";

@Injectable()
export class RecruitmentRequisitionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, status?: string) {
    const conditions = [eq(jobRequisitions.orgId, orgId)];
    if (status) conditions.push(eq(jobRequisitions.status, status));
    return this.db.select({
      id: jobRequisitions.id,
      orgId: jobRequisitions.orgId,
      title: jobRequisitions.title,
      department: jobRequisitions.department,
      location: jobRequisitions.location,
      headcount: jobRequisitions.headcount,
      status: jobRequisitions.status,
      createdAt: jobRequisitions.createdAt,
    })
      .from(jobRequisitions)
      .where(and(...conditions))
      .orderBy(desc(jobRequisitions.createdAt))
      .limit(100);
  }

  private async validateHeadcountLink(orgId: string, headcountId?: number) {
    if (!headcountId) return;
    const [headcount] = await this.db.select({
      id: headcountRequests.id,
      orgId: headcountRequests.orgId,
      status: headcountRequests.status,
    }).from(headcountRequests)
      .where(and(eq(headcountRequests.id, headcountId), eq(headcountRequests.orgId, orgId)))
      .limit(1);
    if (!headcount) {
      throw new NotFoundException("Headcount request not found");
    }
    if (headcount.status !== "APPROVED") {
      throw new BadRequestException("Only APPROVED headcount requests can be linked to a requisition");
    }
  }

  async create(orgId: string, requestedBy: string, data: CreateRequisitionInput) {
    await this.validateHeadcountLink(orgId, data.headcountId);

    const [req] = await this.db.insert(jobRequisitions)
      .values({
        ...data,
        budgetMin: data.budgetMin?.toString(),
        budgetMax: data.budgetMax?.toString(),
        orgId,
        requestedBy,
        status: "DRAFT",
      }).returning();
    return req;
  }

  private async findOrThrow(orgId: string, id: number) {
    const [req] = await this.db.select({
      id: jobRequisitions.id,
      orgId: jobRequisitions.orgId,
      status: jobRequisitions.status,
      linkedJobId: jobRequisitions.linkedJobId,
      headcount: jobRequisitions.headcount,
      headcountId: jobRequisitions.headcountId,
      title: jobRequisitions.title,
      type: jobRequisitions.type,
      budgetMin: jobRequisitions.budgetMin,
      budgetMax: jobRequisitions.budgetMax,
      location: jobRequisitions.location,
    }).from(jobRequisitions)
      .where(and(eq(jobRequisitions.id, id), eq(jobRequisitions.orgId, orgId)))
      .limit(1);
    if (!req) throw new NotFoundException("Requisition not found");
    return req;
  }

  async createJobFromRequisition(orgId: string, userId: string, id: number) {
    const requisition = await this.findOrThrow(orgId, id);
    if (requisition.status !== "APPROVED") {
      throw new BadRequestException("Only APPROVED requisitions can create a job posting");
    }
    if (requisition.linkedJobId) {
      throw new ConflictException("A job posting has already been created for this requisition");
    }

    const job = await this.db.transaction(async (tx) => {
      const [created] = await tx.insert(jobPostings).values({
        orgId,
        title: requisition.title,
        location: requisition.location ?? undefined,
        type: requisition.type,
        salaryMin: requisition.budgetMin ?? undefined,
        salaryMax: requisition.budgetMax ?? undefined,
        openings: requisition.headcount,
        postedBy: userId,
        status: "DRAFT",
      }).returning();

      await tx.update(jobRequisitions)
        .set({ linkedJobId: created.id, updatedAt: new Date() })
        .where(and(eq(jobRequisitions.id, id), eq(jobRequisitions.orgId, orgId)));

      if (requisition.headcountId) {
        await tx.update(headcountRequests)
          .set({ status: "JOB_CREATED", linkedJobPostingId: created.id, updatedAt: new Date() })
          .where(and(eq(headcountRequests.id, requisition.headcountId), eq(headcountRequests.orgId, orgId)));
      }

      return created;
    });

    return { jobId: job.id, jobTitle: job.title };
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

  async update(orgId: string, id: number, data: UpdateRequisitionInput) {
    await this.validateHeadcountLink(orgId, data.headcountId);

    const [req] = await this.db.update(jobRequisitions)
      .set({
        ...data,
        budgetMin: data.budgetMin?.toString(),
        budgetMax: data.budgetMax?.toString(),
        updatedAt: new Date(),
      })
      .where(and(eq(jobRequisitions.id, id), eq(jobRequisitions.orgId, orgId))).returning();
    if (!req) throw new NotFoundException("Requisition not found");
    return req;
  }
}
