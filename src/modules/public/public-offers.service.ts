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
import type { OfferRespondInput } from "./dto/public.schemas";

@Injectable()
export class PublicOffersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        if (input.action === "counter") {
          await tx.insert(offerNegotiations).values({
            orgId: offer.orgId,
            offerId: offer.id,
            direction: "CANDIDATE_COUNTER",
            proposedSalary: input.counterSalary !== undefined ? String(input.counterSalary) : null,
            message: input.counterMessage,
          });
          await tx
            .update(candidateOffers)
            .set({ offerStatus: "COUNTERED", respondedAt: new Date(), updatedAt: new Date() })
            .where(eq(candidateOffers.id, offer.id));
          return { success: true, status: "COUNTERED" };
        }

        const newStatus = input.action === "accept" ? "ACCEPTED" : "DECLINED";

        await tx
          .update(candidateOffers)
          .set({
            offerStatus: newStatus,
            respondedAt: new Date(),
            ...(input.action === "decline" ? { notes: input.declineReason ?? null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(candidateOffers.id, offer.id));

        return { success: true, status: newStatus };
      },
      { orgId: offer.orgId },
    );
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
