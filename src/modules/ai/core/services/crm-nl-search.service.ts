import { Inject, Injectable } from "@nestjs/common";
import { and, desc, gte, ilike, inArray, lte } from "drizzle-orm";
import { users } from "../../../../db/schema";
import { businessParties, leadPartyMap } from "../../../../db/schema/party";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import {
  INCLUDE_DELETED,
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadPartyScope,
} from "../../../leads/lead-party-reader";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { NlSearchFilterSchema } from "../dto/output.schemas";
import type { NlSearchInput } from "../dto/request.schemas";
import { throwOnAiFailure } from "./gateway-result.util";

@Injectable()
export class CrmNlSearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async nlSearch(orgId: string, input: NlSearchInput, userId?: string) {
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "crm.nl-search",
      prompt: {
        system:
          "You are a CRM query parser. Convert natural language lead search queries into structured filter objects. " +
          "For Indian context: '1L' = 100000, '5L' = 500000, '10L' = 1000000, '1Cr' = 10000000, '2Cr' = 20000000. " +
          "Status values must be uppercase: NEW, CONTACTED, INTERESTED, QUALIFIED, CONVERTED, LOST. " +
          "Priority values must be uppercase: HOT, WARM, COLD. " +
          "Source values: referral, campaign, cold_call, website, social_media, walk_in, other. " +
          "Extract city, company, name, and assignedToName from the query when mentioned. " +
          "Only populate fields that are clearly mentioned in the query.",
        user: input.query,
      },
      schema: NlSearchFilterSchema,
      tier: "fast",
      maxTokens: 512,
      charge: true,
    });

    if (!result.ok) throwOnAiFailure(result);
    const parsedFilters = result.data;

    const leadsResult = await runInTenantTransaction(this.db, async (tx) => {
      const conditions = [...leadPartyScope(orgId, INCLUDE_DELETED)];
      if (parsedFilters.status?.length)
        conditions.push(inArray(LEAD_PARTY_COLUMNS.status, parsedFilters.status));
      if (parsedFilters.priority?.length)
        conditions.push(inArray(LEAD_PARTY_COLUMNS.priority, parsedFilters.priority));
      if (parsedFilters.source)
        conditions.push(ilike(LEAD_PARTY_COLUMNS.source, `%${parsedFilters.source}%`));
      if (parsedFilters.city) conditions.push(ilike(LEAD_PARTY_COLUMNS.city, `%${parsedFilters.city}%`));
      if (parsedFilters.company)
        conditions.push(ilike(LEAD_PARTY_COLUMNS.company, `%${parsedFilters.company}%`));
      if (parsedFilters.nameSearch)
        conditions.push(ilike(LEAD_PARTY_COLUMNS.name, `%${parsedFilters.nameSearch}%`));
      if (parsedFilters.minValue !== undefined)
        conditions.push(gte(LEAD_PARTY_COLUMNS.potentialValue, String(parsedFilters.minValue)));
      if (parsedFilters.maxValue !== undefined)
        conditions.push(lte(LEAD_PARTY_COLUMNS.potentialValue, String(parsedFilters.maxValue)));

      const rows = await tx
        .select({
          id: LEAD_PARTY_COLUMNS.id,
          name: LEAD_PARTY_COLUMNS.name,
          email: LEAD_PARTY_COLUMNS.email,
          company: LEAD_PARTY_COLUMNS.company,
          status: LEAD_PARTY_COLUMNS.status,
          priority: LEAD_PARTY_COLUMNS.priority,
          source: LEAD_PARTY_COLUMNS.source,
          value: LEAD_PARTY_COLUMNS.potentialValue,
          city: LEAD_PARTY_COLUMNS.city,
          assignedToId: LEAD_PARTY_COLUMNS.assignedToId,
          assigneeName: users.name,
          assigneeFirstName: users.firstName,
          assigneeLastName: users.lastName,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, LEAD_PARTY_JOIN)
        .leftJoin(users, eq(LEAD_PARTY_COLUMNS.assignedToId, users.id))
        .where(and(...conditions))
        .orderBy(desc(LEAD_PARTY_COLUMNS.createdAt), desc(LEAD_PARTY_COLUMNS.id))
        .limit(50);

      let filteredRows = rows;
      if (parsedFilters.assignedToName) {
        const search = parsedFilters.assignedToName.toLowerCase();
        filteredRows = rows.filter((r) => {
          const fullName =
            `${r.assigneeFirstName ?? ""} ${r.assigneeLastName ?? ""}`.trim() || r.assigneeName || "";
          return fullName.toLowerCase().includes(search);
        });
      }

      return filteredRows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        company: r.company,
        status: r.status,
        priority: r.priority,
        source: r.source,
        value: r.value !== null ? Number(r.value) : null,
        city: r.city,
        assignedTo:
          `${r.assigneeFirstName ?? ""} ${r.assigneeLastName ?? ""}`.trim() || r.assigneeName || null,
      }));
    }, { orgId });

    return { query: input.query, parsedFilters, leads: leadsResult, total: leadsResult.length };
  }
}
