import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { businessParties, contactPartyMap, crmOrgPartyMap } from "../../db/schema/party";
import { contacts } from "../../db/schema/crm/contacts";

/**
 * The one translation between an employer and the column that used to hold it.
 *
 * `contacts.organization_id` is an integer `crm_organizations` id;
 * `business_parties.employer_party_id` is a party id. They say the same thing in
 * two id spaces, and getting from one to the other means reading
 * `crm_org_party_map` — a query.
 *
 * That is why this is a file and not a `MirrorCell`. Every cell in
 * `party-mirror-fields.ts` is a pure function of one row, deliberately: it is
 * what lets the divergence sweep re-run the derivation offline and diff it
 * against disk. A cell that needed a database would either break that property
 * or quietly become a second mapper, and the phase has exactly one. So the
 * translation lives out here, the writer calls it on both sides of every contact
 * write, and `PartyDivergenceService.findEmployerDisagreements` is the check that
 * would otherwise have gone missing with it.
 *
 * Plain functions taking `db`, matching `party-legacy-seam.ts` and the writer
 * beside it. Both directions re-assert `organizationId` rather than leaning on
 * RLS, for the same reason the seam does: a legacy id belonging to another
 * tenant must translate to nothing rather than to somebody else's company.
 */

/** The crm_organizations id each of these parties is registered as, where it is one. */
export async function crmOrgIdsOfParties(
  db: Db,
  organizationId: string,
  partyIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const resolved = new Map<string, number>();
  const ids = [...new Set(partyIds)].filter((id) => id.length > 0);
  if (!organizationId || ids.length === 0) return resolved;

  const rows = await db
    .select({ partyId: crmOrgPartyMap.partyId, crmOrganizationId: crmOrgPartyMap.crmOrganizationId })
    .from(crmOrgPartyMap)
    .where(
      and(
        eq(crmOrgPartyMap.organizationId, organizationId),
        inArray(crmOrgPartyMap.partyId, ids),
      ),
    );

  /*
   * Lowest id wins where a party answers to several, which happens after a merge
   * re-points the loser's map row onto the survivor. Any of them is a correct
   * answer to "which company is this"; picking deterministically is what stops
   * the mirror flapping between two of them on consecutive writes and reporting
   * itself as divergent forever.
   */
  for (const row of rows) {
    const existing = resolved.get(row.partyId);
    if (existing === undefined || row.crmOrganizationId < existing)
      resolved.set(row.partyId, row.crmOrganizationId);
  }
  return resolved;
}

/** The party behind each of these crm_organizations ids. */
export async function partyIdsOfCrmOrgs(
  db: Db,
  organizationId: string,
  crmOrganizationIds: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const resolved = new Map<number, string>();
  const ids = [...new Set(crmOrganizationIds)].filter((id) => Number.isInteger(id));
  if (!organizationId || ids.length === 0) return resolved;

  const rows = await db
    .select({ crmOrganizationId: crmOrgPartyMap.crmOrganizationId, partyId: crmOrgPartyMap.partyId })
    .from(crmOrgPartyMap)
    .where(
      and(
        eq(crmOrgPartyMap.organizationId, organizationId),
        inArray(crmOrgPartyMap.crmOrganizationId, ids),
      ),
    );

  for (const row of rows) resolved.set(row.crmOrganizationId, row.partyId);
  return resolved;
}

/**
 * `employer_party_id` → the `contacts.organization_id` that mirrors it.
 *
 * Null where the party has no employer, and also where the employer is a party
 * with no `crm_organizations` row behind it — a company created directly on the
 * Party surface, say. That second null is a real loss of information rather than
 * an absence, and it is what `findEmployerDisagreements` reports: the legacy
 * column cannot name a company the legacy table has never heard of, and
 * inventing a `crm_organizations` row to make it representable would be the
 * mirror writing identity rather than copying it.
 */
export async function employerLegacyIds(
  db: Db,
  organizationId: string,
  employerPartyIds: readonly (string | null)[],
): Promise<ReadonlyMap<string, number>> {
  const present = employerPartyIds.filter((id): id is string => Boolean(id));
  return crmOrgIdsOfParties(db, organizationId, present);
}

