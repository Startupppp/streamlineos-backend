import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  clientPartyMap,
  contactPartyMap,
  crmOrgPartyMap,
  leadPartyMap,
  partyMerges,
} from "../../db/schema/party";

/**
 * One way to find the Party behind a legacy identifier.
 *
 * Until the contract step drops them, `leads`, `clients` and `contacts` are
 * still the identity every screen, job and stored reference is holding. This is
 * the only supported way to get from one of those to a Party, and it is backed
 * by the `*_party_map` tables rather than a match on name or email — a
 * heuristic join answers *a* person, and answering the wrong one silently is the
 * failure mode that makes an identity migration unrecoverable.
 *
 * Three properties, deliberately mirroring `party-seam.ts`:
 *
 * Organisation scope is re-asserted on every query rather than left to RLS, so a
 * legacy id belonging to another tenant resolves unresolved. Surface that as
 * 404; a 403 would confirm the record exists.
 *
 * Unresolved is a **value**, not a throw. During the migration a miss is
 * ordinary — a row created before the backfill, a record whose legacy row was
 * deleted — and a caller should not need a try/catch to handle the ordinary.
 *
 * A soft-deleted Party still resolves, where `resolveParty` treats it as absent.
 * Which Party an identifier *means* is not the same question as whether it
 * should be displayed, and conflating them would make this seam lossier than the
 * table it stands in for: a deleted lead's detail page has always rendered.
 * `deletedAt` comes back with the answer so the caller can decide.
 */

export type LegacyPartyKind = "LEAD" | "CLIENT" | "CONTACT" | "ORGANISATION" | "PARTY";

/** The four tables whose ids are integers and need a map to be resolved. */
export type MappedLegacyKind = Extract<
  LegacyPartyKind,
  "LEAD" | "CLIENT" | "CONTACT" | "ORGANISATION"
>;

export const MAPPED_LEGACY_KINDS: readonly MappedLegacyKind[] = [
  "LEAD",
  "CLIENT",
  "CONTACT",
  // `crm_organizations`, the fifth identity table nobody counted. Ticket 25.
  "ORGANISATION",
];

/**
 * `(legacyKind, legacyId)`, with the id typed by the kind that owns it.
 *
 * `PARTY` is here so that a caller holding any of the four identities has one
 * function to call; it resolves to itself and needs no map.
 */
export type LegacyPartyRef =
  | { readonly kind: MappedLegacyKind; readonly legacyId: number }
  | { readonly kind: "PARTY"; readonly legacyId: string };

export type LegacyResolutionPath =
  | "lead-map"
  | "client-map"
  | "contact-map"
  | "crm-org-map"
  | "party-record";

export interface ResolvedLegacyParty {
  readonly partyId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly partyType: string;
  readonly status: string;
  /** Set when the Party is soft-deleted. Still the right answer; see above. */
  readonly deletedAt: Date | null;
  readonly resolvedVia: LegacyResolutionPath;
  /** True when the identifier's own Party lost a merge and the survivor answered. */
  readonly followedMerge: boolean;
}

export type LegacyPartyResolution =
  | { readonly status: "resolved"; readonly party: ResolvedLegacyParty }
  | { readonly status: "unresolved"; readonly ref: LegacyPartyRef };

export function isLegacyResolved(
  resolution: LegacyPartyResolution,
): resolution is Extract<LegacyPartyResolution, { status: "resolved" }> {
  return resolution.status === "resolved";
}

const PARTY_COLUMNS = {
  partyId: businessParties.partyId,
  organizationId: businessParties.organizationId,
  name: businessParties.name,
  partyType: businessParties.partyType,
  status: businessParties.status,
  deletedAt: businessParties.deletedAt,
};

/**
 * How far a merge chain is followed before giving up.
 *
 * A merge of a merge of a merge is real; an unbounded walk over a table with a
 * cycle in it is a hung request. Eight is far more than any observed chain and
 * still terminates.
 */
