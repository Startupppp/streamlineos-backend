import { Inject, Injectable } from "@nestjs/common";
import { aliasedTable, and, asc, eq, isNull } from "drizzle-orm";
import { businessParties, contactPartyMap } from "../../../db/schema/party";
import { CONTACT_MIRROR, ORGANISATION_MIRROR } from "../../party/party-legacy-mirror";
import {
  createMirroredOrganization,
  softDeleteMirroredOrganizations,
  updateMirroredOrganization,
} from "../../party/party-legacy-orgs";
import { crmOrgIdsOfParties } from "../../party/party-legacy-employer";
import { leadIdsOfParties, parentColumnOf } from "../../party/party-legacy-associations";
import { isLegacyResolved, resolveLegacyParty } from "../../party/party-legacy-seam";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import {
  findPotentialDuplicates,
  getDuplicateOrgs,
  queryOrganizationList,
  type CrmOrgListingDeps,
} from "./lib/crm-org-listing";
import type {
  OrgDuplicatesQueryInput,
  OrganizationCreateInput,
  OrganizationListInput,
  OrganizationUpdateInput,
} from "./dto/organizations.schemas";

const ORG_EMPLOYEE_LIMIT = 100;

/**
 * `business_parties` a second time, as the person rather than the company.
 *
 * The employer link is self-referential, so the detail read has both ends of it
 * in one query and each needs its own name.
 */
const employee = aliasedTable(businessParties, "employee_party");

/**
 * Companies, which are parties: one company at a time.
 *
 * Ticket 25's half of the convergence. `crm_organizations` was the fifth
 * identity table — a company record with a name, a domain, an industry, a health
 * score and its own merge service, which is Party built twice — so this surface
 * now reads `business_parties` where `party_kind = 'ORGANISATION'` and joins
 * `crm_org_party_map` only to keep answering in the integer ids that every
 * bookmark, `roadmap_items.crm_organization_id` and `tickets.customer_id` is
 * still holding. `/crm/organizations` and `/party/parties?partyKind=ORGANISATION`
 * are now one list under two routes rather than two lists.
 *
 * The inner join to the map is what supplies that `id`, and it is the reason a
 * company created directly on the Party surface does not appear here yet. When
 * `crm_organizations` is dropped the join goes with it and the party id becomes
 * the id.
 *
 * Every write goes through `party-legacy-orgs.ts`, as tickets 03–07 did for the
 * other four tables. Nothing in this file writes `crm_organizations` directly.
 *
 * What is left here resolves ONE company through `partyOf` and acts on it. The
 * reads that treat companies as a set — the list and the two duplicate reads
 * that share one definition of "the same company" — are in
 * `lib/crm-org-listing.ts`, which is also where the projection and the
 * `isCompany` predicate they all share now live.
 */
