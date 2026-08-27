import { and, eq, inArray } from "drizzle-orm";
import { businessParties } from "../../db/schema";
import type { Db, TenantTx } from "../../db/drizzle.types";

/**
 * The display names for a set of parties, in one query.
 *
 * Phase 2, ticket 08. Four services read `clients` for nothing but a label to
 * put on a row -- an invoice's customer, a survey's client, a ticket's account.
 * Each now holds a `*_party_id` beside its `client_id`, so the label can come
 * from Party and the legacy read can go.
 *
 * A helper rather than four copies of the same twelve lines, because the part
 * that would drift between copies is the **organisation predicate** -- and a
 * name lookup that forgets it is a cross-tenant read that returns something
 * plausible rather than failing.
 *
 * Returns a Map rather than rows: every caller is joining these back onto rows
 * it already has, and handing back an array makes each of them build the same
 * index.
 */
export async function partyNamesFor(
  db: Db | TenantTx,
  organizationId: string,
  partyIds: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(partyIds.filter((id): id is string => Boolean(id)))];

  // `inArray` with an empty list is a SQL error in some dialects and a full scan
  // in others; neither is what "nothing to look up" should cost.
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({ partyId: businessParties.partyId, name: businessParties.name })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        inArray(businessParties.partyId, ids),
      ),
    );

  return new Map(rows.map((row) => [row.partyId, row.name]));
}
