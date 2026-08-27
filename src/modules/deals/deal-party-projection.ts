import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { businessParties } from "../../db/schema/party";

/**
 * The `lead` and `client` a deal is shown next to, read from Party.
 *
 * These used to be relational includes -- `with: { lead: {...}, client: {...} }`
 * -- resolving through Drizzle relations onto the `leads` and `clients` tables.
 * Ticket 08 dropped those tables, and the names the includes were reading have
 * been Party's since phase 2 anyway: the include was fetching a mirror of a
 * column it could have read directly.
 *
 * Not reinstated as a relation, and that is deliberate rather than lazy.
 * `business-parties.ts` imports `deals` (a deal is what a party's `primary_deal_id`
 * points at), so declaring `deals -> businessParties` at schema level closes a
 * cycle through the schema barrel. This cost a build once already, when the same
 * relations were added and reverted. A second query is the cheaper answer, and
 * it batches: one statement for a page of deals however many parties they name.
 *
 * The projected shape is unchanged, down to the integer `id`. The frontend's
 * `Deal.lead` is `{ id: number; name: string; email?; phone? }` and stays that
 * way -- `id` is the legacy identifier, which `lead_party_map` still mints and
 * `deals.lead_id` still carries.
 */

export interface PartyLabel {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
}

/** The party columns a deal's lead/client label is built from. */
async function labelsByPartyId(
  db: Db,
  orgId: string,
  partyIds: readonly string[],
): Promise<Map<string, { name: string; email: string | null; phone: string | null }>> {
  const ids = [...new Set(partyIds)];
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({
      partyId: businessParties.partyId,
      name: businessParties.name,
      email: businessParties.email,
      phone: businessParties.phone,
    })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, orgId),
        inArray(businessParties.partyId, ids),
      ),
    );

  return new Map(rows.map((row) => [row.partyId, row]));
}

/** A deal as the relational query returns it, before the labels are attached. */
interface DealRow {
  leadId: number | null;
  leadPartyId: string | null;
  clientId: number | null;
  partyId: string | null;
}

/**
 * Attach `lead` and `client` to each deal.
 *
 * `null` where the deal names nobody, and `null` too where it names a party the
 * tenant cannot see -- which is the same answer the `leftJoin` behind the old
 * include gave, and the one that keeps a cross-tenant id from leaking a name.
 *
 * The client's party is `deals.party_id`, not `client_party_id`: `deals` was
 * migrated before that convention existed. `party-column-invariant.spec.ts`
 * records the exception rather than renaming a working column.
 */
export async function withPartyLabels<T extends DealRow>(
  db: Db,
  orgId: string,
  deals: readonly T[],
): Promise<(T & { lead: PartyLabel | null; client: PartyLabel | null })[]> {
  const labels = await labelsByPartyId(db, orgId, [
    ...deals.flatMap((deal) => (deal.leadPartyId ? [deal.leadPartyId] : [])),
    ...deals.flatMap((deal) => (deal.partyId ? [deal.partyId] : [])),
  ]);

  const label = (legacyId: number | null, partyId: string | null): PartyLabel | null => {
    if (legacyId === null || partyId === null) return null;
    const party = labels.get(partyId);
    return party ? { id: legacyId, name: party.name, email: party.email, phone: party.phone } : null;
  };

  return deals.map((deal) => ({
    ...deal,
    lead: label(deal.leadId, deal.leadPartyId),
    client: label(deal.clientId, deal.partyId),
  }));
}