/**
 * `contacts.organization_id` → the `employer_party_id` it means.
 *
 * `undefined` in, `undefined` out: a patch that never mentioned the employer must
 * not clear one. An explicit `null` clears it. A number that resolves to nothing
 * throws rather than silently clearing, because "the company you named does not
 * exist here" and "this person has no employer" are different answers and only
 * one of them is a request.
 */
export async function absorbEmployerColumn(
  db: Db,
  organizationId: string,
  legacyOrganizationId: number | null | undefined,
): Promise<{ employerPartyId?: string | null }> {
  if (legacyOrganizationId === undefined) return {};
  if (legacyOrganizationId === null) return { employerPartyId: null };

  const resolved = await partyIdsOfCrmOrgs(db, organizationId, [legacyOrganizationId]);
  const partyId = resolved.get(legacyOrganizationId);
  if (!partyId)
    throw new Error(
      `Organization ${legacyOrganizationId} has no party in this tenant; run the 0264 backfill before pointing an employer at it`,
    );
  return { employerPartyId: partyId };
}

/**
 * Hands every employee of one party to another, and says who moved.
 *
 * The merge needs this and nothing else does. When two company records turn out
 * to be one, the people who work at the loser work at the survivor — the old
 * `crm-org-merge.service` did the same thing one level down, re-pointing
 * `contacts.organization_id` in bulk. Doing it on `employer_party_id` instead is
 * what makes it reversible: the ids come back so the snapshot can put them where
 * they were.
 *
 * Soft-deleted employees move too. A merge that skipped them would leave the
 * deleted rows pointing at a party the merge removed, and restoring one later
 * would resurrect a link to a record that no longer exists.
 */
export async function repointEmployerParties(
  db: Db,
  organizationId: string,
  fromPartyId: string,
  toPartyId: string,
): Promise<string[]> {
  const moved = await db
    .update(businessParties)
    .set({ employerPartyId: toPartyId })
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        eq(businessParties.employerPartyId, fromPartyId),
      ),
    )
    .returning({ partyId: businessParties.partyId });
  return moved.map((row) => row.partyId);
}

/**
 * Brings `contacts.organization_id` back in line for a set of employees, in bulk.
 *
 * `refreshPartyMirrors` would do this one party at a time, which is the right
 * shape for a single edit and the wrong one for a merge that just moved five
 * hundred people. Grouped by the employer's legacy id, so it is one statement per
 * distinct company rather than one per person — and after a merge there is
 * exactly one.
 */
export async function refreshEmployerColumns(
  db: Db,
  organizationId: string,
  employeePartyIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(employeePartyIds)];
  if (!organizationId || ids.length === 0) return;

  const employees = await db
    .select({
      partyId: businessParties.partyId,
      employerPartyId: businessParties.employerPartyId,
    })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        inArray(businessParties.partyId, ids),
      ),
    );

  const legacyByEmployer = await crmOrgIdsOfParties(
    db,
    organizationId,
    employees.map((row) => row.employerPartyId).filter((id): id is string => Boolean(id)),
  );

  const byLegacyId = new Map<number | null, string[]>();
  for (const employee of employees) {
    const legacyId = employee.employerPartyId
      ? (legacyByEmployer.get(employee.employerPartyId) ?? null)
      : null;
    const group = byLegacyId.get(legacyId);
    if (group) group.push(employee.partyId);
    else byLegacyId.set(legacyId, [employee.partyId]);
  }

  for (const [legacyId, partyIds] of byLegacyId)
    await db
      .update(contacts)
      .set({ organizationId: legacyId })
      .where(
        and(
          eq(contacts.orgId, organizationId),
          inArray(
            contacts.id,
            db
              .select({ id: contactPartyMap.contactId })
              .from(contactPartyMap)
              .where(
                and(
                  eq(contactPartyMap.organizationId, organizationId),
                  inArray(contactPartyMap.partyId, partyIds),
                ),
              ),
          ),
        ),
      );
}
