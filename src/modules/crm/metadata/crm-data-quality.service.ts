import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { OFFENDER_LIMIT, type DataQualityAggregate } from "./lib/data-quality-shapes";
/*
 * Aliased on the way in. `getReport` destructures the results into consts named
 * for the report keys, and an un-aliased import would be shadowed by its own
 * result — tsc reports it as "referenced directly or indirectly in its own
 * initializer", which is the fourth time this shape has appeared in this branch.
 */
import {
  duplicateLeads as checkDuplicateLeads,
  leadsWithInvalidPhone as checkLeadsWithInvalidPhone,
  leadsWithNoOwner as checkLeadsWithNoOwner,
  leadsWithoutEmail as checkLeadsWithoutEmail,
} from "./lib/data-quality-leads";
import {
  dealsMissingStageFields as checkDealsMissingStageFields,
  dealsWithNoNextActivity as checkDealsWithNoNextActivity,
  staleDeals as checkStaleDeals,
} from "./lib/data-quality-deals";

export interface DataQualityReport {
  leadsWithoutEmail: DataQualityAggregate;
  leadsWithInvalidPhone: DataQualityAggregate;
  duplicateLeads: DataQualityAggregate;
  duplicateCompanies: DataQualityAggregate;
  staleDeals: DataQualityAggregate;
  dealsWithNoNextActivity: DataQualityAggregate;
  leadsWithNoOwner: DataQualityAggregate;
  dealsMissingStageFields: DataQualityAggregate;
}

@Injectable()
export class CrmDataQualityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getReport(orgId: string): Promise<DataQualityReport> {
    const [
      leadsWithoutEmail,
      leadsWithInvalidPhone,
      duplicateLeads,
      duplicateCompanies,
      staleDeals,
      dealsWithNoNextActivity,
      leadsWithNoOwner,
      dealsMissingStageFields,
    ] = await Promise.all([
      checkLeadsWithoutEmail(this.db, orgId),
      checkLeadsWithInvalidPhone(this.db, orgId),
      checkDuplicateLeads(this.db, orgId),
      this.duplicateCompanies(orgId),
      checkStaleDeals(this.db, orgId),
      checkDealsWithNoNextActivity(this.db, orgId),
      checkLeadsWithNoOwner(this.db, orgId),
      checkDealsMissingStageFields(this.db, orgId),
    ]);
    return {
      leadsWithoutEmail,
      leadsWithInvalidPhone,
      duplicateLeads,
      duplicateCompanies,
      staleDeals,
      dealsWithNoNextActivity,
      leadsWithNoOwner,
      dealsMissingStageFields,
    };
  }

  /**
   * Companies whose names collide once normalised.
   *
   * Reads Party, not `crm_organizations`. This was raw SQL against the legacy
   * table, invisible to both the reader ratchet and the lint rule -- each matches
   * a Drizzle symbol import, and a template string imports nothing. Ticket 08's
   * drop would have broken the data-quality scoreboard at runtime with nothing
   * having warned.
   *
   * `party_kind = 'ORGANISATION'` is the filter that replaces the table name.
   * Ticket 25 made a company a Party like any other, so without it this would
   * report every person whose name matches another person's as a duplicate
   * *company* -- and the queue's whole purpose is that a row in it is worth
   * acting on.
   *
   * The ids reported are still the integer ones, through `crm_org_party_map`,
   * because that is what the merge screen this feeds takes.
   */
  private async duplicateCompanies(orgId: string): Promise<DataQualityAggregate> {
    const dups = await this.db.execute(
      sql`
        SELECT lower(trim(p.name)) AS norm_name,
               string_agg(m.crm_organization_id::text, ',') AS ids,
               string_agg(p.name, ' | ') AS names
        FROM business_parties p
        JOIN crm_org_party_map m
          ON m.party_id = p.party_id
         AND m.organization_id = p.organization_id
        WHERE p.organization_id = ${orgId}
          AND p.party_kind = 'ORGANISATION'
          AND p.deleted_at IS NULL
        GROUP BY lower(trim(p.name))
        HAVING count(*) > 1
        LIMIT ${OFFENDER_LIMIT}
      `,
    );
    const offenders = (dups as Array<Record<string, unknown>>).map((r) => ({
      id: String(r["ids"] ?? ""),
      name: String(r["names"] ?? ""),
      detail: `Normalized: ${String(r["norm_name"] ?? "")}`,
    }));
    return { count: offenders.length, offenders };
  }

}
