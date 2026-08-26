import { Inject, Injectable } from "@nestjs/common";
import {
  eq,
  and,
  desc,
  asc,
  sql,
  count,
  gte,
  lte,
  or,
  inArray,
  type SQL,
} from "drizzle-orm";
import { leadActivities, users, crmCampaigns } from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { DataScope } from "../access/access.types";
import {
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadIdIs,
  leadPartyScope,
  pushLeadPartyViewScope,
} from "./lead-party-reader";
import {
  LeadsBoardService,
  type BoardOpts,
  type StatsFilters,
} from "./leads-board.service";
import type { ListInput } from "./dto/lead.schemas";

export type ListFilters = ListInput & { userId?: string; scope?: DataScope };

const COMPANY_SEARCH_CAP = 500;

@Injectable()
export class LeadsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly boardService: LeadsBoardService,
  ) {}

  /**
   * `textlike` is not leakproof, so under RLS a plain ILIKE on the company name
   * cannot use `idx_business_parties_company_trgm`; the SECURITY DEFINER function
   * returns party ids the outer query then filters under RLS as usual. Over the
   * cap the id list stops paying for itself and plain ILIKE is cheaper.
   *
   * Party ids, not lead ids: 0275 replaced `search_lead_ids_by_company` for the
   * same reason this module stopped selecting from `leads` at all — the table it
   * searched is the one ticket 08 drops.
   */
  private async companySearchCondition(term: string, like: string): Promise<SQL> {
    const rows = await this.db.execute(
      sql`SELECT app.search_party_ids_by_company(${term}, ${COMPANY_SEARCH_CAP + 1}) AS party_id`,
    );
    if (rows.length > COMPANY_SEARCH_CAP) return sql`${businessParties.companyName} ILIKE ${like}`;
    if (rows.length === 0) return sql`false`;
    return inArray(
      businessParties.partyId,
      rows.map((row) => String(row["party_id"])),
    );
  }

  async listLeads(orgId: string, filters?: ListFilters) {
    const where = leadPartyScope(orgId);

    pushLeadPartyViewScope(where, orgId, filters?.scope, filters?.userId);
    if (filters?.status) where.push(eq(LEAD_PARTY_COLUMNS.status, filters.status));
    if (filters?.priority) where.push(eq(LEAD_PARTY_COLUMNS.priority, filters.priority));
    if (filters?.source) where.push(eq(LEAD_PARTY_COLUMNS.source, filters.source));
    if (filters?.assignedToId)
      where.push(eq(LEAD_PARTY_COLUMNS.assignedToId, filters.assignedToId));
    if (filters?.dateFrom)
      where.push(gte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateFrom)));
    if (filters?.dateTo) where.push(lte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateTo)));
    if (filters?.search) {
      const like = `%${filters.search}%`;
      const companyCondition = await this.companySearchCondition(filters.search, like);
      const combined = or(
        sql`${LEAD_PARTY_COLUMNS.name} ILIKE ${like}`,
        sql`${LEAD_PARTY_COLUMNS.email} ILIKE ${like}`,
        sql`${LEAD_PARTY_COLUMNS.phone} ILIKE ${like}`,
        companyCondition,
      );
      if (combined) where.push(combined);
    }

    const colMap = {
      name: LEAD_PARTY_COLUMNS.name,
      email: LEAD_PARTY_COLUMNS.email,
      company: LEAD_PARTY_COLUMNS.company,
      status: LEAD_PARTY_COLUMNS.status,
      priority: LEAD_PARTY_COLUMNS.priority,
      source: LEAD_PARTY_COLUMNS.source,
      score: LEAD_PARTY_COLUMNS.score,
      potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
      createdAt: LEAD_PARTY_COLUMNS.createdAt,
    } as const;

    const sortBy = filters?.sortBy ?? "createdAt";
    const sortOrder = filters?.sortOrder ?? "desc";
    const orderCol = colMap[sortBy as keyof typeof colMap] ?? LEAD_PARTY_COLUMNS.createdAt;
    const orderFn = sortOrder === "asc" ? asc(orderCol) : desc(orderCol);

    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 50;
    const offset = (page - 1) * limit;
    const whereClause = and(...where);

    const rows = await this.db
      .select({
        lead: LEAD_PARTY_COLUMNS,
        assigneeId: users.id,
        assigneeName: users.name,
        assigneeImage: users.image,
        campaignId: crmCampaigns.id,
        campaignName: crmCampaigns.name,
        _total: sql<string>`count(*) OVER ()`,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, LEAD_PARTY_JOIN)
      .leftJoin(users, eq(LEAD_PARTY_COLUMNS.assignedToId, users.id))
      .leftJoin(
        crmCampaigns,
        and(
          eq(crmCampaigns.id, LEAD_PARTY_COLUMNS.campaignId),
          eq(crmCampaigns.orgId, orgId),
        ),
      )
      .where(whereClause)
      .orderBy(orderFn, desc(LEAD_PARTY_COLUMNS.id))
      .limit(limit)
      .offset(offset);

    const first = rows[0];
    const totalCount = first
      ? Number(first._total)
      : offset === 0
      ? 0
      : await this.db
          .select({ c: count() })
          .from(leadPartyMap)
          .innerJoin(businessParties, LEAD_PARTY_JOIN)
          .where(whereClause)
          .then((r) => Number(r[0]?.c ?? 0));

    return {
      leads: rows.map(({ _total, ...row }) => ({
        ...row.lead,
        assignedTo: row.assigneeId
          ? { id: row.assigneeId, name: row.assigneeName, image: row.assigneeImage }
          : null,
        campaign:
          row.campaignId !== null && row.campaignName !== null
            ? { id: row.campaignId, name: row.campaignName }
            : null,
      })),
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
    };
  }

  async getBoard(orgId: string, opts?: BoardOpts) {
    return this.boardService.getBoard(orgId, opts);
  }

  async getStats(orgId: string, filters?: StatsFilters) {
    return this.boardService.getStats(orgId, filters);
  }

  /**
   * The assignee and the assigner, in one lookup.
   *
   * A second join onto `users` would need an alias; two ids and an `IN` is the
   * same round trip and reads as what it is.
   */
  private async peopleOn(
    assignedToId: string | null,
    assignedById: string | null,
  ): Promise<Map<string, { id: string; name: string | null; image: string | null; email: string | null }>> {
    const ids = [...new Set([assignedToId, assignedById].filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, name: users.name, image: users.image, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(rows.map((row) => [row.id, row]));
  }

  async getLead(orgId: string, id: number) {
    const [row] = await this.db
      .select({
        lead: LEAD_PARTY_COLUMNS,
        campaignId: crmCampaigns.id,
        campaignName: crmCampaigns.name,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, LEAD_PARTY_JOIN)
      .leftJoin(
        crmCampaigns,
        and(eq(crmCampaigns.id, LEAD_PARTY_COLUMNS.campaignId), eq(crmCampaigns.orgId, orgId)),
      )
      .where(and(...leadPartyScope(orgId), leadIdIs(id)))
      .limit(1);

    if (!row) return undefined;

    const [people, activities] = await Promise.all([
      this.peopleOn(row.lead.assignedToId, row.lead.assignedById),
      this.db.query.leadActivities.findMany({
        // Scoped by organisation as well as by lead: the relation this replaces
        // reached the activities through the lead's own row and never said so.
        where: and(eq(leadActivities.leadId, id), eq(leadActivities.orgId, orgId)),
        with: { user: { columns: { id: true, name: true, image: true } } },
        orderBy: [desc(leadActivities.date)],
        limit: 50,
      }),
    ]);

    const assignee = row.lead.assignedToId ? people.get(row.lead.assignedToId) : undefined;
    const assigner = row.lead.assignedById ? people.get(row.lead.assignedById) : undefined;

    return {
      ...row.lead,
      assignedTo: assignee
        ? { id: assignee.id, name: assignee.name, image: assignee.image, email: assignee.email }
        : null,
      assignedBy: assigner ? { id: assigner.id, name: assigner.name } : null,
      campaign:
        row.campaignId !== null && row.campaignName !== null
          ? { id: row.campaignId, name: row.campaignName }
          : null,
      activities,
    };
  }
}