const MAX_MERGE_HOPS = 8;
const LEGACY_LOOKUP_BATCH_SIZE = 500;

function unresolved(ref: LegacyPartyRef): LegacyPartyResolution {
  return { status: "unresolved", ref };
}

async function loadParty(db: Db, organizationId: string, partyId: string) {
  const [row] = await db
    .select(PARTY_COLUMNS)
    .from(businessParties)
    .where(
      and(
        eq(businessParties.partyId, partyId),
        eq(businessParties.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Walks a party id forward through the merges that consumed it.
 *
 * Only the `PARTY` path needs this. A legacy id does not, because a merge
 * re-points its map row onto the survivor — one mechanism, not two, and
 * `party-merge.service` is where that happens. A party id has no map row to
 * re-point, so the merge ledger is the only record that it moved.
 */
async function followMerges(
  db: Db,
  organizationId: string,
  partyId: string,
): Promise<{ partyId: string; hops: number }> {
  const seen = new Set<string>([partyId]);
  let current = partyId;

  for (let hop = 1; hop <= MAX_MERGE_HOPS; hop += 1) {
    const [merge] = await db
      .select({ survivorPartyId: partyMerges.survivorPartyId })
      .from(partyMerges)
      .where(
        and(
          eq(partyMerges.organizationId, organizationId),
          eq(partyMerges.mergedPartyId, current),
          isNull(partyMerges.revertedAt),
        ),
      )
      .limit(1);

    if (!merge || seen.has(merge.survivorPartyId)) return { partyId: current, hops: hop - 1 };

    seen.add(merge.survivorPartyId);
    current = merge.survivorPartyId;
  }

  return { partyId: current, hops: MAX_MERGE_HOPS };
}

const PATH_BY_KIND: Record<MappedLegacyKind, LegacyResolutionPath> = {
  LEAD: "lead-map",
  CLIENT: "client-map",
  CONTACT: "contact-map",
  ORGANISATION: "crm-org-map",
};

export async function resolveLegacyParty(
  db: Db,
  organizationId: string,
  ref: LegacyPartyRef,
): Promise<LegacyPartyResolution> {
  if (!organizationId) return unresolved(ref);

  if (ref.kind === "PARTY") {
    if (!ref.legacyId) return unresolved(ref);

    const direct = await loadParty(db, organizationId, ref.legacyId);
    if (direct && !direct.deletedAt)
      return {
        status: "resolved",
        party: { ...direct, resolvedVia: "party-record", followedMerge: false },
      };

    // Absent or soft-deleted: it may have lost a merge. A soft delete that was
    // not a merge leaves the walk where it started and the record is returned
    // as it stands, deletion included.
    const followed = await followMerges(db, organizationId, ref.legacyId);
    if (followed.hops === 0)
      return direct
        ? {
            status: "resolved",
            party: { ...direct, resolvedVia: "party-record", followedMerge: false },
          }
        : unresolved(ref);

    const survivor = await loadParty(db, organizationId, followed.partyId);
    if (!survivor) return unresolved(ref);

    return {
      status: "resolved",
      party: { ...survivor, resolvedVia: "party-record", followedMerge: true },
    };
  }

  if (!Number.isInteger(ref.legacyId)) return unresolved(ref);

  const [row] = await selectThroughMap(db, organizationId, ref.kind, [ref.legacyId]);
  if (!row) return unresolved(ref);

  return {
    status: "resolved",
    party: {
      partyId: row.partyId,
      organizationId: row.organizationId,
      name: row.name,
      partyType: row.partyType,
      status: row.status,
      deletedAt: row.deletedAt,
      resolvedVia: PATH_BY_KIND[ref.kind],
      followedMerge: false,
    },
  };
}

interface MappedRow {
  partyId: string;
  organizationId: string;
  name: string;
  partyType: string;
  status: string;
  deletedAt: Date | null;
  legacyId: number;
}

/**
 * The one query every mapped kind goes through.
 *
 * The join carries the tenant on both sides: a map row must not be able to reach
 * a party in another organisation even if its `party_id` were tampered with, and
 * the composite foreign key behind it is what makes that a fact rather than a
 * hope.
 */
async function selectThroughMap(
  db: Db,
  organizationId: string,
  kind: MappedLegacyKind,
  legacyIds: number[],
): Promise<MappedRow[]> {
  if (kind === "LEAD")
    return db
      .select({ ...PARTY_COLUMNS, legacyId: leadPartyMap.leadId })
      .from(leadPartyMap)
      .innerJoin(
        businessParties,
        and(
          eq(businessParties.partyId, leadPartyMap.partyId),
          eq(businessParties.organizationId, leadPartyMap.organizationId),
        ),
      )
      .where(
        and(
          eq(leadPartyMap.organizationId, organizationId),
          inArray(leadPartyMap.leadId, legacyIds),
        ),
      )
      .limit(LEGACY_LOOKUP_BATCH_SIZE);

  if (kind === "CLIENT")
    return db
      .select({ ...PARTY_COLUMNS, legacyId: clientPartyMap.clientId })
      .from(clientPartyMap)
      .innerJoin(
        businessParties,
        and(
          eq(businessParties.partyId, clientPartyMap.partyId),
          eq(businessParties.organizationId, clientPartyMap.organizationId),
        ),
      )
      .where(
        and(
          eq(clientPartyMap.organizationId, organizationId),
          inArray(clientPartyMap.clientId, legacyIds),
        ),
      )
      .limit(LEGACY_LOOKUP_BATCH_SIZE);

  if (kind === "CONTACT")
    return db
      .select({ ...PARTY_COLUMNS, legacyId: contactPartyMap.contactId })
      .from(contactPartyMap)
      .innerJoin(
        businessParties,
        and(
          eq(businessParties.partyId, contactPartyMap.partyId),
          eq(businessParties.organizationId, contactPartyMap.organizationId),
        ),
      )
      .where(
        and(
          eq(contactPartyMap.organizationId, organizationId),
          inArray(contactPartyMap.contactId, legacyIds),
        ),
      )
      .limit(LEGACY_LOOKUP_BATCH_SIZE);

  return db
    .select({ ...PARTY_COLUMNS, legacyId: crmOrgPartyMap.crmOrganizationId })
    .from(crmOrgPartyMap)
    .innerJoin(
      businessParties,
      and(
        eq(businessParties.partyId, crmOrgPartyMap.partyId),
        eq(businessParties.organizationId, crmOrgPartyMap.organizationId),
      ),
    )
    .where(
      and(
        eq(crmOrgPartyMap.organizationId, organizationId),
          inArray(crmOrgPartyMap.crmOrganizationId, legacyIds),
        ),
      )
      .limit(LEGACY_LOOKUP_BATCH_SIZE);
}

/**
 * The list read: many legacy ids, one query.
 *
 * A screen showing fifty leads needs fifty party ids, and calling
 * `resolveLegacyParty` per row would put the migration's cost on every page. Ids
 * only — a caller that wants the whole Party is looking at one record.
 */
export async function resolveLegacyPartyIds(
  db: Db,
  organizationId: string,
  kind: MappedLegacyKind,
  legacyIds: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const resolved = new Map<number, string>();
  const ids = [...new Set(legacyIds)].filter((id) => Number.isInteger(id));
  if (!organizationId || ids.length === 0) return resolved;

  for (let start = 0; start < ids.length; start += LEGACY_LOOKUP_BATCH_SIZE)
    for (const row of await selectThroughMap(
      db,
      organizationId,
      kind,
      ids.slice(start, start + LEGACY_LOOKUP_BATCH_SIZE),
    ))
      resolved.set(row.legacyId, row.partyId);

  return resolved;
}