@Injectable()
export class CrmOrganizationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private get listingDeps(): CrmOrgListingDeps {
    return { db: this.db };
  }

  /**
   * The party behind a company id, with the tenant asserted on both sides.
   *
   * A company in another organisation resolves to nothing rather than to a
   * forbidden, so the caller can 404 it: a 403 on somebody else's id confirms
   * the record exists.
   */
  private async partyOf(orgId: string, crmOrganizationId: number): Promise<string | null> {
    const resolution = await resolveLegacyParty(this.db, orgId, {
      kind: "ORGANISATION",
      legacyId: crmOrganizationId,
    });
    if (!isLegacyResolved(resolution) || resolution.party.deletedAt) return null;
    return resolution.party.partyId;
  }

  list(orgId: string, filters: OrganizationListInput) {
    const searchTerm = (filters.search ?? filters.q ?? "").trim();
    const key = `${filters.cursor ?? ""}:${filters.pageSize}:${searchTerm}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.crmOrganizationsListNamespace(orgId),
      key,
      () => queryOrganizationList(this.listingDeps, orgId, filters, searchTerm),
      CACHE_TTL.SHORT,
    );
  }

  /** See `lib/crm-org-listing.ts`: a warning, never a block. */
  findPotentialDuplicates(orgId: string, input: { name?: string; domain?: string | null }) {
    return findPotentialDuplicates(this.listingDeps, orgId, input);
  }

  /** The pairwise report the merge screen reads, on the same criteria. */
  getDuplicateOrgs(orgId: string, query: OrgDuplicatesQueryInput) {
    return getDuplicateOrgs(this.listingDeps, orgId, query);
  }

  async create(orgId: string, input: OrganizationCreateInput) {
    const possibleDuplicates = await findPotentialDuplicates(this.listingDeps, orgId, {
      name: input.name,
      domain: input.domain ?? null,
    });

    const row = await createMirroredOrganization(this.db, orgId, {
      orgId,
      name: input.name,
      domain: input.domain ?? null,
      industry: input.industry ?? null,
      size: input.size ?? null,
      website: input.website || null,
      linkedinUrl: input.linkedinUrl || null,
      description: input.description ?? null,
    });

    await this.invalidateOrgCaches(orgId);
    return {
      id: row.id,
      name: row.name,
      domain: row.domain,
      industry: row.industry,
      size: row.size,
      website: row.website,
      linkedinUrl: row.linkedinUrl,
      description: row.description,
      createdAt: row.createdAt,
      possibleDuplicates,
    };
  }

  /**
   * One company and the people who work there.
   *
   * The employees come off `employer_party_id` rather than
   * `contacts.organization_id` — the whole point of ticket 25 is that a party's
   * employer is another party, which is what makes "who else works here" a
   * question with an answer. The response keeps the `contacts` and
   * `crm_organizations` shapes it has always had, but both are now *derived*
   * rather than read: the mirrored columns come from the same
   * `party-legacy-mirror` derivation the writer uses, and the handful of
   * legacy-owned ids are resolved through the maps. So a caller reads the party's
   * values, and neither legacy table is touched.
   */
  async getWithContacts(orgId: string, id: number) {
    const partyId = await this.partyOf(orgId, id);
    if (!partyId) return null;

    const [[party], employees] = await Promise.all([
      this.db
        .select()
        .from(businessParties)
        .where(
          and(eq(businessParties.partyId, partyId), eq(businessParties.organizationId, orgId)),
        )
        .limit(1),
      this.db
        .select({ contactId: contactPartyMap.contactId, party: employee })
        .from(employee)
        .innerJoin(
          contactPartyMap,
          and(
            eq(contactPartyMap.partyId, employee.partyId),
            eq(contactPartyMap.organizationId, employee.organizationId),
          ),
        )
        .where(
          and(
            eq(employee.organizationId, orgId),
            eq(employee.employerPartyId, partyId),
            isNull(employee.deletedAt),
          ),
        )
        // Named, then keyed: the list is shown to a person, and `created_at`
        // alone repeats across a bulk import.
        .orderBy(asc(employee.name), asc(contactPartyMap.contactId))
        .limit(ORG_EMPLOYEE_LIMIT),
    ]);
    if (!party) return null;

    /*
     * The legacy-owned ids, resolved once for the page. `organization_id` is the
     * same for every employee by construction — they are the people whose employer
     * IS this party — so it is one lookup rather than one per row, and it goes
     * through the same lowest-id-wins rule the mirror writes the column with.
     */
    const [companyLegacyIds, employerLegacyId, leadIds] = await Promise.all([
      parentColumnOf(this.db, orgId, party.parentPartyId),
      crmOrgIdsOfParties(this.db, orgId, [partyId]),
      leadIdsOfParties(
        this.db,
        orgId,
        employees
          .map((row) => row.party.convertedFromPartyId)
          .filter((id): id is string => id !== null),
      ),
    ]);

    return {
      // The `crm_organizations` shape: its own id, the hierarchy pointer, the
      // stamps 0264 carried onto the party, and everything else derived.
      id,
      orgId,
      parentId: companyLegacyIds.parentId,
      /*
       * Always null, and kept rather than dropped so the response shape does not
       * change. `crm_organizations.merged_into_id` is not written any more —
       * `party_merges` is the record, and a second pointer nothing can revert is
       * worse than none — and every row that carries a historical value was
       * soft-deleted by the merge that set it, which `partyOf` above refuses.
       */
      mergedIntoId: null,
      createdAt: party.createdAt,
      updatedAt: party.updatedAt,
      ...ORGANISATION_MIRROR.derive(party),
      contacts: employees.map((row) => ({
        id: row.contactId,
        orgId,
        organizationId: employerLegacyId.get(partyId) ?? null,
        leadId: row.party.convertedFromPartyId
          ? (leadIds.get(row.party.convertedFromPartyId) ?? null)
          : null,
        // Null for the reason `contacts.service.ts` records: the only writer of
        // this column sets `deleted_at` in the same statement, and the query above
        // excludes deleted employees.
        mergedIntoId: null,
        createdAt: row.party.createdAt,
        updatedAt: row.party.updatedAt,
        ...CONTACT_MIRROR.derive(row.party),
      })),
    };
  }

  async exists(orgId: string, id: number): Promise<boolean> {
    return Boolean(await this.partyOf(orgId, id));
  }

  private async invalidateOrgCaches(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.crmOrganizationsListNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.crmOrganizationDetailNamespace(orgId)),
    ]);
  }

  async applyUpdate(orgId: string, id: number, input: OrganizationUpdateInput) {
    const updated = await updateMirroredOrganization(this.db, orgId, id, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.domain !== undefined && { domain: input.domain }),
      ...(input.industry !== undefined && { industry: input.industry }),
      ...(input.size !== undefined && { size: input.size }),
      ...(input.website !== undefined && { website: input.website }),
      ...(input.linkedinUrl !== undefined && { linkedinUrl: input.linkedinUrl }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.healthScore !== undefined && { healthScore: input.healthScore }),
      ...(input.parentId !== undefined && { parentId: input.parentId }),
      ...(input.notes !== undefined && { notes: input.notes }),
    });
    await this.invalidateOrgCaches(orgId);
    return updated;
  }

  async remove(orgId: string, id: number): Promise<boolean> {
    const [removed] = await softDeleteMirroredOrganizations(this.db, orgId, [id]);
    await this.invalidateOrgCaches(orgId);
    return Boolean(removed);
  }

}
