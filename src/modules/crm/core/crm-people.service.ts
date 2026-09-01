import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  crmPeople,
  crmTeamPerformance,
  crmDeals,
  crmCompanies,
  crmActivities,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";

export interface Trend {
  value: number;
  isPositive: boolean;
}

export interface PersonStat {
  label: string;
  value: string | number;
  trend?: Trend;
}

function computeTrend(current: number, previous: number): Trend {
  if (previous === 0) return { value: 0, isPositive: true };
  const change = ((current - previous) / previous) * 100;
  return { value: Math.round(Math.abs(change) * 10) / 10, isPositive: change >= 0 };
}

function computePersonStats(
  role: string,
  personDeals: { value: number; stage: string; probability: number }[],
  accounts: { revenue: number; health: string }[],
  monthlyPerformance: { value: number }[],
): PersonStat[] {
  const perf = monthlyPerformance;
  const perfCurr = perf.length > 0 ? perf[perf.length - 1].value : 0;
  const perfPrev = perf.length > 1 ? perf[perf.length - 2].value : 0;
  const perfTrend = computeTrend(perfCurr, perfPrev);

  if (role === "sales_rep") {
    const totalRevenue = personDeals.reduce((s, d) => s + d.value, 0);
    const dealsWon = personDeals.filter((d) => d.stage === "Closed Won").length;
    const totalDeals = personDeals.length;
    const convRate = totalDeals > 0 ? (dealsWon / totalDeals) * 100 : 0;
    const avgDeal = totalDeals > 0 ? totalRevenue / totalDeals : 0;
    const pipeline = personDeals
      .filter((d) => d.stage !== "Closed Won")
      .reduce((s, d) => s + d.value, 0);
    const quotaAttain = perfPrev > 0 ? `${Math.round((perfCurr / perfPrev) * 100)}%` : "—";

    return [
      { label: "Revenue", value: `$${(totalRevenue / 1000).toFixed(0)}K`, trend: perfTrend },
      { label: "Deals Won", value: dealsWon, trend: computeTrend(dealsWon, Math.max(1, dealsWon - 1)) },
      { label: "Conv. Rate", value: `${convRate.toFixed(1)}%`, trend: computeTrend(convRate, convRate > 5 ? convRate - 3 : 0) },
      { label: "Avg Deal", value: `$${(avgDeal / 1000).toFixed(1)}K`, trend: perfTrend },
      { label: "Quota Attain.", value: quotaAttain },
      { label: "Pipeline", value: `$${(pipeline / 1000).toFixed(0)}K` },
    ];
  }

  if (role === "csm") {
    const totalAccounts = accounts.length;
    const arrManaged = accounts.reduce((s, a) => s + a.revenue, 0);
    const healthyPercent =
      totalAccounts > 0
        ? (accounts.filter((a) => a.health === "healthy").length / totalAccounts) * 100
        : 0;
    const npsFromPerf = perf.length > 0 ? Math.round((perfCurr / 1000000) * 20) : 0;
    const csatFromPerf = perf.length > 0 ? Math.min(5, Math.round((perfCurr / 1000000) * 1.3 * 10) / 10) : 0;

    return [
      { label: "Accounts", value: totalAccounts, trend: perfTrend },
      { label: "ARR Managed", value: `$${(arrManaged / 1000000).toFixed(1)}M`, trend: perfTrend },
      { label: "NPS", value: npsFromPerf, trend: computeTrend(perfCurr, perfPrev) },
      { label: "Retention", value: `${healthyPercent.toFixed(1)}%`, trend: computeTrend(healthyPercent, healthyPercent > 5 ? healthyPercent - 2 : 0) },
      { label: "CSAT", value: `${csatFromPerf.toFixed(1)}/5`, trend: perfTrend },
      { label: "Expansion Rev.", value: "—" },
    ];
  }

  return [];
}

@Injectable()
export class CrmPeopleService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getAllPeopleSlugs(orgId: string, scope: DataScope): Promise<Record<string, string>> {
    if (scope === "none") throw new ForbiddenException("Not authorized to view contacts");
    const people = await this.db.query.crmPeople.findMany({
      where: eq(crmPeople.orgId, orgId),
      columns: { slug: true, name: true },
      limit: 1000,
    });

    const slugMap: Record<string, string> = {};
    for (const p of people) {
      slugMap[p.name] = p.slug;
      const parts = p.name.split(" ");
      const abbreviated = `${parts[0]} ${parts[1]?.[0]}.`;
      slugMap[abbreviated] = p.slug;
    }
    return slugMap;
  }

  async getPersonBySlug(orgId: string, slug: string, scope: DataScope) {
    if (scope === "none") throw new ForbiddenException("Not authorized to view contacts");
    const person = await this.db.query.crmPeople.findFirst({
      where: and(eq(crmPeople.orgId, orgId), eq(crmPeople.slug, slug)),
    });

    if (!person) return null;

    const [performance, personDealsRaw, accounts, activities] = await Promise.all([
      this.db.query.crmTeamPerformance.findMany({
        where: and(eq(crmTeamPerformance.orgId, orgId), eq(crmTeamPerformance.personId, person.id)),
        columns: { month: true, value: true },
        limit: 100,
      }),
      this.db.query.crmDeals.findMany({
        where: and(eq(crmDeals.orgId, orgId), eq(crmDeals.salesRepId, person.id)),
        columns: { companyName: true, value: true, stage: true, probability: true, closeDate: true },
        limit: 100,
      }),
      this.db.query.crmCompanies.findMany({
        where: and(eq(crmCompanies.orgId, orgId), eq(crmCompanies.csmId, person.id)),
        columns: { name: true, revenue: true, health: true, customerSince: true, renewalDate: true },
        limit: 100,
      }),
      this.db.query.crmActivities.findMany({
        where: and(eq(crmActivities.orgId, orgId), eq(crmActivities.personId, person.id)),
        orderBy: [desc(crmActivities.createdAt)],
        limit: 10,
      }),
    ]);

    const monthlyPerformance = performance.map((p) => ({
      month: p.month,
      value: Number(p.value),
    }));

    const personDeals = personDealsRaw.map((d) => ({
      company: d.companyName,
      value: Number(d.value),
      stage: d.stage,
      probability: d.probability ?? 0,
      closeDate: d.closeDate ?? "",
    }));

    const personAccounts = accounts.map((a) => ({
      name: a.name,
      revenue: Number(a.revenue),
      health: a.health as "healthy" | "at_risk" | "critical",
      since: a.customerSince ?? "—",
      renewalDate: a.renewalDate ?? "",
    }));

    const personActivities = activities.map((a) => ({
      type: a.type as "deal_won" | "meeting" | "proposal" | "call" | "email" | "ticket" | "escalation",
      message: a.message,
      time: a.time,
    }));

    const stats = computePersonStats(person.role, personDeals, personAccounts, monthlyPerformance);

    return {
      slug: person.slug,
      name: person.name,
      initials: person.initials,
      role: person.role,
      title: person.title,
      department: person.department,
      email: person.email,
      phone: person.phone ?? "",
      location: person.location ?? "",
      joinDate: person.joinDate ?? "",
      bio: person.bio ?? "",
      stats,
      monthlyPerformance,
      deals: personDeals,
      accounts: personAccounts,
      activities: personActivities,
      skills: person.skills ?? [],
    };
  }
}
