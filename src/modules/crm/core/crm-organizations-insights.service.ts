import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { deals } from "../../../db/schema";
import { businessParties, leadPartyMap } from "../../../db/schema/party";
import { PARTY_OF_LEAD } from "../crm-party-reads";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import {
  companies,
  getAccountHierarchy,
  getAllDescendantIds,
  wouldCreateCycle,
  type CrmOrgHierarchyDeps,
  type OrgHierarchyNode,
} from "./lib/crm-org-hierarchy";
import {
  getRelatedLeads,
  queryAccountTimeline,
  type OrgTimelineEvent,
} from "./lib/crm-org-records";

export type { OrgHierarchyNode, OrgTimelineEvent };

export interface OrgRollup {
  totalContacts: number;
  totalDeals: number;
  openDeals: number;
  totalDealValue: number;
  totalLeads: number;
}

/**
 * What an account looks like from above: its group, its totals, its history.
 *
 * Split from `CrmOrganizationsService` when ticket 25 moved the record itself
 * onto Party. These are read-only aggregates over a company, and the half that
 * used to still speak `crm_organizations`: the account hierarchy lived in
 * `parent_id`, which ticket 25 deliberately did not absorb.
 *
 * 0265 absorbed it, as `parent_party_id` — a second link of the same shape as
 * `employer_party_id` rather than a second meaning for it, because a subsidiary's
 * parent is not its employer. The two recursive walks that descend
 * `business_parties` are in `lib/crm-org-hierarchy.ts`, together with the map
 * join that answers in the integer ids every URL still holds. Nothing anywhere
 * here reads a legacy table.
 *
 * What is left is the ROLLUP — the counts. `lib/crm-org-records.ts` returns the
 * rows behind the same joins, and that is the split: a count of five deals is
 * cheap and cacheable at any size, and a list of them is not, which is why every
 * function there carries a limit and this one does not.
 *
 * "Who works here" is `employer_party_id` rather than `contacts.organization_id`,
 * which is the relation ticket 25 exists to create.
 */
@Injectable()
export class CrmOrganizationsInsightsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private get orgDeps(): CrmOrgHierarchyDeps {
    return { db: this.db };
  }

  /** The write-time guard on `parent_party_id`; see `lib/crm-org-hierarchy.ts`. */
  wouldCreateCycle(orgId: string, accountId: number, candidateParentId: number): Promise<boolean> {
    return wouldCreateCycle(this.orgDeps, orgId, accountId, candidateParentId);
  }

  getAccountHierarchy(orgId: string, accountId: number): Promise<OrgHierarchyNode | null> {
    return getAccountHierarchy(this.orgDeps, orgId, accountId);
  }

  getAccountRollup(orgId: string, accountId: number): Promise<OrgRollup> {
    return this.cache.cachedVersioned(
      CACHE_KEYS.crmOrganizationDetailNamespace(orgId),
      `rollup:${accountId}`,
      () => this.queryAccountRollup(orgId, accountId),
      CACHE_TTL.SHORT,
    );
  }

  private async queryAccountRollup(orgId: string, accountId: number): Promise<OrgRollup> {
    const ids = await getAllDescendantIds(this.orgDeps, orgId, accountId);
    const rows = await companies(this.orgDeps, orgId, ids);
    const partyIds = rows.map((row) => row.partyId);
    const orgNames = rows.map((row) => row.name);

    // Everyone whose employer is one of these companies. `employer_party_id`
    // rather than `contacts.organization_id`: the count is over people, and a
    // person is a party whether or not `contacts` still holds a row for them.
    const [contactCount] = partyIds.length
      ? await this.db
          .select({ count: count() })
          .from(businessParties)
          .where(
            and(
              eq(businessParties.organizationId, orgId),
              inArray(businessParties.employerPartyId, partyIds),
              isNull(businessParties.deletedAt),
            ),
          )
      : [];

    let totalDeals = 0;
    let openDeals = 0;
    let totalDealValue = 0;

    if (orgNames.length > 0) {
      const dealAgg = await this.db
        .select({
          totalDeals: count(),
          openDeals: sql<number>`COUNT(*) FILTER (WHERE ${deals.stage} NOT IN ('CLOSED_WON', 'CLOSED_LOST'))::int`,
          totalDealValue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
        })
        .from(deals)
        .where(
          and(
            eq(deals.orgId, orgId),
            isNull(deals.deletedAt),
            or(...orgNames.map((n) => ilike(deals.name, `%${n.replaceAll("%", "\\%")}%`))),
          ),
        );

      totalDeals = Number(dealAgg[0]?.totalDeals ?? 0);
      openDeals = Number(dealAgg[0]?.openDeals ?? 0);
      totalDealValue = Number(dealAgg[0]?.totalDealValue ?? 0);
    }

    const [leadCount] = await this.db
      .select({ count: count() })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .where(
        and(
          eq(leadPartyMap.organizationId, orgId),
          isNull(businessParties.deletedAt),
          orgNames.length > 0
            ? or(
                ...orgNames.map((n) =>
                  ilike(businessParties.companyName, `%${n.replaceAll("%", "\\%")}%`),
                ),
              )
            : sql`false`,
        ),
      );

    return {
      totalContacts: Number(contactCount?.count ?? 0),
      totalDeals,
      openDeals,
      totalDealValue,
      totalLeads: Number(leadCount?.count ?? 0),
    };
  }

  getAccountTimeline(orgId: string, accountId: number, limit = 20): Promise<OrgTimelineEvent[]> {
    return this.cache.cachedVersioned(
      CACHE_KEYS.crmOrganizationDetailNamespace(orgId),
      `timeline:${accountId}:${limit}`,
      () => queryAccountTimeline(this.orgDeps, orgId, accountId, limit),
      CACHE_TTL.SHORT,
    );
  }

  /** The rows, not the counts; see `lib/crm-org-records.ts`. */
  getRelatedLeads(orgId: string, id: number) {
    return getRelatedLeads(this.orgDeps, orgId, id);
  }
}
