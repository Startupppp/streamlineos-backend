import type { Db } from "../../../db/drizzle.types";
import { customerLifecycles } from "../../../db/schema/crm/lifecycle";
import {
  isLegacyResolved,
  resolveLegacyParty,
  type LegacyPartyRef,
} from "../../party/party-legacy-seam";
import { lifecycleFromClosedWon, type ClosedWonDeal } from "../lifecycle-origin";
import type { ClosedWonDealRef, ClosedWonOutcome } from "../lifecycle.types";

/**
 * Opening a term when a deal is won: the body of
 * `LifecycleService.recordClosedWon`, whose docblock states the contract. `db`
 * is the deal transition's own transaction handle, passed straight through.
 */
export async function openLifecycleFromClosedWon(
  db: Db,
  deal: ClosedWonDealRef,
  now: Date,
): Promise<ClosedWonOutcome> {
  const partyId = await resolveCustomerParty(db, deal);

  const origin = lifecycleFromClosedWon({
    organizationId: deal.organizationId,
    dealId: deal.dealId,
    partyId,
    valueMinor: deal.valueMinor,
    actualCloseDate: deal.actualCloseDate,
    customData: deal.customData,
    now,
  } satisfies ClosedWonDeal);

  if (!origin.ok) return { status: "skipped", reason: origin.reason };

  /**
   * `DO NOTHING` on the deal's unique index, not a read-then-write.
   *
   * A deal moved out of a won stage and back — a reversed approval, a
   * corrected misclick — reaches here twice, and two callers can reach here
   * concurrently through a bulk stage change. Checking first and inserting
   * second would let both checks miss and both inserts land, and the customer
   * would appear twice in the renewal book for one contract.
   */
  const inserted = await db
    .insert(customerLifecycles)
    .values({
      organizationId: origin.values.organizationId,
      partyId: origin.values.partyId,
      sourceDealId: origin.values.sourceDealId,
      startedOn: origin.values.startedOn,
      termMonths: origin.values.termMonths,
      renewalOn: origin.values.renewalOn,
      contractValueMinor: origin.values.contractValueMinor,
      riskComputedAt: now,
    })
    .onConflictDoNothing({
      target: [customerLifecycles.organizationId, customerLifecycles.sourceDealId],
    })
    .returning({ customerLifecycleId: customerLifecycles.customerLifecycleId });

  const row = inserted[0];
  return row
    ? { status: "opened", customerLifecycleId: row.customerLifecycleId }
    : { status: "already-open" };
}

/**
 * The customer behind a won deal, as a Party.
 *
 * `deals.party_id` first, because that is the column the CRM writes now. The
 * legacy identifiers are consulted only as a fallback and only through
 * `party-legacy-seam`, never by matching on a name or an email — a heuristic
 * join answers *a* customer, and answering the wrong one silently would put
 * one tenant's revenue against another customer's account.
 *
 * `deals.party_id` is resolved rather than trusted, so a party that has since
 * lost a merge anchors to the survivor. Anchoring to the consumed party would
 * hide the contract from the account it now belongs to.
 */
async function resolveCustomerParty(db: Db, deal: ClosedWonDealRef): Promise<string | null> {
  const candidates: LegacyPartyRef[] = [];
  if (deal.partyId) candidates.push({ kind: "PARTY", legacyId: deal.partyId });
  if (deal.clientId !== null) candidates.push({ kind: "CLIENT", legacyId: deal.clientId });
  if (deal.leadPartyId) candidates.push({ kind: "PARTY", legacyId: deal.leadPartyId });
  if (deal.leadId !== null) candidates.push({ kind: "LEAD", legacyId: deal.leadId });

  for (const ref of candidates) {
    const resolution = await resolveLegacyParty(db, deal.organizationId, ref);
    if (isLegacyResolved(resolution)) return resolution.party.partyId;
  }

  return null;
}
