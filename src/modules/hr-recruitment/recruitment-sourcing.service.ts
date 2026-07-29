import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  candidateReferrals,
  candidates,
  externalReferrals,
  externalReferrers,
  headcountRequests,
  jobPostings,
  recruitmentVendors,
  users,
  vendorCandidateSubmissions,
} from "../../db/schema";
import { orgUnits } from "../../db/schema/common/organization";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import type {
  CreateHeadcountInput,
  CreateReferralSubmissionInput,
  CreateSubmissionInput,
  CreateVendorInput,
  HeadcountListInput,
  UpdateExternalReferralInput,
  UpdateExternalReferrerStatusInput,
  UpdateHeadcountInput,
  UpdateReferralStatusInput,
  UpdateSubmissionInput,
  UpdateVendorInput,
} from "./dto/sourcing.schemas";

@Injectable()
export class RecruitmentSourcingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  listReferrals(orgId: string, userId: string, canManage: boolean) {
    return this.db.query.candidateReferrals.findMany({
      where: canManage ? eq(candidateReferrals.orgId, orgId) : eq(candidateReferrals.referredBy, userId),
      with: {
        candidate: { columns: { id: true, firstName: true, lastName: true, email: true } },
        referrer: { columns: { id: true, name: true, email: true } },
        jobPosting: { columns: { id: true, title: true } },
      },
      orderBy: [desc(candidateReferrals.createdAt)],
      limit: 200,
    });
  }

  async createReferral(orgId: string, userId: string, input: CreateReferralSubmissionInput) {
    const existing = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.email, input.email), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });

    let candidateId: number;
    if (existing) {
      candidateId = existing.id;
    } else {
      const [created] = await this.db
        .insert(candidates)
        .values({
          orgId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          source: "REFERRAL",
        })
        .returning({ id: candidates.id });
      candidateId = created.id;
    }

    if (input.jobPostingId) {
      const job = await this.db.query.jobPostings.findFirst({
        where: eq(jobPostings.id, input.jobPostingId),
        columns: { orgId: true },
      });
      if (!job || job.orgId !== orgId) throw new NotFoundException("Job posting not found");
    }

    const [referral] = await this.db
      .insert(candidateReferrals)
      .values({
        orgId,
        candidateId,
        referredBy: userId,
        jobPostingId: input.jobPostingId,
        relationship: input.relationship,
        notes: input.notes,
        status: "SUBMITTED",
      })
      .returning();
    return referral;
  }

  async updateReferralStatus(orgId: string, referralId: number, input: UpdateReferralStatusInput) {
    const updates: Partial<typeof candidateReferrals.$inferInsert> = { updatedAt: new Date() };
    if (input.status !== undefined) updates.status = input.status;
    if (input.bonusEligible !== undefined) updates.bonusEligible = input.bonusEligible;
    if (input.bonusAmount !== undefined) updates.bonusAmount = String(input.bonusAmount);
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.status === "BONUS_PAID") updates.bonusPaidAt = new Date();

    const [updated] = await this.db
      .update(candidateReferrals)
      .set(updates)
      .where(and(eq(candidateReferrals.id, referralId), eq(candidateReferrals.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Referral not found");
    return updated;
  }

  listVendors(orgId: string) {
    return this.db
      .select({
        id: recruitmentVendors.id,
        name: recruitmentVendors.name,
        contactName: recruitmentVendors.contactName,
        contactEmail: recruitmentVendors.contactEmail,
        contactPhone: recruitmentVendors.contactPhone,
        website: recruitmentVendors.website,
        feePercent: recruitmentVendors.feePercent,
        status: recruitmentVendors.status,
        createdAt: recruitmentVendors.createdAt,
        submissionCount: count(vendorCandidateSubmissions.id),
        placements: sql<number>`sum(case when ${vendorCandidateSubmissions.placementStatus} = 'PLACED' then 1 else 0 end)::int`,
        revenueTotal: sql<string>`coalesce(sum(case when ${vendorCandidateSubmissions.invoiceStatus} = 'PAID' then ${vendorCandidateSubmissions.invoiceAmount}::numeric else 0 end), 0)::text`,
      })
      .from(recruitmentVendors)
      .leftJoin(vendorCandidateSubmissions, eq(vendorCandidateSubmissions.vendorId, recruitmentVendors.id))
      .where(eq(recruitmentVendors.orgId, orgId))
      .groupBy(recruitmentVendors.id)
      .orderBy(recruitmentVendors.name);
  }

  async createVendor(orgId: string, userId: string, input: CreateVendorInput) {
    const [vendor] = await this.db
      .insert(recruitmentVendors)
      .values({
        orgId,
        createdBy: userId,
        name: input.name,
        contactName: input.contactName,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        website: input.website || undefined,
        feePercent: input.feePercent !== undefined ? String(input.feePercent) : undefined,
        status: input.status,
        contractType: input.contractType,
        slaDays: input.slaDays,
        replacementGuaranteeDays: input.replacementGuaranteeDays,
      })
      .returning();
    return vendor;
  }

  async updateVendor(orgId: string, vendorId: number, input: UpdateVendorInput) {
    const existing = await this.db.query.recruitmentVendors.findFirst({
      where: and(eq(recruitmentVendors.id, vendorId), eq(recruitmentVendors.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Not found");

    const updateData: Partial<typeof recruitmentVendors.$inferInsert> = {};
    if (input.name !== undefined) updateData.name = input.name;
    if (input.contactName !== undefined) updateData.contactName = input.contactName;
    if (input.contactEmail !== undefined) updateData.contactEmail = input.contactEmail;
    if (input.contactPhone !== undefined) updateData.contactPhone = input.contactPhone;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.feePercent !== undefined) updateData.feePercent = String(input.feePercent);
    if (input.website !== undefined) updateData.website = input.website || undefined;
    if (input.contractType !== undefined) updateData.contractType = input.contractType;
    if (input.slaDays !== undefined) updateData.slaDays = input.slaDays;
    if (input.replacementGuaranteeDays !== undefined) updateData.replacementGuaranteeDays = input.replacementGuaranteeDays;

    const [updated] = await this.db
      .update(recruitmentVendors)
      .set(updateData)
      .where(and(eq(recruitmentVendors.id, vendorId), eq(recruitmentVendors.orgId, orgId)))
      .returning();
    return updated;
  }

  async deleteVendor(orgId: string, vendorId: number) {
    await this.db
      .delete(recruitmentVendors)
      .where(and(eq(recruitmentVendors.id, vendorId), eq(recruitmentVendors.orgId, orgId)));
    return { success: true };
  }

  async generateVendorPortalLink(orgId: string, vendorId: number) {
    await this.ensureVendor(orgId, vendorId);
    const portalToken = randomBytes(16).toString("hex");
    const portalTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const [updated] = await this.db
      .update(recruitmentVendors)
      .set({ portalToken, portalTokenExpiresAt })
      .where(eq(recruitmentVendors.id, vendorId))
      .returning({ portalToken: recruitmentVendors.portalToken, portalTokenExpiresAt: recruitmentVendors.portalTokenExpiresAt });
    return updated;
  }

  async listSubmissions(orgId: string, vendorId: number, canViewFinancials: boolean) {
    await this.ensureVendor(orgId, vendorId);
    const rows = await this.db
      .select({
        id: vendorCandidateSubmissions.id,
        candidateId: vendorCandidateSubmissions.candidateId,
        jobPostingId: vendorCandidateSubmissions.jobPostingId,
        submittedAt: vendorCandidateSubmissions.submittedAt,
        placementStatus: vendorCandidateSubmissions.placementStatus,
        invoiceStatus: vendorCandidateSubmissions.invoiceStatus,
        invoiceAmount: vendorCandidateSubmissions.invoiceAmount,
        invoiceDate: vendorCandidateSubmissions.invoiceDate,
        paidAt: vendorCandidateSubmissions.paidAt,
        billRate: vendorCandidateSubmissions.billRate,
        payRate: vendorCandidateSubmissions.payRate,
        contractStartDate: vendorCandidateSubmissions.contractStartDate,
        contractEndDate: vendorCandidateSubmissions.contractEndDate,
        candidateFirstName: candidates.firstName,
        candidateLastName: candidates.lastName,
        candidateEmail: candidates.email,
        jobTitle: jobPostings.title,
      })
      .from(vendorCandidateSubmissions)
      .leftJoin(candidates, eq(vendorCandidateSubmissions.candidateId, candidates.id))
      .leftJoin(jobPostings, eq(vendorCandidateSubmissions.jobPostingId, jobPostings.id))
      .where(eq(vendorCandidateSubmissions.vendorId, vendorId))
      .orderBy(desc(vendorCandidateSubmissions.submittedAt))
      .limit(100);

    if (canViewFinancials) {
      return rows.map((r) => ({
        ...r,
        margin:
          r.billRate !== null && r.payRate !== null
            ? (Number(r.billRate) - Number(r.payRate)).toFixed(2)
            : null,
      }));
    }

    return rows.map((r) => ({ ...r, billRate: null, payRate: null, margin: null }));
  }

  async createSubmission(orgId: string, vendorId: number, input: CreateSubmissionInput) {
    await this.ensureVendor(orgId, vendorId);
    const [row] = await this.db
      .insert(vendorCandidateSubmissions)
      .values({
        vendorId,
        candidateId: input.candidateId,
        jobPostingId: input.jobPostingId,
        billRate: input.billRate !== undefined ? String(input.billRate) : undefined,
        payRate: input.payRate !== undefined ? String(input.payRate) : undefined,
        contractStartDate: input.contractStartDate,
        contractEndDate: input.contractEndDate,
      })
      .returning();
    return row;
  }

  async updateSubmission(orgId: string, vendorId: number, submissionId: number, input: UpdateSubmissionInput) {
    await this.ensureVendor(orgId, vendorId);
    const updateData: Partial<typeof vendorCandidateSubmissions.$inferInsert> = {};
    if (input.placementStatus !== undefined) updateData.placementStatus = input.placementStatus;
    if (input.invoiceStatus !== undefined) updateData.invoiceStatus = input.invoiceStatus;
    if (input.invoiceAmount !== undefined) updateData.invoiceAmount = String(input.invoiceAmount);
    if (input.invoiceDate !== undefined) updateData.invoiceDate = input.invoiceDate;
    if (input.paidAt !== undefined) updateData.paidAt = input.paidAt;
    if (input.billRate !== undefined) updateData.billRate = String(input.billRate);
    if (input.payRate !== undefined) updateData.payRate = String(input.payRate);
    if (input.contractStartDate !== undefined) updateData.contractStartDate = input.contractStartDate;
    if (input.contractEndDate !== undefined) updateData.contractEndDate = input.contractEndDate;

    const [updated] = await this.db
      .update(vendorCandidateSubmissions)
      .set(updateData)
      .where(and(eq(vendorCandidateSubmissions.id, submissionId), eq(vendorCandidateSubmissions.vendorId, vendorId)))
      .returning();
    return updated;
  }

  listHeadcount(orgId: string, userId: string, canManage: boolean, input: HeadcountListInput) {
    const isHr = canManage;
    const conditions = [eq(headcountRequests.orgId, orgId)];
    if (!isHr) conditions.push(eq(headcountRequests.requestedBy, userId));
    if (input.status) conditions.push(sql`${headcountRequests.status} = ${input.status}`);

    return this.db
      .select({
        id: headcountRequests.id,
        orgId: headcountRequests.orgId,
        orgDepartmentId: headcountRequests.orgDepartmentId,
        requestedBy: headcountRequests.requestedBy,
        requestedRole: headcountRequests.requestedRole,
        level: headcountRequests.level,
        justification: headcountRequests.justification,
        targetDate: headcountRequests.targetDate,
        status: headcountRequests.status,
        approvedBy: headcountRequests.approvedBy,
        approvedAt: headcountRequests.approvedAt,
        rejectedReason: headcountRequests.rejectedReason,
        linkedJobPostingId: headcountRequests.linkedJobPostingId,
        createdAt: headcountRequests.createdAt,
        updatedAt: headcountRequests.updatedAt,
        departmentName: orgUnits.name,
        requesterName: users.name,
        requesterEmail: users.email,
      })
      .from(headcountRequests)
      .leftJoin(orgUnits, and(eq(headcountRequests.orgDepartmentId, orgUnits.id), eq(orgUnits.kind, "DEPARTMENT")))
      .leftJoin(users, eq(headcountRequests.requestedBy, users.id))
      .where(and(...conditions))
      .orderBy(desc(headcountRequests.createdAt))
      .limit(input.limit)
      .offset(input.offset);
  }

  async createHeadcount(orgId: string, userId: string, input: CreateHeadcountInput) {
    const [row] = await this.db
      .insert(headcountRequests)
      .values({
        orgId,
        requestedBy: userId,
        orgDepartmentId: input.departmentId,
        requestedRole: input.requestedRole,
        level: input.level,
        justification: input.justification,
        targetDate: input.targetDate,
        status: input.status,
      })
      .returning();
    return row;
  }

  async updateHeadcount(orgId: string, userId: string, requestId: number, input: UpdateHeadcountInput) {
    const existing = await this.findHeadcount(orgId, requestId);
    if (existing.requestedBy !== userId) throw new ForbiddenException("Forbidden");
    if (existing.status !== "DRAFT") throw new BadRequestException("Only DRAFT requests can be edited");

    const updateData: Partial<typeof headcountRequests.$inferInsert> = {};
    if (input.requestedRole !== undefined) updateData.requestedRole = input.requestedRole;
    if (input.level !== undefined) updateData.level = input.level;
    if (input.justification !== undefined) updateData.justification = input.justification;
    if (input.targetDate !== undefined) updateData.targetDate = input.targetDate;
    if (input.status !== undefined) updateData.status = input.status;

    const [updated] = await this.db
      .update(headcountRequests)
      .set(updateData)
      .where(eq(headcountRequests.id, requestId))
      .returning();
    return updated;
  }

  async deleteHeadcount(orgId: string, userId: string, requestId: number) {
    const existing = await this.findHeadcount(orgId, requestId);
    if (existing.requestedBy !== userId) throw new ForbiddenException("Forbidden");
    if (existing.status !== "DRAFT") throw new BadRequestException("Cannot delete non-draft requests");

    await this.db.delete(headcountRequests).where(and(eq(headcountRequests.id, requestId), eq(headcountRequests.orgId, orgId)));
    return { success: true };
  }

  async approveHeadcount(orgId: string, userId: string, requestId: number) {
    const existing = await this.findHeadcount(orgId, requestId);
    if (existing.status !== "SUBMITTED") throw new BadRequestException("Only SUBMITTED requests can be approved");

    const [updated] = await this.db
      .update(headcountRequests)
      .set({ status: "APPROVED", approvedBy: userId, approvedAt: new Date() })
      .where(eq(headcountRequests.id, requestId))
      .returning();
    return updated;
  }

  async rejectHeadcount(orgId: string, requestId: number, reason?: string) {
    const existing = await this.findHeadcount(orgId, requestId);
    if (existing.status !== "SUBMITTED") throw new BadRequestException("Only SUBMITTED requests can be rejected");

    const [updated] = await this.db
      .update(headcountRequests)
      .set({ status: "REJECTED", rejectedReason: reason })
      .where(eq(headcountRequests.id, requestId))
      .returning();
    return updated;
  }

  async createJobFromHeadcount(orgId: string, userId: string, requestId: number) {
    const request = await this.findHeadcount(orgId, requestId);
    if (request.status !== "APPROVED") throw new BadRequestException("Only APPROVED requests can create a job posting");
    if (request.linkedJobPostingId) throw new ConflictException("A job posting has already been created for this request");

    const job = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(jobPostings)
        .values({
          orgId,
          title: request.requestedRole,
          orgDepartmentId: request.orgDepartmentId,
          postedBy: userId,
          status: "DRAFT",
        })
        .returning();
      await tx
        .update(headcountRequests)
        .set({ status: "JOB_CREATED", linkedJobPostingId: created.id })
        .where(eq(headcountRequests.id, requestId));
      return created;
    });

    return { jobId: job.id, jobTitle: job.title };
  }

  listExternalReferrals(orgId: string) {
    return this.db.query.externalReferrals.findMany({
      where: eq(externalReferrals.orgId, orgId),
      with: {
        candidate: { columns: { id: true, firstName: true, lastName: true, email: true } },
        referrer: { columns: { id: true, name: true, email: true } },
        jobPosting: { columns: { id: true, title: true } },
      },
      orderBy: [desc(externalReferrals.createdAt)],
      limit: 200,
    });
  }

  async updateExternalReferral(orgId: string, referralId: number, input: UpdateExternalReferralInput) {
    const updates: Partial<typeof externalReferrals.$inferInsert> = { updatedAt: new Date() };
    if (input.status !== undefined) updates.status = input.status;
    if (input.rewardAmount !== undefined) updates.rewardAmount = String(input.rewardAmount);
    if (input.status === "REWARD_PAID") updates.rewardPaidAt = new Date();

    const [updated] = await this.db
      .update(externalReferrals)
      .set(updates)
      .where(and(eq(externalReferrals.id, referralId), eq(externalReferrals.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Referral not found");
    return updated;
  }

  listExternalReferrers(orgId: string) {
    return this.db
      .select({
        id: externalReferrers.id,
        name: externalReferrers.name,
        email: externalReferrers.email,
        phone: externalReferrers.phone,
        status: externalReferrers.status,
        createdAt: externalReferrers.createdAt,
        referralCount: count(externalReferrals.id),
      })
      .from(externalReferrers)
      .leftJoin(externalReferrals, eq(externalReferrals.referrerId, externalReferrers.id))
      .where(eq(externalReferrers.orgId, orgId))
      .groupBy(externalReferrers.id)
      .orderBy(desc(externalReferrers.createdAt))
      .limit(100);
  }

  async updateExternalReferrerStatus(orgId: string, referrerId: number, input: UpdateExternalReferrerStatusInput) {
    const [updated] = await this.db
      .update(externalReferrers)
      .set({ status: input.status })
      .where(and(eq(externalReferrers.id, referrerId), eq(externalReferrers.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Referrer not found");
    return updated;
  }

  private async ensureVendor(orgId: string, vendorId: number) {
    const vendor = await this.db.query.recruitmentVendors.findFirst({
      where: and(eq(recruitmentVendors.id, vendorId), eq(recruitmentVendors.orgId, orgId)),
      columns: { id: true },
    });
    if (!vendor) throw new NotFoundException("Not found");
  }

  private async findHeadcount(orgId: string, requestId: number) {
    const existing = await this.db.query.headcountRequests.findFirst({
      where: and(eq(headcountRequests.id, requestId), eq(headcountRequests.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Not found");
    return existing;
  }
}
