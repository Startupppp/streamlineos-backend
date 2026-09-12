import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { businessParties, partyIdentifiers } from "../../db/schema/party";
import {
  IDENTIFIER_KINDS,
  normaliseIdentifier,
  type IdentifierKind,
} from "../ingress/inbound-event";
import type { IdentifierClaim } from "./party-identifiers-merge";

export type { IdentifierClaim };

/**
 * Reaching a party, and being reached by one.
 *
 * `business_parties.email`, `.phone` and `.whatsapp_phone` are display fields
 * from here on. This file is the matching mechanism, and it is the only one —
 * a second path that falls back to the columns would be the thing the ticket
 * forbids, because the two would disagree the first time somebody edited a
 * record and nothing would say which answer was current.
 *
 * The vocabulary and the normalisation rules come from the ingress seam, which
 * is where the kind is decided and where the one copy of "what does this string
 * reduce to" lives. This file adds only what needs a database: claiming,
 * resolving, moving on a merge.
 */

export { IDENTIFIER_KINDS, type IdentifierKind };

/**
 * The kinds that name the same thing, in the order a lookup prefers them.
 *
 * `phone` and `whatsapp` are one telephone line reached two ways. Ticket 01
 * gave them separate columns because they are separate *channels*, and that is
 * still true of how you contact someone — but it is not true of who they are,
 * and treating it as identity is how a customer who rings on Monday and
 * messages on Tuesday becomes two records.
 *
 * This is an equivalence declared once, not a second resolution path: one
 * lookup, one ordered list of kinds, and the identifier's own kind always
 * first, so a WhatsApp message prefers a WhatsApp claim and falls to the
 * telephone number only when there is none.
 */
export const MATCHING_KINDS: Record<IdentifierKind, readonly IdentifierKind[]> = {
  email: ["email"],
  phone: ["phone", "whatsapp"],
  whatsapp: ["whatsapp", "phone"],
  handle: ["handle"],
};

/** Which Party column a resolved identifier belongs in, for a party being created. */
export const COLUMN_FOR_KIND: Record<IdentifierKind, "email" | "phone" | "whatsappPhone" | null> = {
  email: "email",
  phone: "phone",
  whatsapp: "whatsappPhone",
  // A handle has no column, and inventing one is what this table replaced.
  handle: null,
};

/** The contact columns a party carries, as the identifiers they imply. */
export interface PartyContactColumns {
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly whatsappPhone?: string | null;
}

/**
 * What a party's display columns claim.
 *
 * The bridge between the columns a human fills in and the table the resolver
 * reads. Called on every path that writes those columns, which is what keeps
 * 0260's backfill from being a one-time snapshot: a lead created tomorrow with
 * an email address matches the mail channel for the same reason one created
 * last year does.
 */
export function identifierClaimsOfColumns(columns: PartyContactColumns): IdentifierClaim[] {
  const claims: IdentifierClaim[] = [];
  if (columns.email?.trim()) claims.push({ kind: "email", value: columns.email });
  if (columns.phone?.trim()) claims.push({ kind: "phone", value: columns.phone });
  if (columns.whatsappPhone?.trim())
    claims.push({ kind: "whatsapp", value: columns.whatsappPhone });
  return claims;
}

/** The claims a patch is about to make, or none if it touches no contact column. */
export function claimsOfPatch(patch: PartyContactColumns): IdentifierClaim[] | null {
  const touches =
    patch.email !== undefined || patch.phone !== undefined || patch.whatsappPhone !== undefined;
  return touches ? identifierClaimsOfColumns(patch) : null;
}

/**
 * Records that a party is reachable at these identifiers.
 *
 * Conflicts are ignored rather than raised, and that is a decision. The unique
 * index means a value already claimed by another party cannot be claimed again;
 * failing the write would make saving a customer's record depend on whether
 * somebody else in the organisation happens to have typed the same number
 * years ago. Losing the claim leaves a duplicate for the merge machinery to
 * find, which is the recoverable direction.
 *
 * Claims accumulate rather than being replaced when a column changes. An
 * identifier records that this party HAS been reachable here, and editing the
 * displayed address does not unsend the mail already at the old one — while
 * withdrawing the claim would silently free the value for a different party to
 * take, which is the failure this table exists to rule out.
 */
export async function claimIdentifiers(
  db: Db,
  organizationId: string,
  partyId: string,
  claims: readonly IdentifierClaim[],
): Promise<void> {
  const rows = [];
  const seen = new Set<string>();

  for (const claim of claims) {
    const normalisedValue = normaliseIdentifier(claim.kind, claim.value);
    if (!normalisedValue) continue;
    const key = `${claim.kind}:${normalisedValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ organizationId, partyId, kind: claim.kind, value: claim.value.trim(), normalisedValue });
  }

  if (rows.length === 0) return;
  await db.insert(partyIdentifiers).values(rows).onConflictDoNothing();
}

/**
 * The party this identifier belongs to, or null.
 *
 * The whole of `resolve-party`'s matching. It replaces the old
 * `business_parties.email` comparison rather than sitting beside it, so a
 * channel that carries phone numbers matches a party for the same reason mail
 * does instead of writing a phone number into the email column.
 *
 * A claim held by a soft-deleted party is released here, on the way past. The
 * alternative is worse in both directions: filing new contact against a record
 * the organisation deleted hides the message, and refusing to create a party
 * because a deleted one still holds the address would make the deletion
 * permanently poison that address. Releasing it restores exactly the behaviour
 * that existed before this table — a deleted record is not matched, and the
 * next contact starts a new one.
 */
export async function resolvePartyByIdentifier(
  db: Db,
  organizationId: string,
  kind: IdentifierKind,
  value: string,
): Promise<string | null> {
  const normalisedValue = normaliseIdentifier(kind, value);
  if (!normalisedValue) return null;

  const [claim] = await db
    .select({
      partyIdentifierId: partyIdentifiers.partyIdentifierId,
      partyId: partyIdentifiers.partyId,
    })
    .from(partyIdentifiers)
    .where(
      and(
        eq(partyIdentifiers.organizationId, organizationId),
        inArray(partyIdentifiers.kind, [...MATCHING_KINDS[kind]]),
        eq(partyIdentifiers.normalisedValue, normalisedValue),
      ),
    )
    .limit(1);

  if (!claim) return null;

  const [owner] = await db
    .select({ deletedAt: businessParties.deletedAt })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        eq(businessParties.partyId, claim.partyId),
      ),
    )
    .limit(1);

  if (owner && !owner.deletedAt) return claim.partyId;

  await db
    .delete(partyIdentifiers)
    .where(
      and(
        eq(partyIdentifiers.organizationId, organizationId),
        eq(partyIdentifiers.partyIdentifierId, claim.partyIdentifierId),
      ),
    );

  return null;
}
