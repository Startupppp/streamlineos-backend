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
  isNull,
  type SQL,
} from "drizzle-orm";
import { leads, leadActivities } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import {
  LeadsBoardService,
  type BoardOpts,
  type StatsFilters,
} from "./leads-board.service";
import type { ListInput } from "./dto/lead.schemas";

export type ListFilters = ListInput & { userId?: string; scope?: DataScope };

const COMPANY_SEARCH_CAP = 500;

function pushLeadsViewScope(
  where: SQL[],
  orgId: string,
  scope: DataScope | undefined,
  userId: string | undefined,
): void {
  if (!scope) return;
  if (scope === "none") {
    where.push(sql`false`);
    return;
  }
  if (!userId) return;
  where.push(applyScope(scope, orgId, userId, { ownerColumn: leads.assignedToId }));
}

@Injectable()
export class LeadsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly boardService: LeadsBoardService,
  ) {}

  /**
   * `textlike` is not leakproof, so under RLS a plain ILIKE on company cannot use
   * `idx_leads_company_trgm`; the SECURITY DEFINER function returns ids the outer
   * query then filters under RLS as usual. Over the cap the id list stops paying
   * for itself and plain ILIKE is cheaper.
   */
  private async companySearchCondition(term: string, like: string): Promise<SQL> {
    const rows = await this.db.execute(
      sql`SELECT app.search_lead_ids_by_company(${term}, ${COMPANY_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length > COMPANY_SEARCH_CAP) return sql`${leads.company} ILIKE ${like}`;
    if (rows.length === 0) return sql`false`;
    return inArray(
      leads.id,
      rows.map((row) => Number(row["id"])),
    );
  }

  async listLeads(orgId: string, filters?: ListFilters) {
    const where = [eq(leads.orgId, orgId), isNull(leads.deletedAt)];

    pushLeadsViewScope(where, orgId, filters?.scope, filters?.userId);
    if (filters?.status) where.push(eq(leads.status, filters.status));
    if (filters?.priority) where.push(eq(leads.priority, filters.priority));
    if (filters?.source) where.push(eq(leads.source, filters.source));
    if (filters?.assignedToId) where.push(eq(leads.assignedToId, filters.assignedToId));
    if (filters?.dateFrom) where.push(gte(leads.createdAt, new Date(filters.dateFrom)));
    if (filters?.dateTo) where.push(lte(leads.createdAt, new Date(filters.dateTo)));
    if (filters?.search) {
      const like = `%${filters.search}%`;
      const companyCondition = await this.companySearchCondition(filters.search, like);
      const combined = or(
        sql`${leads.name} ILIKE ${like}`,
        sql`${leads.email} ILIKE ${like}`,
        sql`${leads.phone} ILIKE ${like}`,
        companyCondition,
      );
      if (combined) where.push(combined);
    }

    const colMap = {
      name: leads.name,
      email: leads.email,
      company: leads.company,
      status: leads.status,
      priority: leads.priority,
      source: leads.source,
      score: leads.score,
      potentialValue: leads.potentialValue,
      createdAt: leads.createdAt,
    } as const;

    const sortBy = filters?.sortBy ?? "createdAt";
    const sortOrder = filters?.sortOrder ?? "desc";
    const orderCol = colMap[sortBy as keyof typeof colMap] ?? leads.createdAt;
    const orderFn = sortOrder === "asc" ? asc(orderCol) : desc(orderCol);

    const page = filters?.page ?? 1;
    const limit = filters?.limit ?? 50;
    const offset = (page - 1) * limit;
    const whereClause = and(...where);

    const [allLeads, totalResult] = await Promise.all([
      this.db.query.leads.findMany({
        where: whereClause,
        with: {
          assignedTo: { columns: { id: true, name: true, image: true } },
          campaign: { columns: { id: true, name: true } },
        },
        orderBy: [orderFn],
        limit,
        offset,
      }),
      this.db.select({ count: count() }).from(leads).where(whereClause),
    ]);

    const totalCount = totalResult[0]?.count ?? 0;
    return {
      leads: allLeads,
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

  async getLead(orgId: string, id: number) {
    return this.db.query.leads.findFirst({
      where: and(eq(leads.id, id), eq(leads.orgId, orgId), isNull(leads.deletedAt)),
      with: {
        assignedTo: { columns: { id: true, name: true, image: true, email: true } },
        assignedBy: { columns: { id: true, name: true } },
        campaign: { columns: { id: true, name: true } },
        activities: {
          with: { user: { columns: { id: true, name: true, image: true } } },
          orderBy: [desc(leadActivities.date)],
          limit: 50,
        },
      },
    });
  }
}
