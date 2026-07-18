import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  candidateApplications,
  candidateOffers,
  candidates,
  jobPostings,
  offerNegotiations,
  offerVersions,
  type OfferNegotiationDirection,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AutomationService } from "../automation/automation.service";
import { AuditService } from "../../common/audit/audit.service";
import { RecruitmentHandoffService } from "./recruitment-handoff.service";
import type {
  CreateOfferInput,
  CreateOfferNegotiationInput,
  UpdateOfferInput,
} from "./dto/candidate-records.schemas";

const LOCKED_STATUSES = new Set(["SENT", "VIEWED", "ACCEPTED", "DECLINED", "COUNTERED", "EXPIRED"]);
const COMP_FIELDS = ["offeredSalary", "offeredDesignation", "joiningDate", "validUntil"] as const;

@Injectable()
export class RecruitmentOffersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automation: AutomationService,
    private readonly audit: AuditService,
    private readonly handoff: RecruitmentHandoffService,
  ) {}

  async listOffers(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId);
    return this.db.query.candidateOffers.findMany({
      where: and(eq(candidateOffers.candidateId, candidateId), eq(candidateOffers.orgId, orgId)),
      orderBy: [desc(candidateOffers.createdAt)],
    });
  }

  async listAllOffers(orgId: string) {
    return this.db
      .select({
        id: candidateOffers.id,
        candidateId: candidateOffers.candidateId,
        candidateFirstName: candidates.firstName,
        candidateLastName: candidates.lastName,
        candidateEmail: candidates.email,
        jobPostingId: candidateOffers.jobPostingId,
        jobTitle: jobPostings.title,
        offerStatus: candidateOffers.offerStatus,
        offeredSalary: candidateOffers.offeredSalary,
        offeredDesignation: candidateOffers.offeredDesignation,
        joiningDate: candidateOffers.joiningDate,
        validUntil: candidateOffers.validUntil,
        sentAt: candidateOffers.sentAt,
        respondedAt: candidateOffers.respondedAt,
        createdAt: candidateOffers.createdAt,
      })
      .from(candidateOffers)
      .innerJoin(candidates, eq(candidateOffers.candidateId, candidates.id))
      .leftJoin(jobPostings, eq(candidateOffers.jobPostingId, jobPostings.id))
      .where(eq(candidateOffers.orgId, orgId))
      .orderBy(desc(candidateOffers.createdAt));
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

    await this.db.insert(offerVersions).values({
      orgId,
      offerId: offer.id,
      versionNumber: 1,
      offeredSalary: offer.offeredSalary,
      offeredDesignation: offer.offeredDesignation,
      joiningDate: offer.joiningDate,
      validUntil: offer.validUntil,
      notes: offer.notes,
      changeReason: "Offer created",
      changedBy: userId,
    });

    this.audit.log({
      action: "OFFER_CREATED",
      userId,
      orgId,
      targetId: String(offer.id),
      targetType: "candidate_offer",
      metadata: { candidateId, offeredSalary: offer.offeredSalary, offeredDesignation: offer.offeredDesignation },
    });

    return offer;
  }

  async submitForApproval(orgId: string, offerId: number, userId: string) {
    const offer = await this.findOffer(orgId, offerId);
    if (offer.offerStatus !== "DRAFT") {
      throw new BadRequestException("Only DRAFT offers can be submitted for approval.");
    }
    await this.db
      .update(candidateOffers)
      .set({ offerStatus: "PENDING_APPROVAL", updatedAt: new Date() })
      .where(and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)));
    this.audit.log({
      action: "OFFER_SUBMITTED_FOR_APPROVAL",
      userId,
      orgId,
      targetId: String(offerId),
      targetType: "candidate_offer",
    });
    return { success: true };
  }

  async approveOffer(orgId: string, userId: string, offerId: number, remarks?: string) {
    const offer = await this.findOffer(orgId, offerId);
    if (offer.offerStatus !== "PENDING_APPROVAL") {
      throw new BadRequestException("Only PENDING_APPROVAL offers can be approved.");
    }
    const now = new Date();
    const tokenFields = offer.acceptanceToken ? {} : this.buildAcceptanceToken();
    await this.db
      .update(candidateOffers)
      .set({
        offerStatus: "SENT",
        approvedBy: userId,
        approvedAt: now,
        approvalRemarks: remarks ?? null,
        sentAt: now,
        updatedAt: now,
        ...tokenFields,
      })
      .where(and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)));
    this.audit.log({
      action: "OFFER_APPROVED",
      userId,
      orgId,
      targetId: String(offerId),
      targetType: "candidate_offer",
      metadata: { remarks },
    });
    return { success: true };
  }

  private buildAcceptanceToken() {
    return {
      acceptanceToken: randomBytes(24).toString("hex"),
      acceptanceTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
  }

  async rejectApproval(orgId: string, offerId: number, remarks: string | undefined, userId: string) {
    const offer = await this.findOffer(orgId, offerId);
    if (offer.offerStatus !== "PENDING_APPROVAL") {
      throw new BadRequestException("Only PENDING_APPROVAL offers can be rejected.");
    }
    await this.db
      .update(candidateOffers)
      .set({ offerStatus: "APPROVAL_REJECTED", approvalRemarks: remarks ?? null, updatedAt: new Date() })
      .where(and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)));
    this.audit.log({
      action: "OFFER_APPROVAL_REJECTED",
      userId,
      orgId,
      targetId: String(offerId),
      targetType: "candidate_offer",
      metadata: { remarks },
    });
    return { success: true };
  }

  async listVersions(orgId: string, offerId: number) {
    await this.findOffer(orgId, offerId);
    return this.db.query.offerVersions.findMany({
      where: and(eq(offerVersions.offerId, offerId), eq(offerVersions.orgId, orgId)),
      orderBy: [desc(offerVersions.versionNumber)],
    });
  }

  async listNegotiations(orgId: string, offerId: number) {
    await this.findOffer(orgId, offerId);
    return this.db.query.offerNegotiations.findMany({
      where: and(eq(offerNegotiations.offerId, offerId), eq(offerNegotiations.orgId, orgId)),
      orderBy: [asc(offerNegotiations.createdAt)],
    });
  }

  async addNegotiationEntry(
    orgId: string,
    offerId: number,
    direction: OfferNegotiationDirection,
    input: CreateOfferNegotiationInput,
    userId?: string,
  ) {
    const offer = await this.findOffer(orgId, offerId);

    const [entry] = await this.db
      .insert(offerNegotiations)
      .values({
        orgId,
        offerId,
        direction,
        proposedSalary: input.proposedSalary !== undefined ? String(input.proposedSalary) : null,
        proposedJoiningDate: input.proposedJoiningDate,
        message: input.message,
        createdBy: userId,
      })
      .returning();

    if (direction === "CANDIDATE_COUNTER") {
      await this.db
        .update(candidateOffers)
        .set({ offerStatus: "COUNTERED", respondedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)));
      if (offer.offeredBy) {
        this.audit.log({
          action: "OFFER_COUNTERED_BY_CANDIDATE",
          userId: offer.offeredBy,
          orgId,
          targetId: String(offerId),
          targetType: "candidate_offer",
          metadata: { proposedSalary: entry.proposedSalary, source: "public_candidate_response" },
        });
      }
    }

    if (direction === "INTERNAL_RESPONSE" && input.applyToOffer && userId) {
      const hasNewTerms = input.proposedSalary !== undefined || input.proposedJoiningDate !== undefined;
      if (hasNewTerms) {
        await this.snapshotVersion(orgId, offerId, offer, userId, "Terms revised during negotiation");
        const now = new Date();
        await this.db
          .update(candidateOffers)
          .set({
            offeredSalary: input.proposedSalary !== undefined ? String(input.proposedSalary) : offer.offeredSalary,
            joiningDate: input.proposedJoiningDate ?? offer.joiningDate,
            offerStatus: "SENT",
            sentAt: now,
            updatedAt: now,
          })
          .where(and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)));
        this.audit.log({
          action: "OFFER_TERMS_REVISED",
          userId,
          orgId,
          targetId: String(offerId),
          targetType: "candidate_offer",
          metadata: { proposedSalary: input.proposedSalary },
        });
      }
    }

    return entry;
  }

  async updateOffer(orgId: string, userId: string, candidateId: number, offerId: number, input: UpdateOfferInput) {
    const existing = await this.db.query.candidateOffers.findFirst({
      where: and(
        eq(candidateOffers.id, offerId),
        eq(candidateOffers.candidateId, candidateId),
        eq(candidateOffers.orgId, orgId),
      ),
    });
    if (!existing) throw new NotFoundException("Offer not found");

    const compFieldsChanged = COMP_FIELDS.some((f) => input[f] !== undefined);
    if (compFieldsChanged && LOCKED_STATUSES.has(existing.offerStatus)) {
      throw new BadRequestException(
        "This offer has already been sent — its terms are immutable. Use the negotiation flow to propose new terms.",
      );
    }
    if (compFieldsChanged) {
      await this.snapshotVersion(orgId, offerId, existing, userId, "Offer terms updated");
    }

    const now = new Date();
    const updateData: Partial<typeof candidateOffers.$inferInsert> = { updatedAt: now };

    if (input.offerStatus !== undefined) {
      updateData.offerStatus = input.offerStatus;
      if (input.offerStatus === "SENT") {
        if (!input.sentAt) updateData.sentAt = now;
        if (!existing.acceptanceToken) Object.assign(updateData, this.buildAcceptanceToken());
      }
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
      .where(and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)))
      .returning();

    if (
      input.offerStatus === "SENT" ||
      input.offerStatus === "ACCEPTED" ||
      input.offerStatus === "DECLINED"
    ) {
      void this.dispatchOfferAutomation(orgId, candidateId, offerId, input.offerStatus, existing.offerStatus, {
        offeredSalary: updated.offeredSalary,
        joiningDate: updated.joiningDate,
        validUntil: updated.validUntil,
      }).catch(() => undefined);
    }

    return updated;
  }

  private async snapshotVersion(
    orgId: string,
    offerId: number,
    existing: typeof candidateOffers.$inferSelect,
    userId: string,
    reason: string,
  ) {
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(offerVersions)
      .where(eq(offerVersions.offerId, offerId));

    await this.db.insert(offerVersions).values({
      orgId,
      offerId,
      versionNumber: count + 1,
      offeredSalary: existing.offeredSalary,
      offeredDesignation: existing.offeredDesignation,
      joiningDate: existing.joiningDate,
      validUntil: existing.validUntil,
      notes: existing.notes,
      changeReason: reason,
      changedBy: userId,
    });
  }

  private async dispatchOfferAutomation(
    orgId: string,
    candidateId: number,
    offerId: number,
    newStatus: "SENT" | "ACCEPTED" | "DECLINED",
    previousStatus: string,
    offer: { offeredSalary: string | null; joiningDate: string | null; validUntil: string | null },
  ): Promise<void> {
    const [candidate, latestApp] = await Promise.all([
      this.db.query.candidates.findFirst({
        where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
        columns: { firstName: true, lastName: true, email: true },
      }),
      this.db.query.candidateApplications.findFirst({
        where: eq(candidateApplications.candidateId, candidateId),
        with: { jobPosting: { columns: { title: true } } },
        orderBy: (t, { desc: d }) => [d(t.appliedAt)],
      }),
    ]);

    const candidateName = candidate ? `${candidate.firstName} ${candidate.lastName}` : "";
    const candidateEmail = candidate?.email ?? "";
    const jobTitle = latestApp?.jobPosting?.title ?? "";
    const respondedAt = new Date().toISOString();

    if (newStatus === "SENT") {
      if (previousStatus === "SENT") return;
      await this.automation.runAutomationsForEvent(orgId, "offer.sent", {
        offerId,
        candidateId,
        candidateName,
        candidateEmail,
        jobTitle,
        offeredSalary: offer.offeredSalary ?? "",
        joiningDate: offer.joiningDate ?? null,
        validUntil: offer.validUntil ?? null,
        sentAt: respondedAt,
      });
      return;
    }

    if (newStatus === "ACCEPTED") {
      await this.automation.runAutomationsForEvent(orgId, "offer.accepted", {
        offerId,
        candidateId,
        candidateName,
        candidateEmail,
        jobTitle,
        decision: "ACCEPTED",
        respondedAt,
      });
      void this.handoff.handleOfferAccepted(orgId, candidateId, offerId).catch(() => undefined);
      return;
    }

    await this.automation.runAutomationsForEvent(orgId, "offer.rejected", {
      offerId,
      candidateId,
      candidateName,
      candidateEmail,
      jobTitle,
      decision: "REJECTED",
      respondedAt,
    });
  }

  async deleteOffer(orgId: string, candidateId: number, offerId: number, userId: string) {
    const existing = await this.db.query.candidateOffers.findFirst({
      where: and(
        eq(candidateOffers.id, offerId),
        eq(candidateOffers.candidateId, candidateId),
        eq(candidateOffers.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Offer not found");

    await this.db.delete(candidateOffers).where(and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)));
    this.audit.log({
      action: "OFFER_DELETED",
      userId,
      orgId,
      targetId: String(offerId),
      targetType: "candidate_offer",
    });
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
