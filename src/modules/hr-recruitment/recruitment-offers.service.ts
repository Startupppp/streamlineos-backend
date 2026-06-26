import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { candidateOffers, candidates } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  CreateOfferInput,
  UpdateOfferInput,
} from "./dto/candidate-records.schemas";

@Injectable()
export class RecruitmentOffersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listOffers(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId);
    return this.db.query.candidateOffers.findMany({
      where: and(eq(candidateOffers.candidateId, candidateId), eq(candidateOffers.orgId, orgId)),
      orderBy: [desc(candidateOffers.createdAt)],
    });
  }

  async createOffer(orgId: string, userId: string, candidateId: number, input: CreateOfferInput) {
    await this.ensureCandidate(orgId, candidateId);
    const [offer] = await this.db
      .insert(candidateOffers)
      .values({
        orgId,
        candidateId,
        offeredBy: userId,
        jobPostingId: input.jobPostingId,
        offeredSalary: input.offeredSalary?.toString(),
        offeredDesignation: input.offeredDesignation,
        joiningDate: input.joiningDate,
        offerLetterUrl: input.offerLetterUrl,
        validUntil: input.validUntil,
        notes: input.notes,
      })
      .returning();
    return offer;
  }

  async submitForApproval(orgId: string, offerId: number) {
    const offer = await this.findOffer(orgId, offerId);
    if (offer.offerStatus !== "DRAFT") {
      throw new BadRequestException("Only DRAFT offers can be submitted for approval.");
    }
    await this.db
      .update(candidateOffers)
      .set({ offerStatus: "PENDING_APPROVAL", updatedAt: new Date() })
      .where(eq(candidateOffers.id, offerId));
    return { success: true };
  }

  async approveOffer(orgId: string, userId: string, offerId: number, remarks?: string) {
    const offer = await this.findOffer(orgId, offerId);
    if (offer.offerStatus !== "PENDING_APPROVAL") {
      throw new BadRequestException("Only PENDING_APPROVAL offers can be approved.");
    }
    const now = new Date();
    await this.db
      .update(candidateOffers)
      .set({
        offerStatus: "SENT",
        approvedBy: userId,
        approvedAt: now,
        approvalRemarks: remarks ?? null,
        sentAt: now,
        updatedAt: now,
      })
      .where(eq(candidateOffers.id, offerId));
    return { success: true };
  }

  async rejectApproval(orgId: string, offerId: number, remarks?: string) {
    const offer = await this.findOffer(orgId, offerId);
    if (offer.offerStatus !== "PENDING_APPROVAL") {
      throw new BadRequestException("Only PENDING_APPROVAL offers can be rejected.");
    }
    await this.db
      .update(candidateOffers)
      .set({ offerStatus: "APPROVAL_REJECTED", approvalRemarks: remarks ?? null, updatedAt: new Date() })
      .where(eq(candidateOffers.id, offerId));
    return { success: true };
  }

  async updateOffer(orgId: string, candidateId: number, offerId: number, input: UpdateOfferInput) {
    const existing = await this.db.query.candidateOffers.findFirst({
      where: and(
        eq(candidateOffers.id, offerId),
        eq(candidateOffers.candidateId, candidateId),
        eq(candidateOffers.orgId, orgId),
      ),
      columns: { id: true, offerStatus: true },
    });
    if (!existing) throw new NotFoundException("Offer not found");

    const now = new Date();
    const updateData: Partial<typeof candidateOffers.$inferInsert> = { updatedAt: now };

    if (input.offerStatus !== undefined) {
      updateData.offerStatus = input.offerStatus;
      if (input.offerStatus === "SENT" && !input.sentAt) updateData.sentAt = now;
      if (input.offerStatus === "VIEWED" && !input.viewedAt) updateData.viewedAt = now;
      if (["ACCEPTED", "DECLINED", "COUNTERED"].includes(input.offerStatus) && !input.respondedAt) {
        updateData.respondedAt = now;
      }
    }
    if (input.offeredSalary !== undefined) updateData.offeredSalary = String(input.offeredSalary);
    if (input.offeredDesignation !== undefined) updateData.offeredDesignation = input.offeredDesignation;
    if (input.joiningDate !== undefined) updateData.joiningDate = input.joiningDate;
    if (input.offerLetterUrl !== undefined) updateData.offerLetterUrl = input.offerLetterUrl;
    if (input.validUntil !== undefined) updateData.validUntil = input.validUntil;
    if (input.notes !== undefined) updateData.notes = input.notes;
    if (input.sentAt !== undefined) updateData.sentAt = new Date(input.sentAt);
    if (input.viewedAt !== undefined) updateData.viewedAt = new Date(input.viewedAt);
    if (input.respondedAt !== undefined) updateData.respondedAt = new Date(input.respondedAt);

    const [updated] = await this.db
      .update(candidateOffers)
      .set(updateData)
      .where(eq(candidateOffers.id, offerId))
      .returning();
    return updated;
  }

  async deleteOffer(orgId: string, candidateId: number, offerId: number) {
    const existing = await this.db.query.candidateOffers.findFirst({
      where: and(
        eq(candidateOffers.id, offerId),
        eq(candidateOffers.candidateId, candidateId),
        eq(candidateOffers.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Offer not found");

    await this.db.delete(candidateOffers).where(eq(candidateOffers.id, offerId));
    return { success: true };
  }

  private async findOffer(orgId: string, offerId: number) {
    const offer = await this.db.query.candidateOffers.findFirst({
      where: and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)),
    });
    if (!offer) throw new NotFoundException("Offer not found.");
    return offer;
  }

  private async ensureCandidate(orgId: string, candidateId: number) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found");
  }
}
