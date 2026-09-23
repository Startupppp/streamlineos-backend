import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  candidateOffers,
  candidates,
  interviewBookingLinks,
  offerNegotiations,
  organizations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { RecruitmentOfferAcceptanceService } from "../hr/recruitment/recruitment-offer-acceptance.service";
import type { OfferRespondInput } from "./dto/public.schemas";

@Injectable()
export class PublicOffersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly acceptance: RecruitmentOfferAcceptanceService,
  ) {}

  async getOffer(token: string) {
    const offer = await withPublicToken(this.db, token, (tx) =>
      tx.query.candidateOffers.findFirst({
        where: eq(candidateOffers.acceptanceToken, token),
        columns: {
          id: true,
          orgId: true,
          offerStatus: true,
          offeredSalary: true,
          offeredDesignation: true,
          joiningDate: true,
          validUntil: true,
          notes: true,
          acceptanceTokenExpiresAt: true,
        },
      }),
    );

    if (!offer) throw new NotFoundException("Offer not found");

    if (offer.acceptanceTokenExpiresAt && new Date(offer.acceptanceTokenExpiresAt) < new Date()) {
      throw new GoneException("This offer link has expired.");
    }

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [negotiations, org] = await Promise.all([
          tx.query.offerNegotiations.findMany({
            where: eq(offerNegotiations.offerId, offer.id),
            orderBy: (t, { asc: a }) => [a(t.createdAt)],
            columns: { direction: true, proposedSalary: true, message: true, createdAt: true },
          }),
          tx.query.organizations.findFirst({
            where: eq(organizations.id, offer.orgId),
            columns: { currency: true },
          }),
        ]);

        return { ...offer, negotiations, currency: org?.currency ?? "INR" };
      },
      { orgId: offer.orgId },
    );
  }

  async respondToOffer(token: string, input: OfferRespondInput) {
    const offer = await withPublicToken(this.db, token, (tx) =>
      tx.query.candidateOffers.findFirst({
        where: eq(candidateOffers.acceptanceToken, token),
        columns: { id: true, orgId: true, offerStatus: true, acceptanceTokenExpiresAt: true },
      }),
    );

    if (!offer) throw new NotFoundException("Offer not found");

    if (offer.acceptanceTokenExpiresAt && new Date(offer.acceptanceTokenExpiresAt) < new Date()) {
      throw new GoneException("This offer link has expired.");
    }

    if (offer.offerStatus !== "SENT" && offer.offerStatus !== "VIEWED") {
      throw new ConflictException("This offer can no longer be responded to.");
    }

    const orgId = offer.orgId;

    const outcome = await runInTenantTransaction(
      this.db,
      async (tx) => {
        if (input.action === "counter") {
          const claimed = await this.acceptance.claimResponse(tx, orgId, offer.id, "COUNTERED");
          if (!claimed) return null;
          await tx.insert(offerNegotiations).values({
            orgId,
            offerId: offer.id,
            direction: "CANDIDATE_COUNTER",
            proposedSalary: input.counterSalary !== undefined ? String(input.counterSalary) : null,
            message: input.counterMessage,
          });
          return { status: "COUNTERED" as const, claimed, terms: null };
        }

        const newStatus = input.action === "accept" ? ("ACCEPTED" as const) : ("DECLINED" as const);
        const claimed = await this.acceptance.claimResponse(
          tx,
          orgId,
          offer.id,
          newStatus,
          input.action === "decline" ? { notes: input.declineReason ?? null } : {},
        );
        if (!claimed) return null;

        /**
         * The seat closing commits with the acceptance. Candidate `HIRED`,
         * application `ACCEPTED`, the opening consumed, the requisition filled
         * and `candidate.hired` / `hire.handoff` in the outbox — the same
         * transaction, so a rollback leaves none of it.
         */
        if (newStatus === "ACCEPTED")
          await this.acceptance.completeAcceptedOffer(tx, orgId, {
            id: offer.id,
            candidateId: claimed.candidateId,
            jobPostingId: claimed.jobPostingId,
          });

        const terms = await tx.query.candidateOffers.findFirst({
          where: eq(candidateOffers.id, offer.id),
          columns: { offeredSalary: true, joiningDate: true, validUntil: true },
        });

        /**
         * Registered INSIDE the transaction, not after it.
         * `registerAfterCommit` writes to the ambient tenant context, and this
         * is a public route: the context exists only for the duration of this
         * callback, and `openTenantTransaction` drains the hooks the moment it
         * returns. Registering afterwards found no context, fell back to
         * running inline with no tenant GUC, and every query in the handoff
         * died `42501` — an accepted offer with no employee and an error in a
         * log nobody reads.
         */
        this.acceptance.deferStatusEffects(
          orgId,
          claimed.candidateId,
          offer.id,
          newStatus,
          offer.offerStatus,
          {
            offeredSalary: terms?.offeredSalary ?? null,
            joiningDate: terms?.joiningDate ?? null,
            validUntil: terms?.validUntil ?? null,
          },
        );

        return { status: newStatus, claimed, terms: terms ?? null };
      },
      { orgId },
    );

    /**
     * Null means another request answered this offer first — the conditional
     * update matched no row. That is the same refusal the pre-read gives, just
     * decided where it is actually safe to decide it.
     */
    if (!outcome) throw new ConflictException("This offer can no longer be responded to.");

    return { success: true, status: outcome.status };
  }

  async getBookingLink(token: string) {
    const link = await withPublicToken(this.db, token, (tx) =>
      tx.query.interviewBookingLinks.findFirst({
        where: eq(interviewBookingLinks.token, token),
      }),
    );

    if (!link) throw new NotFoundException("Booking link not found.");

    if (link.status !== "pending") {
      throw new GoneException({
        error: "This booking link has already been used.",
        status: link.status,
      });
    }

    if (new Date() > link.expiresAt) throw new GoneException("This booking link has expired.");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const candidate = await tx.query.candidates.findFirst({
          where: eq(candidates.id, link.candidateId),
          columns: { firstName: true, lastName: true },
        });

        const org = await tx.query.organizations.findFirst({
          where: eq(organizations.id, link.orgId),
          columns: { name: true },
        });

        return {
          candidateName: candidate
            ? `${candidate.firstName} ${candidate.lastName}`
            : "Candidate",
          orgName: org?.name ?? "StreamlineOS",
          interviewType: link.interviewType,
          durationMinutes: link.durationMinutes,
          availableSlots: link.availableSlots,
          notes: link.notes,
        };
      },
      { orgId: link.orgId },
    );
  }
}
