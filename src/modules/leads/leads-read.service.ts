import { Inject, Injectable } from "@nestjs/common";
import {
  eq,
  and,
  desc,
  asc,
  count,
  gte,
  lte,
  or,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBefore, keysetAfter } from "../../common/pagination/keyset";
import { leadActivities, users, crmCampaigns } from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { ScopedRead } from "../access/scoped-read";
import {
  LEAD_PARTY_COLUMNS,
  LEAD_PARTY_JOIN,
  leadIdIs,
  leadPartyScope,
  LEAD_PARTY_SCOPE,
} from "./lead-party-reader";
import {
  LeadsBoardService,
  type BoardOpts,
  type StatsFilters,
} from "./leads-board.service";
import type { ListInput } from "./dto/lead.schemas";

export type ListFilters = ListInput & { read: ScopedRead };

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

  async listLeads(orgId: string, filters: ListFilters) {
    const read = filters.read;
    const domain: (SQL | undefined)[] = [
      eq(leadPartyMap.organizationId, orgId),
      isNull(businessParties.deletedAt),
      filters.status ? eq(LEAD_PARTY_COLUMNS.status, filters.status) : undefined,
      filters.priority ? eq(LEAD_PARTY_COLUMNS.priority, filters.priority) : undefined,
      filters.source ? eq(LEAD_PARTY_COLUMNS.source, filters.source) : undefined,
      filters.assignedToId ? eq(LEAD_PARTY_COLUMNS.assignedToId, filters.assignedToId) : undefined,
      filters.dateFrom ? gte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateFrom)) : undefined,
      filters.dateTo ? lte(LEAD_PARTY_COLUMNS.createdAt, new Date(filters.dateTo)) : undefined,
    ];
    if (filters.search) {
      const like = `%${filters.search}%`;
      const companyCondition = await this.companySearchCondition(filters.search, like);
      domain.push(
        or(
          sql`${LEAD_PARTY_COLUMNS.name} ILIKE ${like}`,
          sql`${LEAD_PARTY_COLUMNS.email} ILIKE ${like}`,
          sql`${LEAD_PARTY_COLUMNS.phone} ILIKE ${like}`,
          companyCondition,
        ),
      );
    }

    const sortBy = filters.sortBy ?? "createdAt";
    const sortOrder = filters.sortOrder ?? "desc";
    const limit = filters.limit ?? 50;
    const position = decodeCursor(filters.cursor);

    const colMap = {
      name: LEAD_PARTY_COLUMNS.name,
      email: LEAD_PARTY_COLUMNS.email,
      company: LEAD_PARTY_COLUMNS.company,
      score: LEAD_PARTY_COLUMNS.score,
      potentialValue: LEAD_PARTY_COLUMNS.potentialValue,
      createdAt: LEAD_PARTY_COLUMNS.createdAt,
    } as const;

    const sortableCol = sortBy in colMap ? colMap[sortBy as keyof typeof colMap] : LEAD_PARTY_COLUMNS.createdAt;
    const isTimestampSort = sortBy === "createdAt";
    const idCol = LEAD_PARTY_COLUMNS.id;

    const keysetCond = position
      ? isTimestampSort
        ? sortOrder === "desc"
          ? keysetBefore(businessParties.createdAt, leadPartyMap.leadId, position)
          : keysetAfter(businessParties.createdAt, leadPartyMap.leadId, position)
        : sortOrder === "desc"
          ? sql`(${sortableCol}, ${idCol}) < (${sql.param(position.sortValue, businessParties.createdAt)}, ${sql.param(position.id, idCol)})`
          : sql`(${sortableCol}, ${idCol}) > (${sql.param(position.sortValue, businessParties.createdAt)}, ${sql.param(position.id, idCol)})`
      : undefined;

    const orderFn = sortOrder === "asc" ? asc(sortableCol) : desc(sortableCol);
    const spec = { tenant: businessParties.organizationId, scope: LEAD_PARTY_SCOPE };
    const whereClause = read.compose(
      { ...spec, and: [...domain, keysetCond] },
      (clause) => clause.sql,
      () => null,
    );
    const baseWhereClause = read.compose(
      { ...spec, and: domain },
      (clause) => clause.sql,
      () => null,
    );
    if (whereClause === null || baseWhereClause === null)
      return { leads: [], totalCount: 0, hasMore: false, nextCursor: null };

    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          lead: LEAD_PARTY_COLUMNS,
          assigneeId: users.id,
          assigneeName: users.name,
          assigneeImage: users.image,
          campaignId: crmCampaigns.id,
          campaignName: crmCampaigns.name,
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
        .orderBy(orderFn, desc(idCol))
        .limit(limit + 1),
      filters.cursor === undefined
        ? this.db
            .select({ c: count() })
            .from(leadPartyMap)
            .innerJoin(businessParties, LEAD_PARTY_JOIN)
            .where(baseWhereClause)
        : Promise.resolve(null),
    ]);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: isTimestampSort ? row.lead.createdAt.toISOString() : String(row.lead.createdAt),
      id: String(row.lead.id),
    }));
    const totalCount = countResult ? Number(countResult[0]?.c ?? 0) : undefined;

    return {
      leads: page.data.map((row) => ({
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
      hasMore: page.pagination.hasMore,
      nextCursor: page.pagination.nextCursor,
    };
  }

  async getBoard(orgId: string, opts: BoardOpts) {
    return this.boardService.getBoard(orgId, opts);
  }

  async getStats(orgId: string, filters: StatsFilters) {
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
