import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { businessParties } from "../../db/schema";
import { assessDuplicate } from "../party/party-duplicates";

/**
 * Refuse a merge the records themselves now contradict.
 *
 * A finding is filed once and applied later, and the records move in between.
 * Somebody adds a registration number, and the pair the detector called a
 * duplicate becomes two demonstrably different companies — so applying a whole
 * group without re-checking is precisely how a stale finding fuses two
 * customers' histories. That asymmetry is the one `party-duplicates` is weighted
 * around: a missed duplicate leaves two rows a human can merge later, while a
 * false merge is only undone by someone noticing.
 *
 * The same scorer, never a second opinion. Whatever the detector refuses to
 * merge on, this refuses to merge on, so the two cannot drift apart the first
 * time either is tuned.
 *
 * Throws rather than returning a verdict, because the caller runs it inside a
 * savepoint whose whole purpose is to turn a throw into one failed item.
 */
export async function refuseIfContradicted(
  db: Db,
  organizationId: string,
  leftPartyId: string,
  rightPartyId: string,
): Promise<void> {
  const rows = await db
    .select({
      partyId: businessParties.partyId,
      name: businessParties.name,
      legalName: businessParties.legalName,
      email: businessParties.email,
      phone: businessParties.phone,
      taxNumber: businessParties.taxNumber,
      website: businessParties.website,
    })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        inArray(businessParties.partyId, [leftPartyId, rightPartyId]),
        isNull(businessParties.deletedAt),
      ),
    );

  const left = rows.find((row) => row.partyId === leftPartyId);
  const right = rows.find((row) => row.partyId === rightPartyId);

  // One of them is gone or already merged away. Nothing to do and nothing to
  // guess at, so this reads as a failed item rather than a silent success.
  if (!left || !right) throw new Error("One of these records no longer exists");

  const { blockers } = assessDuplicate(left, right);
  if (blockers.length > 0)
    throw new Error(`These records now contradict each other: ${blockers.join("; ")}`);
}
