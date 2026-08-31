import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { workflows, workflowExecutions, workflowApprovals } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

@Injectable()
export class WorkflowsAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getAnalytics(orgId: string) {
    const [[workflowStats], [executionStats], [pendingApprovalCount]] =
      await Promise.all([
        this.db
          .select({
            total: count(),
            active: sql<number>`sum(case when ${workflows.status} = 'published' then 1 else 0 end)::int`,
          })
          .from(workflows)
          .where(eq(workflows.orgId, orgId)),
        this.db
          .select({
            total: count(),
            completed: sql<number>`sum(case when ${workflowExecutions.status} = 'completed' then 1 else 0 end)::int`,
            avgDuration: sql<number>`avg(${workflowExecutions.durationMs})::int`,
          })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.orgId, orgId)),
        this.db
          .select({ total: count() })
          .from(workflowApprovals)
          .innerJoin(
            workflowExecutions,
            eq(workflowApprovals.executionId, workflowExecutions.id),
          )
          .where(
            and(
              eq(workflowExecutions.orgId, orgId),
              eq(workflowApprovals.status, "pending"),
            ),
          ),
      ]);

    const totalExecutions = executionStats?.total ?? 0;
    const completedExecutions = executionStats?.completed ?? 0;
    const successRate =
      totalExecutions > 0
        ? Math.round((completedExecutions / totalExecutions) * 100)
        : 0;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const trendRows = await this.db
      .select({
        date: sql<string>`date_trunc('day', ${workflowExecutions.createdAt})::text`,
        count: sql<number>`count(*)::int`,
        successCount: sql<number>`sum(case when ${workflowExecutions.status} = 'completed' then 1 else 0 end)::int`,
      })
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.orgId, orgId),
          gte(workflowExecutions.createdAt, thirtyDaysAgo),
        ),
      )
      .groupBy(sql`date_trunc('day', ${workflowExecutions.createdAt})`)
      .orderBy(sql`date_trunc('day', ${workflowExecutions.createdAt})`);

    return {
      totalWorkflows: workflowStats?.total ?? 0,
      activeWorkflows: workflowStats?.active ?? 0,
      totalExecutions,
      successRate,
      avgDuration: executionStats?.avgDuration ?? 0,
      pendingApprovals: pendingApprovalCount?.total ?? 0,
      executionTrend: trendRows,
    };
  }
}
