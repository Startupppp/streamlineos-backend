import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { partyIdentifiers } from "../../db/schema/party";
import {
  IDENTIFIER_KINDS,
  type IdentifierKind,
} from "../ingress/inbound-event";

/** An identifier as a caller states it, before it reaches a row. */
export interface IdentifierClaim {
  readonly kind: IdentifierKind;
  /** As it was given. `normaliseIdentifier` decides what it is matched on. */
  readonly value: string;
}

function isKnownKind(row: { kind: string; value: string }): row is IdentifierClaim {
  return IDENTIFIER_KINDS.some((kind) => kind === row.kind);
}

/** Everything one party is reachable at, for the duplicate scorer and the merge. */
export async function identifiersOfParty(
  db: Db,
  organizationId: string,
  partyId: string,
): Promise<IdentifierClaim[]> {
  const rows = await db
    .select({ kind: partyIdentifiers.kind, value: partyIdentifiers.normalisedValue })
    .from(partyIdentifiers)
    .where(
      and(
        eq(partyIdentifiers.organizationId, organizationId),
        eq(partyIdentifiers.partyId, partyId),
      ),
    );
  return rows.filter(isKnownKind);
}

/**
 * Every other party sharing an identifier with this one.
 *
 * The duplicate detector's candidate search. It used to compare
 * `business_parties.email` and `.phone` as strings, which found `Ops@Acme.example`
 * and `ops@acme.example` to be different records and `+44 20 7123 4567` and
 * `+442071234567` to be different lines — so the pairs most worth merging were
 * the ones it could not see.
 */
export async function partiesSharingIdentifiers(
  db: Db,
  organizationId: string,
  partyId: string,
  limit: number,
): Promise<string[]> {
  const mine = await db
    .select({ kind: partyIdentifiers.kind, normalisedValue: partyIdentifiers.normalisedValue })
    .from(partyIdentifiers)
    .where(
      and(
        eq(partyIdentifiers.organizationId, organizationId),
        eq(partyIdentifiers.partyId, partyId),
      ),
    );

  if (mine.length === 0) return [];

  /**
   * Matched on the value alone, across kinds.
   *
   * The same number reached by telephone and by WhatsApp is one line, and a
   * duplicate pair is exactly where the two records disagree about which
   * column it belongs in — so restricting the search to the same kind would
   * miss the case the scorer most needs to see. The scorer still weighs the
   * kinds separately; this only decides who is worth comparing.
   */
  const rows = await db
    .select({ partyId: partyIdentifiers.partyId })
    .from(partyIdentifiers)
    .where(
      and(
        eq(partyIdentifiers.organizationId, organizationId),
        ne(partyIdentifiers.partyId, partyId),
        inArray(
          partyIdentifiers.normalisedValue,
          mine.map((row) => row.normalisedValue),
        ),
      ),
    )
    .limit(limit);

  return [...new Set(rows.map((row) => row.partyId))];
}

/**
 * Hands the loser's identifiers to the survivor of a merge.
 *
 * Re-pointing them, rather than teaching the resolver to walk the merge ledger,
 * is the same choice ticket 01 made for `*_party_map`: one merge mechanism
 * instead of two. Without it the next message from the merged record's address
 * resolves to a party that was deleted by the merge — a live wrong answer, not
 * a missing one.
 *
 * Returns what moved, so the revert can put it back.
 */
export async function moveIdentifiers(
  db: Db,
  organizationId: string,
  fromPartyId: string,
  toPartyId: string,
): Promise<string[]> {
  const moved = await db
    .update(partyIdentifiers)
    .set({ partyId: toPartyId })
    .where(
      and(
        eq(partyIdentifiers.organizationId, organizationId),
        eq(partyIdentifiers.partyId, fromPartyId),
      ),
    )
    .returning({ partyIdentifierId: partyIdentifiers.partyIdentifierId });

  return moved.map((row) => row.partyIdentifierId);
}

/** Puts moved identifiers back on the record they came from. */
export async function restoreIdentifiers(
  db: Db,
  organizationId: string,
  partyIdentifierIds: readonly string[],
  partyId: string,
): Promise<void> {
  if (partyIdentifierIds.length === 0) return;
  await db
    .update(partyIdentifiers)
    .set({ partyId })
    .where(
      and(
        eq(partyIdentifiers.organizationId, organizationId),
        inArray(partyIdentifiers.partyIdentifierId, [...partyIdentifierIds]),
      ),
    );
}
