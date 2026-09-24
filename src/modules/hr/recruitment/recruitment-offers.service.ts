import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { IdentityService } from "./identity/identity.service";
import { and, desc, eq } from "drizzle-orm";
import { candidateOffers, candidates, type OfferNegotiationDirection } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { RecruitmentOfferAcceptanceService } from "./recruitment-offer-acceptance.service";
import {
  approveOffer,
  buildAcceptanceToken,
  rejectOfferApproval,
  submitOfferForApproval,
} from "./recruitment-offer-approvals";
import { queryOrgOffers } from "./recruitment-offer-list-query";
import { addOfferNegotiationEntry, listOfferNegotiations } from "./recruitment-offer-negotiations";
import {
  listOfferVersions,
  recordInitialOfferVersion,
  snapshotOfferVersion,
} from "./recruitment-offer-versions";
import type {
  CreateOfferInput,
  CreateOfferNegotiationInput,
  OfferListInput,
  UpdateOfferInput,
} from "./dto/candidate-records.schemas";

const LOCKED_STATUSES = new Set(["SENT", "VIEWED", "ACCEPTED", "DECLINED", "COUNTERED", "EXPIRED"]);
const COMP_FIELDS = ["offeredSalary", "offeredDesignation", "joiningDate", "validUntil"] as const;

/**
 * The `candidate_offers` record itself — reads, creation, terms edits and deletion — and the
 * tenant/object-level load (`findOffer`, `ensureCandidate`) every other offer surface routes
 * through. §4: a miss inside the wrong tenant is a 404 here, never a 403 downstream.
 *
 * The three behaviours that change on their own schedules live beside this file rather than
 * in it: the approval state machine (`recruitment-offer-approvals`), the candidate-facing
 * negotiation (`recruitment-offer-negotiations`), the `offer_versions` write protocol
 * (`recruitment-offer-versions`) and the post-commit automation/handoff/onboarding dispatch
 * (`RecruitmentOfferAcceptanceService`). Each is loaded here after the offer has been
 * authorized, so the tenant assertion stays in exactly one place. The dispatch in
 * particular is shared with the PUBLIC accept path, which is why it is a service and no
 * longer a private method here.
 */
@Injectable()
export class RecruitmentOffersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly acceptance: RecruitmentOfferAcceptanceService,
    private readonly identity: IdentityService,
  ) {}

  async listOffers(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId);
    return this.db.query.candidateOffers.findMany({
      limit: 100,
      where: and(eq(candidateOffers.candidateId, candidateId), eq(candidateOffers.orgId, orgId)),
      orderBy: [desc(candidateOffers.createdAt)],
    });
  }

  listAllOffers(orgId: string, query: OfferListInput) {
    return queryOrgOffers(this.db, orgId, query);
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

    await recordInitialOfferVersion(this.db, orgId, offer.id, offer, userId);

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
    return submitOfferForApproval(this.db, this.audit, orgId, offer, userId);
  }

  /**
   * Approval IS the send. It sets `SENT` and mints the acceptance token, so it
   * must fire `offer.sent` exactly as a manual status patch to `SENT` does —
   * without this, the normal approval button left every "offer sent" automation
   * (the email that carries the link) unfired, and only a recruiter who
   * additionally patched the status by hand ever triggered one.
   */
  async approveOffer(orgId: string, userId: string, offerId: number, remarks?: string) {
    const offer = await this.findOffer(orgId, offerId);

    /*
      The identity policy bites here, at approval, rather than at acceptance.

      A role marked as requiring verification is one somebody decided the check
      matters for, and the question has to be settled before the candidate is
      asked to answer. Gating the candidate's acceptance instead would strand
      them in front of a button they cannot make work and cannot fix — the
      recruiter is the one who can run the check.

      UNAVAILABLE blocks the same as FAILED. A policy that switches itself off
      when the integration is missing is not a policy.
    */
    const gate = await this.identity.gateForOffer(orgId, offer.candidateId, offer.jobPostingId);
    if (!gate.allowed) throw new BadRequestException(gate.reason);

    const result = await approveOffer(this.db, this.audit, orgId, offer, userId, remarks);
    this.acceptance.deferStatusEffects(orgId, offer.candidateId, offerId, "SENT", offer.offerStatus, {
      offeredSalary: offer.offeredSalary,
      joiningDate: offer.joiningDate,
      validUntil: offer.validUntil,
    });
    return result;
  }

  async rejectApproval(orgId: string, offerId: number, remarks: string | undefined, userId: string) {
    const offer = await this.findOffer(orgId, offerId);
    return rejectOfferApproval(this.db, this.audit, orgId, offer, remarks, userId);
  }

  async listVersions(orgId: string, offerId: number) {
    await this.findOffer(orgId, offerId);
    return listOfferVersions(this.db, orgId, offerId);
  }

  async listNegotiations(orgId: string, offerId: number) {
    await this.findOffer(orgId, offerId);
    return listOfferNegotiations(this.db, orgId, offerId);
  }

  async addNegotiationEntry(
    orgId: string,
    offerId: number,
    direction: OfferNegotiationDirection,
    input: CreateOfferNegotiationInput,
    userId?: string,
  ) {
    const offer = await this.findOffer(orgId, offerId);
    return addOfferNegotiationEntry(this.db, this.audit, orgId, offer, direction, input, userId);
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
      await snapshotOfferVersion(this.db, orgId, offerId, existing, userId, "Offer terms updated");
    }

    const now = new Date();
    const updateData: Partial<typeof candidateOffers.$inferInsert> = { updatedAt: now };

    if (input.offerStatus !== undefined) {
      updateData.offerStatus = input.offerStatus;
      if (input.offerStatus === "SENT") {
        if (!input.sentAt) updateData.sentAt = now;
        if (!existing.acceptanceToken) Object.assign(updateData, buildAcceptanceToken());
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

    /**
     * An internal patch to `ACCEPTED` closes the seat exactly as the candidate
     * clicking Accept does. `this.db` here IS the request transaction
     * (`TenantContextInterceptor` holds it in AsyncLocalStorage), so this
     * commits with the offer row.
     */
    if (input.offerStatus === "ACCEPTED" && existing.offerStatus !== "ACCEPTED")
      await this.acceptance.completeAcceptedOffer(this.db, orgId, {
        id: offerId,
        candidateId,
        jobPostingId: updated.jobPostingId,
      });

    const dispatchedStatus = input.offerStatus;
    if (
      dispatchedStatus === "SENT" ||
      dispatchedStatus === "ACCEPTED" ||
      dispatchedStatus === "DECLINED"
    ) {
      this.acceptance.deferStatusEffects(orgId, candidateId, offerId, dispatchedStatus, existing.offerStatus, {
        offeredSalary: updated.offeredSalary,
        joiningDate: updated.joiningDate,
        validUntil: updated.validUntil,
      });
    }

    return updated;
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
