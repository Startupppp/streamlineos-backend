import { ORGANISATION_MIRROR } from "./party-legacy-mirror";
import {
  absorbParentColumn,
  withoutSelfLinks,
} from "./party-legacy-associations";
import {
  applyPartyPatch,
  grantRole,
  insertBareParty,
  mintLegacyId,
  type CrmOrgInsert,
  type CrmOrgRow,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-legacy-writer";
import { legacyOrganisationRow } from "./party-legacy-orgs-helpers";
export { updateMirroredOrganizations, updateMirroredOrganization, softDeleteMirroredOrganizations } from "./party-legacy-orgs-update";

/**
 * The `crm_organizations` entry points, Party-first — and, from ticket 08, Party-only.
 *
 * The fourth of these files and the last one the phase discovered it needed.
 * `crm_organizations` was never counted as an identity table — the split was
 * meant to be `contacts`, `clients`, `leads` and Party — but it carries a name, a
 * domain, an industry, a health score, a parent pointer, a merge pointer and its
 * own merge service, which is Party built a second time. Ticket 25 converged it,
 * and this is where its writes go from here.
 *
 * Ticket 08 drops the table, so nothing below reads or writes it. The rows these
 * functions return are **assembled** from the Party they mirror, by
 * `legacyOrganisationRow`, using the same `ORGANISATION_MIRROR.derive` that used
 * to be handed to `insert(crmOrganizations)`. That is why this is a contract
 * change rather than a behaviour change: the values were already derived from the
 * Party, and the table's only unique contribution was its serial. Migration 0277
 * moved the serial to `crm_org_party_map`, whose `crm_organization_id` now
 * defaults from the sequence `crm_organizations` used to own, detached with
 * `OWNED BY NONE` so `DROP TABLE` cannot take it — numbering continues unbroken
 * and every `/crm/organizations/[organizationId]` link anybody saved still opens
 * the same company.
 *
 * The one difference from its three siblings: a company gets no `party_roles`
 * row. See `ROLE_FOR_KIND` in the writer for why — the call below is still made,
 * so that the decision lives in one place rather than in an omission here.
 *
 * One column does not go through the field map. `crm_organizations.parent_id` is
 * an integer company id and its Party counterpart `parent_party_id` is a party
 * id, so translating needs `crm_org_party_map` and therefore a query — which a
 * `MirrorCell` deliberately cannot do. Both directions run through
 * `party-legacy-associations.ts`: `absorbParentColumn` where a caller's
 * `parentId` goes in, `parentColumnOf` where the assembled row hands one back,
 * and nowhere else. Ticket 25 left the hierarchy on the legacy row and said
 * converging it was the follow-up; 0265 is that follow-up, and 08 is where the
 * row it lived on stops existing.
 *
 * `adoptOrganisation` is gone, and it went the way its own note said it would.
 * It existed for a `crm_organizations` row the Party side had never heard of —
 * a state only the dual-write window could produce — so it could not be
 * converted to read Party instead; there was nothing there to read. Ticket 08
 * removed the table and with it the state. An id absent from
 * `crm_org_party_map` now names nothing and is skipped rather than conjured,
 * which is what these functions already did when adoption found no row.
 */

export async function createMirroredOrganization(
  db: MirrorDb,
  organizationId: string,
  values: CrmOrgInsert,
  options: MirrorWriteOptions = {},
): Promise<CrmOrgRow> {
  return db.transaction(async (tx) => {
    const bare = await insertBareParty(tx, organizationId, values.name);
    const { partyPatch, legacyOwnedPatch } = ORGANISATION_MIRROR.split(values, bare);
    // `partyKind` has no legacy column to come from: every row in this table is a
    // company by construction, which is a fact about the table rather than about
    // any column on it, so the writer states it instead of deriving it.
    const party = await applyPartyPatch(
      tx,
      organizationId,
      bare.partyId,
      withoutSelfLinks(
        {
          ...partyPatch,
          partyKind: "ORGANISATION",
          ...(await absorbParentColumn(tx, organizationId, values.parentId)),
        },
        bare.partyId,
      ),
    );

    /**
     * The identifier comes from the map now, not from a `crm_organizations` insert.
     *
     * Ticket 08's contract, and the same move `createMirroredLead` makes. The row
     * this used to write was already **derived** from the Party --
     * `ORGANISATION_MIRROR.derive(party)` produced every mirrored column and the
     * table only added the serial and its timestamps -- so the table contributed
     * one thing that mattered: the number. 0277 moved the minting to
     * `crm_org_party_map`, and the shape below is assembled from the same
     * derivation that would have been written.
     */
    const crmOrganizationId = await mintLegacyId(
      tx,
      organizationId,
      party.partyId,
      "ORGANISATION",
      options.linkedBy ?? "mirror:create",
    );
    await grantRole(
      tx,
      organizationId,
      party.partyId,
      "ORGANISATION",
      options.linkedBy ?? "mirror:create",
    );

    return legacyOrganisationRow(tx, crmOrganizationId, organizationId, party, legacyOwnedPatch);
  });
}
