import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { supportAiSuggestions, supportCsatRequests, supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

export type AiReportFilters = { dateFrom?: Date; dateTo?: Date };

@Injectable()
export class SupportAiReportHelper {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getAiReport(orgId: string, filters: AiReportFilters) {
    const conds: SQL[] = [eq(supportAiSuggestions.orgId, orgId)];
    if (filters.dateFrom) conds.push(gte(supportAiSuggestions.createdAt, filters.dateFrom));
    if (filters.dateTo) conds.push(lte(supportAiSuggestions.createdAt, filters.dateTo));

    const [sStats] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        accepted: sql<number>`count(*) filter (where ${supportAiSuggestions.status} = 'accepted')::int`,
        rejected: sql<number>`count(*) filter (where ${supportAiSuggestions.status} = 'rejected')::int`,
        replyTotal: sql<number>`count(*) filter (where ${supportAiSuggestions.type} = 'reply')::int`,
        replyAccepted: sql<number>`count(*) filter (where ${supportAiSuggestions.type} = 'reply' and ${supportAiSuggestions.status} = 'accepted')::int`,
        escalatedCount: sql<number>`count(*) filter (where ${supportAiSuggestions.payload}->>'escalated' = 'true')::int`,
        withSources: sql<number>`count(*) filter (where jsonb_array_length(coalesce(${supportAiSuggestions.payload}->'sources', '[]'::jsonb)) > 0)::int`,
      })
      .from(supportAiSuggestions)
      .where(and(...conds));

    const ticketConds: SQL[] = [eq(supportTickets.orgId, orgId)];
    if (filters.dateFrom) ticketConds.push(gte(supportTickets.createdAt, filters.dateFrom));
    if (filters.dateTo) ticketConds.push(lte(supportTickets.createdAt, filters.dateTo));

    const [tStats] = await this.db
      .select({
        aiResolvedReopen: sql<number>`count(*) filter (where ${supportTickets.status} = 'OPEN')::int`,
        aiResolvedTotal: sql<number>`count(*)::int`,
      })
      .from(supportTickets)
      .innerJoin(
        supportAiSuggestions,
        and(
          eq(supportAiSuggestions.ticketId, supportTickets.id),
          eq(supportAiSuggestions.type, "reply"),
          eq(supportAiSuggestions.status, "accepted"),
        ),
      )
      .where(and(...ticketConds));

    const csatConds: SQL[] = [eq(supportCsatRequests.orgId, orgId)];
    if (filters.dateFrom) csatConds.push(gte(supportCsatRequests.createdAt, filters.dateFrom));
    if (filters.dateTo) csatConds.push(lte(supportCsatRequests.createdAt, filters.dateTo));

    const [csatAi] = await this.db
      .select({ avg: sql<number>`avg(${supportCsatRequests.score})::float8` })
      .from(supportCsatRequests)
      .innerJoin(
        supportAiSuggestions,
        and(
          eq(supportAiSuggestions.ticketId, supportCsatRequests.ticketId),
          eq(supportAiSuggestions.type, "reply"),
          eq(supportAiSuggestions.status, "accepted"),
        ),
      )
      .where(and(...csatConds));

    const [csatNonAi] = await this.db
      .select({ avg: sql<number>`avg(${supportCsatRequests.score})::float8` })
      .from(supportCsatRequests)
      .where(and(
        ...csatConds,
        sql`NOT EXISTS (SELECT 1 FROM ${supportAiSuggestions} s WHERE s.ticket_id = ${supportCsatRequests.ticketId} AND s.type = 'reply' AND s.status = 'accepted')`,
      ));

    const total = Number(sStats?.total ?? 0);
    const accepted = Number(sStats?.accepted ?? 0);
    const rejected = Number(sStats?.rejected ?? 0);
    const replyTotal = Number(sStats?.replyTotal ?? 0);
    const replyAccepted = Number(sStats?.replyAccepted ?? 0);
    const escalatedCount = Number(sStats?.escalatedCount ?? 0);
    const withSources = Number(sStats?.withSources ?? 0);
    const aiResolved = Number(tStats?.aiResolvedTotal ?? 0);
    const aiReopened = Number(tStats?.aiResolvedReopen ?? 0);
    const resolvedOrRejected = accepted + rejected;

    return {
      acceptanceRate: resolvedOrRejected > 0 ? accepted / resolvedOrRejected : 0,
      resolutionRate: aiResolved > 0 ? (aiResolved - aiReopened) / aiResolved : 0,
      reopenRate: aiResolved > 0 ? aiReopened / aiResolved : 0,
      escalationRate: replyTotal > 0 ? escalatedCount / replyTotal : 0,
      sourceCoverage: replyAccepted > 0 ? withSources / replyAccepted : 0,
      unsupportedRate: total > 0 ? escalatedCount / total : 0,
      csatImpact:
        csatAi?.avg !== null || csatNonAi?.avg !== null
          ? {
              aiResolved: csatAi?.avg !== null && csatAi?.avg !== undefined ? Number(csatAi.avg) : null,
              nonAiResolved: csatNonAi?.avg !== null && csatNonAi?.avg !== undefined ? Number(csatNonAi.avg) : null,
            }
          : null,
    };
  }
}
