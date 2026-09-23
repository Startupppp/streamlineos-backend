import { BadRequestException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { candidateOffers } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";

/**
 * The internal approval leg of an offer: DRAFT → PENDING_APPROVAL → SENT or
 * APPROVAL_REJECTED. It is a closed state machine over `offer_status`, `approved_by`,
 * `approved_at` and `approval_remarks`, and it changes when approval *policy* changes —
 * who may approve, which statuses may be submitted, what the approval mints — which is a
 * different cadence from the offer record's own CRUD and from the candidate-facing
 * negotiation. Nothing here touches automation, the handoff or the version history.
 *
 * Every function takes an offer row the caller has already resolved inside the tenant
 * (§4: cross-tenant misses are 404 at the load, never a 403 here) and re-asserts `orgId`
 * on its own write, and returns the row it wrote. All three controllers declare
 * `@ResponseSchema(candidateOfferSchema)` while these returned `{ success: true }`,
 * so under `ResponseContractInterceptor` — which throws in test and non-production —
 * every one of them was a 500. Returning the offer makes the declared contract true
 * rather than relaxing it to match the lie.
 */

type OfferRow = typeof candidateOffers.$inferSelect;

/**
 * The candidate-facing acceptance link. Minted on the transition that first sends the
 * offer out — approval, or a direct status write to SENT — and never re-minted, so a link
 * already in a candidate's inbox keeps working across a re-send.
 */
export function buildAcceptanceToken() {
  return {
    acceptanceToken: randomBytes(24).toString("hex"),
    acceptanceTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  };
}

export async function submitOfferForApproval(
  db: Db,
  audit: AuditService,
  orgId: string,
  offer: OfferRow,
  userId: string,
) {
  if (offer.offerStatus !== "DRAFT") {
    throw new BadRequestException("Only DRAFT offers can be submitted for approval.");
  }
  const [updated] = await db
    .update(candidateOffers)
    .set({ offerStatus: "PENDING_APPROVAL", updatedAt: new Date() })
    .where(and(eq(candidateOffers.id, offer.id), eq(candidateOffers.orgId, orgId)))
    .returning();
  audit.log({
    action: "OFFER_SUBMITTED_FOR_APPROVAL",
    userId,
    orgId,
    targetId: String(offer.id),
    targetType: "candidate_offer",
  });
  return updated ?? offer;
}

export async function approveOffer(
  db: Db,
  audit: AuditService,
  orgId: string,
  offer: OfferRow,
  userId: string,
  remarks?: string,
) {
  if (offer.offerStatus !== "PENDING_APPROVAL") {
    throw new BadRequestException("Only PENDING_APPROVAL offers can be approved.");
  }
  const now = new Date();
  const tokenFields = offer.acceptanceToken ? {} : buildAcceptanceToken();
  const [updated] = await db
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
    .where(and(eq(candidateOffers.id, offer.id), eq(candidateOffers.orgId, orgId)))
    .returning();
  audit.log({
    action: "OFFER_APPROVED",
    userId,
    orgId,
    targetId: String(offer.id),
    targetType: "candidate_offer",
    metadata: { remarks },
  });
  return updated ?? offer;
}

export async function rejectOfferApproval(
  db: Db,
  audit: AuditService,
  orgId: string,
  offer: OfferRow,
  remarks: string | undefined,
  userId: string,
) {
  if (offer.offerStatus !== "PENDING_APPROVAL") {
    throw new BadRequestException("Only PENDING_APPROVAL offers can be rejected.");
  }
  const [updated] = await db
    .update(candidateOffers)
    .set({ offerStatus: "APPROVAL_REJECTED", approvalRemarks: remarks ?? null, updatedAt: new Date() })
    .where(and(eq(candidateOffers.id, offer.id), eq(candidateOffers.orgId, orgId)))
    .returning();
  audit.log({
    action: "OFFER_APPROVAL_REJECTED",
    userId,
    orgId,
    targetId: String(offer.id),
    targetType: "candidate_offer",
    metadata: { remarks },
  });
  return updated ?? offer;
}
