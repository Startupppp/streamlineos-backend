import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  candidates,
  jobPostings,
  recruitmentVendors,
  vendorCandidateSubmissions,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreateSubmissionInput,
  CreateVendorInput,
  UpdateSubmissionInput,
  UpdateVendorInput,
} from "./dto/sourcing.schemas";

@Injectable()
export class RecruitmentVendorSourcingService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

  private async ensureVendor(orgId: string, vendorId: number) {
    const vendor = await this.db.query.recruitmentVendors.findFirst({
      where: and(eq(recruitmentVendors.id, vendorId), eq(recruitmentVendors.orgId, orgId)),
      columns: { id: true },
    });
    if (!vendor) throw new NotFoundException("Not found");
  }
}
