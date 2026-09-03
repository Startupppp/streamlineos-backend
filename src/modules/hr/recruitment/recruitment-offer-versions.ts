import { and, desc, eq, sql } from "drizzle-orm";
import { candidateOffers, offerVersions } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";

/**
 * `offer_versions` is the append-only history of the compensation terms an offer has
 * carried. It has exactly one write protocol — copy the terms as they stood, stamp the
 * next version number, record who changed them and why — and three callers used to hold
 * three copies of it (offer creation, a terms edit, and a negotiation that applies new
 * terms). The numbering and the set of columns a snapshot preserves live here so a change
 * to either is one edit rather than three that must agree.
 */

/** The columns a version snapshot preserves. Anything outside this set is not versioned. */
export type OfferTerms = Pick<
  typeof candidateOffers.$inferSelect,
  "offeredSalary" | "offeredDesignation" | "joiningDate" | "validUntil" | "notes"
>;

function termColumns(terms: OfferTerms) {
  return {
    offeredSalary: terms.offeredSalary,
    offeredDesignation: terms.offeredDesignation,
    joiningDate: terms.joiningDate,
    validUntil: terms.validUntil,
    notes: terms.notes,
  };
}

export function listOfferVersions(db: Db, orgId: string, offerId: number) {
  return db.query.offerVersions.findMany({
    limit: 100,
    where: and(eq(offerVersions.offerId, offerId), eq(offerVersions.orgId, orgId)),
    orderBy: [desc(offerVersions.versionNumber)],
  });
}

/** Version 1: the terms the offer was created with. */
export async function recordInitialOfferVersion(
  db: Db,
  orgId: string,
  offerId: number,
  terms: OfferTerms,
  userId: string,
): Promise<void> {
  await db.insert(offerVersions).values({
    orgId,
    offerId,
    versionNumber: 1,
    ...termColumns(terms),
    changeReason: "Offer created",
    changedBy: userId,
  });
}

/**
 * Snapshots the terms an offer is about to lose. Call it BEFORE the update that replaces
 * them — it stores `terms` verbatim, so a snapshot taken afterwards records the new terms
 * as though they were the old ones.
 */
export async function snapshotOfferVersion(
  db: Db,
  orgId: string,
  offerId: number,
  terms: OfferTerms,
  userId: string,
  reason: string,
): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(offerVersions)
    .where(eq(offerVersions.offerId, offerId));

  await db.insert(offerVersions).values({
    orgId,
    offerId,
    versionNumber: count + 1,
    ...termColumns(terms),
    changeReason: reason,
    changedBy: userId,
  });
}
