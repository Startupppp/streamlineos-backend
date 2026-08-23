import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { businessParties, partyContacts } from "../../db/schema/party";

/**
 * One way to resolve a party, whichever identifier you hold.
 *
 * Mirrors the person seam deliberately. Two properties matter and neither is
 * optional:
 *
 * Organisation scope is re-asserted on every query rather than leaning on RLS,
 * so a subject belonging to another tenant resolves unresolved even where
 * policies are not yet enabled. Surface that as 404 — a 403 would confirm the
 * record exists and turn a probe into an existence oracle.
 *
 * Unresolved is a **value**, not a throw. A caller that legitimately expects a
 * miss (a dedupe check, an optional link) should not need a try/catch, and one
 * that does not can convert it to 404 in a single line.
 */

export type PartySubject =
  | { readonly kind: "party"; readonly partyId: string }
  | { readonly kind: "contact"; readonly partyContactId: string };

export type PartyResolutionPath = "party-record" | "contact-record";

export interface ResolvedParty {
  readonly partyId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly partyType: string;
  readonly status: string;
  /** Present only when resolution started from a contact. */
  readonly partyContactId: string | null;
  /** Which lookup answered. Resolution short-circuits, so this says what was read. */
  readonly resolvedVia: PartyResolutionPath;
}

export type PartyResolution =
  | { readonly status: "resolved"; readonly party: ResolvedParty }
  | { readonly status: "unresolved"; readonly subject: PartySubject };

function unresolved(subject: PartySubject): PartyResolution {
  return { status: "unresolved", subject };
}

export function isResolved(
  resolution: PartyResolution,
): resolution is Extract<PartyResolution, { status: "resolved" }> {
  return resolution.status === "resolved";
}

export async function resolveParty(
  db: Db,
  organizationId: string,
  subject: PartySubject,
): Promise<PartyResolution> {
  if (!organizationId) return unresolved(subject);

  if (subject.kind === "party") {
    if (!subject.partyId) return unresolved(subject);

    const [row] = await db
      .select({
        partyId: businessParties.partyId,
        organizationId: businessParties.organizationId,
        name: businessParties.name,
        partyType: businessParties.partyType,
        status: businessParties.status,
      })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.partyId, subject.partyId),
          eq(businessParties.organizationId, organizationId),
          isNull(businessParties.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return unresolved(subject);

    return {
      status: "resolved",
      party: { ...row, partyContactId: null, resolvedVia: "party-record" },
    };
  }

  if (!subject.partyContactId) return unresolved(subject);

  const [row] = await db
    .select({
      partyId: businessParties.partyId,
      organizationId: businessParties.organizationId,
      name: businessParties.name,
      partyType: businessParties.partyType,
      status: businessParties.status,
      partyContactId: partyContacts.partyContactId,
    })
    .from(partyContacts)
    .innerJoin(
      businessParties,
      and(
        eq(businessParties.partyId, partyContacts.partyId),
        // The join carries the tenant too: a contact must not be able to reach a
        // party in another organisation even if its party_id were tampered with.
        eq(businessParties.organizationId, partyContacts.organizationId),
        isNull(businessParties.deletedAt),
      ),
    )
    .where(
      and(
        eq(partyContacts.partyContactId, subject.partyContactId),
        eq(partyContacts.organizationId, organizationId),
        isNull(partyContacts.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return unresolved(subject);

  return { status: "resolved", party: { ...row, resolvedVia: "contact-record" } };
}
