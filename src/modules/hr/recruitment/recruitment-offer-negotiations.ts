import { and, asc, eq } from "drizzle-orm";
import {
  candidateOffers,
  offerNegotiations,
  type OfferNegotiationDirection,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { snapshotOfferVersion } from "./recruitment-offer-versions";
import type { CreateOfferNegotiationInput } from "./dto/candidate-records.schemas";

/**
 * The two-sided conversation about an offer's terms: `offer_negotiations` plus the two
 * status transitions it drives. A `CANDIDATE_COUNTER` moves the offer to COUNTERED; an
 * `INTERNAL_RESPONSE` that applies its terms snapshots the outgoing version and re-sends.
 *
 * This is deliberately not part of the approval leg. Approval is an internal gate over
 * `approved_by`/`approval_remarks`; negotiation is a candidate-facing exchange that
 * rewrites the compensation terms themselves, and the two change for unrelated reasons.
 * It shares only the version protocol, which it imports rather than reimplements.
 */

type OfferRow = typeof candidateOffers.$inferSelect;

export function listOfferNegotiations(db: Db, orgId: string, offerId: number) {
  return db.query.offerNegotiations.findMany({
    limit: 100,
    where: and(eq(offerNegotiations.offerId, offerId), eq(offerNegotiations.orgId, orgId)),
    orderBy: [asc(offerNegotiations.createdAt)],
  });
}

export async function addOfferNegotiationEntry(
  db: Db,
  audit: AuditService,
  orgId: string,
  offer: OfferRow,
  direction: OfferNegotiationDirection,
  input: CreateOfferNegotiationInput,
  userId?: string,
) {
  const offerId = offer.id;

  const [entry] = await db
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
    await db
      .update(candidateOffers)
      .set({ offerStatus: "COUNTERED", respondedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)));
    // The counter arrives on a public candidate-response surface, so there is no acting
    // user to attribute it to; the offer's owner stands in as the audit subject.
    if (offer.offeredBy) {
      audit.log({
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
      await snapshotOfferVersion(db, orgId, offerId, offer, userId, "Terms revised during negotiation");
      const now = new Date();
      await db
        .update(candidateOffers)
        .set({
          offeredSalary: input.proposedSalary !== undefined ? String(input.proposedSalary) : offer.offeredSalary,
          joiningDate: input.proposedJoiningDate ?? offer.joiningDate,
          offerStatus: "SENT",
          sentAt: now,
          updatedAt: now,
        })
        .where(and(eq(candidateOffers.id, offerId), eq(candidateOffers.orgId, orgId)));
      audit.log({
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
