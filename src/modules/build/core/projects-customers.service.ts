import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike, isNull, lt, or } from "drizzle-orm";
import { businessParties, crmOrgPartyMap } from "../../../db/schema/party";
import { PARTY_OF_CRM_ORG } from "../../crm/crm-party-reads";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { ListProjectCustomersInput } from "./dto/projects-customers.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";

/**
 * The companies a project can be run for.
 *
 * Reads parties rather than `crm_organizations` since ticket 25 converged the
 * two: `crm_org_party_map` supplies the integer id the picker stores, and every
 * value shown comes from the party that owns it. Build was one of the readers
 * outside CRM the ticket warned about, and it is the cheapest of them to move.
 *
 * Two things this read was getting wrong before the move, both of the shape the
 * phase keeps finding: it had no `deleted_at` filter, so a company somebody
 * deleted stayed in the picker forever; and it ordered by `created_at` alone,
 * which is not a total order, so page two could repeat or skip a company.
 */
@Injectable()
export class ProjectsCustomersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, params: ListProjectCustomersInput) {
    const limit = Math.min(params.limit, 100);
    const pos = decodeCursor(params.cursor);

    const conditions = [
      eq(crmOrgPartyMap.organizationId, orgId),
      eq(businessParties.organizationId, orgId),
      eq(businessParties.partyKind, "ORGANISATION"),
      isNull(businessParties.deletedAt),
      params.search ? ilike(businessParties.name, `%${params.search}%`) : undefined,
    ];

    if (pos) {
      const ts = new Date(pos.sortValue);
      const cursorId = Number(pos.id);
      const after = or(
        lt(businessParties.createdAt, ts),
        and(eq(businessParties.createdAt, ts), lt(crmOrgPartyMap.crmOrganizationId, cursorId)),
      );
      if (after) conditions.push(after);
    }

    const rows = await this.db
      .select({
        id: crmOrgPartyMap.crmOrganizationId,
        name: businessParties.name,
        domain: businessParties.domain,
        industry: businessParties.industry,
        size: businessParties.companySize,
        website: businessParties.website,
        linkedinUrl: businessParties.linkedinUrl,
        description: businessParties.description,
        createdAt: businessParties.createdAt,
      })
      .from(crmOrgPartyMap)
      .innerJoin(businessParties, PARTY_OF_CRM_ORG)
      .where(and(...conditions))
      .orderBy(desc(businessParties.createdAt), desc(crmOrgPartyMap.crmOrganizationId))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }
}
