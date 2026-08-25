import { Inject, Injectable } from "@nestjs/common";
import { and, count, countDistinct, eq, gte, isNull, lt, ne, sum, type SQL } from "drizzle-orm";
import {
  crmActivities,
  deals,
  jobPostings,
  organizationMembers,
  projects,
  users,
} from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { PARTY_OF_LEAD, leadStatus } from "../crm/crm-party-reads";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";

@Injectable()
export class DashboardCrmService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  /**
   * How many customers this organisation holds a lead record for.
   *
   * Distinct parties, not map rows, and that is the whole point of moving this
   * read. A merge re-points the losing record's `lead_party_map` row onto the
   * survivor and then refreshes every mapped legacy row from it, so two `leads`
   * rows are left alive holding the same person's name and the loser's Party is
   * the only thing marked deleted. `count(*) FROM leads` therefore counted that
   * customer twice — on the total, on the conversion rate's denominator, and on
   * the week's new leads. Counting the Party counts the customer.
   *
   * Deleted parties are excluded, which `count(*) FROM leads` never did either:
   * the legacy reads here carried no `deleted_at` predicate at all, so a deleted
   * lead still moved the executive dashboard.
   */
  private countLeadParties(orgId: string, ...conditions: SQL[]) {
    return this.db
      .select({ cnt: countDistinct(businessParties.partyId) })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .where(
        and(
          eq(leadPartyMap.organizationId, orgId),
          eq(businessParties.organizationId, orgId),
          isNull(businessParties.deletedAt),
          ...conditions,
        ),
      );
  }

  async getTodayActivities(orgId: string) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);

    const activities = await this.db.query.crmActivities.findMany({
      where: and(
        eq(crmActivities.orgId, orgId),
        gte(crmActivities.createdAt, todayStart),
        lt(crmActivities.createdAt, tomorrowStart),
      ),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
      limit: 20,
    });
    return activities.map((a) => ({ type: a.type, subject: a.message }));
  }

  getExecutiveDashboard(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.executiveDashboard(orgId),
      async () => {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - 7);

        const [
          mrrRows,
          pipelineRows,
          headcountRows,
          openRolesRows,
          newLeadsRows,
          activeProjectsRows,
          totalLeadsRows,
          wonLeadsRows,
        ] = await Promise.all([
          this.db
            .select({ total: sum(deals.value) })
            .from(deals)
            .where(
              and(
                eq(deals.orgId, orgId), isNull(deals.deletedAt),
                eq(deals.stage, "WON"),
                gte(deals.updatedAt, monthStart),
              ),
            ),
          this.db
            .select({ total: sum(deals.value) })
            .from(deals)
            .where(
              and(
                eq(deals.orgId, orgId), isNull(deals.deletedAt),
                ne(deals.stage, "WON"),
                ne(deals.stage, "LOST"),
              ),
            ),
          this.db
            .select({ cnt: count() })
            .from(organizationMembers)
            .innerJoin(users, eq(organizationMembers.userId, users.id))
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(users.isActive, true),
              ),
            ),
          this.db
            .select({ cnt: count() })
            .from(jobPostings)
            .where(
              and(eq(jobPostings.orgId, orgId), eq(jobPostings.status, "OPEN")),
            ),
          this.countLeadParties(orgId, gte(businessParties.createdAt, weekStart)),
          this.db
            .select({ cnt: count() })
            .from(projects)
            .where(
              and(
                eq(projects.orgId, orgId),
                eq(projects.status, "ACTIVE"),
                isNull(projects.deletedAt),
              ),
            ),
          this.countLeadParties(orgId),
          this.countLeadParties(orgId, eq(leadStatus, "CONVERTED")),
        ]);

        const total = Number(totalLeadsRows[0]?.cnt ?? 0);
        const won = Number(wonLeadsRows[0]?.cnt ?? 0);

        return {
          mrr: Number(mrrRows[0]?.total ?? 0),
          pipelineValue: Number(pipelineRows[0]?.total ?? 0),
          headcount: Number(headcountRows[0]?.cnt ?? 0),
          openRoles: Number(openRolesRows[0]?.cnt ?? 0),
          newLeadsThisWeek: Number(newLeadsRows[0]?.cnt ?? 0),
          activeProjects: Number(activeProjectsRows[0]?.cnt ?? 0),
          conversionRate: total > 0 ? Math.round((won / total) * 100) : 0,
        };
      },
      CACHE_TTL.MEDIUM,
    );
  }
}
