import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  candidateReferrals,
  candidates,
  externalReferrals,
  externalReferrers,
  headcountRequests,
  jobPostings,
  users,
} from "../../../db/schema";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
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
import { RecruitmentVendorSourcingService } from "./recruitment-vendor-sourcing.service";
import { assertOrganizationActor } from "../../../common/organization/organization-actor";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";

@Injectable()
export class RecruitmentSourcingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly vendorSourcing: RecruitmentVendorSourcingService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  private async actorMembershipId(orgId: string, userId: string, membershipId?: number | null): Promise<number> {
    if (membershipId != null) return membershipId;
    return (await assertOrganizationActor(this.db, orgId, { kind: "user", userId })).membershipId;
  }

  async listReferrals(orgId: string, userId: string, canManage: boolean, membershipId?: number | null) {
    const actorMembershipId = canManage ? null : await this.actorMembershipId(orgId, userId, membershipId);
    return this.db.query.candidateReferrals.findMany({
      where: canManage
        ? eq(candidateReferrals.orgId, orgId)
        : and(eq(candidateReferrals.orgId, orgId), eq(candidateReferrals.referredByMembershipId, actorMembershipId!)),
      limit: 200,
      with: {
        candidate: { columns: { id: true, firstName: true, lastName: true, email: true } },
        referrer: { columns: { id: true, name: true, email: true } },
        jobPosting: { columns: { id: true, title: true } },
      },
      orderBy: [desc(candidateReferrals.createdAt)],
    });
  }

  async createReferral(orgId: string, userId: string, input: CreateReferralSubmissionInput, membershipId?: number | null) {
    const actorMembershipId = await this.actorMembershipId(orgId, userId, membershipId);
    const existing = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.email, input.email), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });

    let candidateId: number;
    if (existing) {
      candidateId = existing.id;
    } else {
      await this.planLimits.assertWithinLimit(orgId, "hrCandidates");
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
      if (!created) throw new InternalServerErrorException("Failed to create candidate.");
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
        referredByMembershipId: actorMembershipId,
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
    return this.vendorSourcing.listVendors(orgId);
  }

  createVendor(orgId: string, userId: string, input: CreateVendorInput) {
    return this.vendorSourcing.createVendor(orgId, userId, input);
  }

  updateVendor(orgId: string, vendorId: number, input: UpdateVendorInput) {
    return this.vendorSourcing.updateVendor(orgId, vendorId, input);
  }

  deleteVendor(orgId: string, vendorId: number) {
    return this.vendorSourcing.deleteVendor(orgId, vendorId);
  }

  generateVendorPortalLink(orgId: string, vendorId: number) {
    return this.vendorSourcing.generateVendorPortalLink(orgId, vendorId);
  }

  listSubmissions(orgId: string, vendorId: number, canViewFinancials: boolean) {
    return this.vendorSourcing.listSubmissions(orgId, vendorId, canViewFinancials);
  }

  createSubmission(orgId: string, vendorId: number, input: CreateSubmissionInput) {
    return this.vendorSourcing.createSubmission(orgId, vendorId, input);
  }

  updateSubmission(orgId: string, vendorId: number, submissionId: number, input: UpdateSubmissionInput) {
    return this.vendorSourcing.updateSubmission(orgId, vendorId, submissionId, input);
  }

  async listHeadcount(orgId: string, userId: string, canManage: boolean, input: HeadcountListInput, membershipId?: number | null) {
    const actorMembershipId = canManage ? null : await this.actorMembershipId(orgId, userId, membershipId);
    const isHr = canManage;
    const conditions = [eq(headcountRequests.orgId, orgId)];
    if (!isHr) conditions.push(eq(headcountRequests.requestedByMembershipId, actorMembershipId!));
    if (input.status) conditions.push(sql`${headcountRequests.status} = ${input.status}`);
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      conditions.push(keysetBeforeId(headcountRequests.createdAt, headcountRequests.id, cursor));
    }

    return this.db
      .select({
        id: headcountRequests.id,
        orgId: headcountRequests.orgId,
        orgDepartmentId: headcountRequests.orgDepartmentId,
        requestedBy: headcountRequests.requestedBy,
        requestedByMembershipId: headcountRequests.requestedByMembershipId,
        requestedRole: headcountRequests.requestedRole,
        level: headcountRequests.level,
        justification: headcountRequests.justification,
        targetDate: headcountRequests.targetDate,
        status: headcountRequests.status,
        approvedBy: headcountRequests.approvedBy,
        approvedByMembershipId: headcountRequests.approvedByMembershipId,
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
      .orderBy(desc(headcountRequests.createdAt), desc(headcountRequests.id))
      .limit(input.limit + 1)
      .then((rows) => buildCursorPage(rows, input.limit, (row) => ({
        sortValue: row.createdAt.toISOString(),
        id: String(row.id),
      })));
  }

  async createHeadcount(orgId: string, userId: string, input: CreateHeadcountInput, membershipId?: number | null) {
    const actorMembershipId = await this.actorMembershipId(orgId, userId, membershipId);
    const [row] = await this.db
      .insert(headcountRequests)
      .values({
        orgId,
        requestedBy: userId,
        requestedByMembershipId: actorMembershipId,
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

  async updateHeadcount(orgId: string, userId: string, requestId: number, input: UpdateHeadcountInput, membershipId?: number | null) {
    const actorMembershipId = await this.actorMembershipId(orgId, userId, membershipId);
    const existing = await this.findHeadcount(orgId, requestId);
    if (existing.requestedByMembershipId !== actorMembershipId) throw new ForbiddenException("Forbidden");
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
      .where(and(eq(headcountRequests.id, requestId), eq(headcountRequests.orgId, orgId)))
      .returning();
    return updated;
  }

  async deleteHeadcount(orgId: string, userId: string, requestId: number, membershipId?: number | null) {
    const actorMembershipId = await this.actorMembershipId(orgId, userId, membershipId);
    const existing = await this.findHeadcount(orgId, requestId);
    if (existing.requestedByMembershipId !== actorMembershipId) throw new ForbiddenException("Forbidden");
    if (existing.status !== "DRAFT") throw new BadRequestException("Cannot delete non-draft requests");

    await this.db.delete(headcountRequests).where(and(eq(headcountRequests.id, requestId), eq(headcountRequests.orgId, orgId)));
    return { success: true };
  }

  async approveHeadcount(orgId: string, userId: string, requestId: number, membershipId?: number | null) {
    const actorMembershipId = await this.actorMembershipId(orgId, userId, membershipId);
    const existing = await this.findHeadcount(orgId, requestId);
    if (existing.status !== "SUBMITTED") throw new BadRequestException("Only SUBMITTED requests can be approved");

    const [updated] = await this.db
      .update(headcountRequests)
      .set({ status: "APPROVED", approvedBy: userId, approvedByMembershipId: actorMembershipId, approvedAt: new Date() })
      .where(and(eq(headcountRequests.id, requestId), eq(headcountRequests.orgId, orgId)))
      .returning();
    return updated;
  }

  async rejectHeadcount(orgId: string, requestId: number, reason?: string) {
    const existing = await this.findHeadcount(orgId, requestId);
    if (existing.status !== "SUBMITTED") throw new BadRequestException("Only SUBMITTED requests can be rejected");

    const [updated] = await this.db
      .update(headcountRequests)
      .set({ status: "REJECTED", rejectedReason: reason })
      .where(and(eq(headcountRequests.id, requestId), eq(headcountRequests.orgId, orgId)))
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
        .where(and(eq(headcountRequests.id, requestId), eq(headcountRequests.orgId, orgId)));
      return created;
    });

    return { jobId: job.id, jobTitle: job.title };
  }

  listExternalReferrals(orgId: string) {
    return this.db.query.externalReferrals.findMany({
      where: eq(externalReferrals.orgId, orgId),
      limit: 200,
      with: {
        candidate: { columns: { id: true, firstName: true, lastName: true, email: true } },
        referrer: { columns: { id: true, name: true, email: true } },
        jobPosting: { columns: { id: true, title: true } },
      },
      orderBy: [desc(externalReferrals.createdAt)],
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

  private async findHeadcount(orgId: string, requestId: number) {
    const existing = await this.db.query.headcountRequests.findFirst({
      where: and(eq(headcountRequests.id, requestId), eq(headcountRequests.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Not found");
    return existing;
  }
}
