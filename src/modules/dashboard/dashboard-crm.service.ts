import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, inArray, lt, ne, sql, sum } from "drizzle-orm";
import {
  branches,
  clientAccounts,
  crmActivities,
  deals,
  expenses,
  jobPostings,
  leads,
  organizationMembers,
  projects,
  timesheets,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { type DashboardActor, type DashboardForbidden } from "./dashboard.errors";

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

  async getExecutiveDashboard(orgId: string, actor: DashboardActor) {
    if (!actor.isOrgOwner && !actor.isPlatformAdmin && !actor.permissions.includes("hr:analytics:read")) {
      return { error: "forbidden", message: "Forbidden" } as DashboardForbidden;
    }

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
                eq(deals.orgId, orgId),
                eq(deals.stage, "WON"),
                gte(deals.updatedAt, monthStart),
              ),
            ),
          this.db
            .select({ total: sum(deals.value) })
            .from(deals)
            .where(
              and(
                eq(deals.orgId, orgId),
                ne(deals.stage, "WON"),
                ne(deals.stage, "LOST"),
              ),
            ),
          this.db
            .select({ cnt: count() })
            .from(organizationMembers)
            .innerJoin(users, eq(organizationMembers.userId, users.id))
            .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),
          this.db
            .select({ cnt: count() })
            .from(jobPostings)
            .where(and(eq(jobPostings.orgId, orgId), eq(jobPostings.status, "OPEN"))),
          this.db
            .select({ cnt: count() })
            .from(leads)
            .where(and(eq(leads.orgId, orgId), gte(leads.createdAt, weekStart))),
          this.db
            .select({ cnt: count() })
            .from(projects)
            .where(and(eq(projects.orgId, orgId), eq(projects.status, "ACTIVE"))),
          this.db.select({ cnt: count() }).from(leads).where(eq(leads.orgId, orgId)),
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

  async getBranchOverview(orgId: string, actor: DashboardActor) {
    if (!actor.isOrgOwner && !actor.isPlatformAdmin && !actor.permissions.includes("hr:analytics:read")) {
      return {
        error: "forbidden",
        message: "Only CEO/HR/Admin can access branch overview",
      } as DashboardForbidden;
    }

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthStartStr = monthStart.toISOString().split("T")[0];

    const allBranches = await this.db.query.branches.findMany({
      where: eq(branches.orgId, orgId),
      with: {
        branchManager: { columns: { id: true, name: true, image: true } },
        branchHr: { columns: { id: true, name: true, image: true } },
      },
    });

    if (allBranches.length === 0) {
      return {
        summary: {
          totalBranches: 0,
          activeBranches: 0,
          totalEmployees: 0,
          totalWorkLogHours: 0,
          totalClients: 0,
        },
        branches: [],
      };
    }

    const branchIds = allBranches.map((b) => b.id);

    const [employeeCounts, timesheetHours, pendingExpenses, clientCounts] = await Promise.all([
      this.db
        .select({ branchId: users.branchId, count: count() })
        .from(users)
        .where(and(inArray(users.branchId, branchIds), eq(users.isActive, true)))
        .groupBy(users.branchId),
      this.db
        .select({
          branchId: users.branchId,
          totalHours: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)`,
        })
        .from(timesheets)
        .innerJoin(users, eq(timesheets.userId, users.id))
        .where(
          and(
            eq(timesheets.orgId, orgId),
            inArray(users.branchId, branchIds),
            gte(timesheets.date, monthStartStr),
          ),
        )
        .groupBy(users.branchId),
      this.db
        .select({
          branchId: users.branchId,
          count: count(),
          total: sql<string>`COALESCE(SUM(${expenses.amount}::numeric), 0)`,
        })
        .from(expenses)
        .innerJoin(users, eq(expenses.userId, users.id))
        .where(
          and(
            eq(expenses.orgId, orgId),
            inArray(users.branchId, branchIds),
            eq(expenses.status, "PENDING"),
          ),
        )
        .groupBy(users.branchId),
      this.db
        .select({ branchId: clientAccounts.branchId, count: count() })
        .from(clientAccounts)
        .where(and(eq(clientAccounts.orgId, orgId), inArray(clientAccounts.branchId, branchIds)))
        .groupBy(clientAccounts.branchId),
    ]);

    const employeeMap = new Map<number, number>();
    for (const r of employeeCounts) {
      if (r.branchId !== null) employeeMap.set(r.branchId, r.count);
    }

    const timesheetMap = new Map<number, number>();
    for (const r of timesheetHours) {
      if (r.branchId !== null) timesheetMap.set(r.branchId, Number(r.totalHours ?? 0));
    }

    const expenseMap = new Map<number, { count: number; total: number }>();
    for (const r of pendingExpenses) {
      if (r.branchId !== null) expenseMap.set(r.branchId, { count: r.count, total: Number(r.total ?? 0) });
    }

    const clientMap = new Map<number, number>();
    for (const r of clientCounts) {
      if (r.branchId !== null) clientMap.set(r.branchId, r.count);
    }

    const branchKpis = allBranches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      code: branch.code,
      city: branch.city,
      state: branch.state,
      status: branch.status,
      branchManager: branch.branchManager,
      branchHr: branch.branchHr,
      kpis: {
        employees: employeeMap.get(branch.id) ?? 0,
        workLogHours: timesheetMap.get(branch.id) ?? 0,
        pendingExpenses: expenseMap.get(branch.id) ?? { count: 0, total: 0 },
        clients: clientMap.get(branch.id) ?? 0,
      },
    }));

    const totalEmployees = branchKpis.reduce((acc, b) => acc + b.kpis.employees, 0);
    const totalHours = branchKpis.reduce((acc, b) => acc + b.kpis.workLogHours, 0);
    const totalClients = branchKpis.reduce((acc, b) => acc + b.kpis.clients, 0);
    const activeBranches = branchKpis.filter((b) => b.status === "ACTIVE").length;

    return {
      summary: {
        totalBranches: allBranches.length,
        activeBranches,
        totalEmployees,
        totalWorkLogHours: totalHours,
        totalClients,
      },
      branches: branchKpis,
    };
  }
}
