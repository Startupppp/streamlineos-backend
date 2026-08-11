import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, isNull, lt, ne, sum } from "drizzle-orm";
import {
  crmActivities,
  deals,
  jobPostings,
  leads,
  organizationMembers,
  projects,
  users,
} from "../../db/schema";
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
          this.db
            .select({ cnt: count() })
            .from(leads)
            .where(
              and(eq(leads.orgId, orgId), gte(leads.createdAt, weekStart)),
            ),
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
          this.db
            .select({ cnt: count() })
            .from(leads)
            .where(eq(leads.orgId, orgId)),
          this.db
            .select({ cnt: count() })
            .from(leads)
            .where(and(eq(leads.orgId, orgId), eq(leads.status, "CONVERTED"))),
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
