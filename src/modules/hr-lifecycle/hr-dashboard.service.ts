import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  organizationMembers,
  users,
  leaveRequests,
  jobPostings,
  onboardingTasks,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";

export interface UpcomingBirthday {
  id: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  image: string | null;
  dateOfBirth: string;
  daysUntil: number;
}

@Injectable()
export class HrDashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  metrics(orgId: string) {
    return this.cache.cached(`hr:dashboard:metrics:${orgId}`, () => this.buildMetrics(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildMetrics(orgId: string) {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const year = now.getFullYear();
    const month = now.getMonth();
    const monthStart = new Date(year, month, 1).toISOString().slice(0, 10);
    const monthEnd = new Date(year, month + 1, 0).toISOString().slice(0, 10);

    const [
      totalResult,
      activeResult,
      onLeaveTodayResult,
      pendingLeavesResult,
      openPositionsResult,
      monthlyHiresResult,
    ] = await Promise.all([
      this.db.select({ count: count() }).from(organizationMembers).where(eq(organizationMembers.orgId, orgId)),

      this.db
        .select({ count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true))),

      this.db
        .select({ count: count() })
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.orgId, orgId),
            eq(leaveRequests.status, "APPROVED"),
            lte(leaveRequests.startDate, todayStr),
            gte(leaveRequests.endDate, todayStr),
          ),
        ),

      this.db
        .select({ count: count() })
        .from(leaveRequests)
        .where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "PENDING"))),

      this.db
        .select({ count: count() })
        .from(jobPostings)
        .where(and(eq(jobPostings.orgId, orgId), eq(jobPostings.status, "OPEN"))),

      this.db
        .select({ count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), gte(users.joiningDate, monthStart), lte(users.joiningDate, monthEnd))),
    ]);

    const allMembersForBirthdays = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        image: users.image,
        dateOfBirth: users.dateOfBirth,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)));

    const today = new Date();
    const upcomingBirthdays: UpcomingBirthday[] = [];

    for (const m of allMembersForBirthdays) {
      if (!m.dateOfBirth) continue;
      const dob = new Date(m.dateOfBirth);
      const nextBirthday = new Date(today.getFullYear(), dob.getMonth(), dob.getDate());
      if (nextBirthday < today) {
        nextBirthday.setFullYear(today.getFullYear() + 1);
      }
      const diffMs = nextBirthday.getTime() - today.getTime();
      const daysUntil = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (daysUntil <= 7) {
        upcomingBirthdays.push({ ...m, dateOfBirth: m.dateOfBirth, daysUntil });
      }
    }
    upcomingBirthdays.sort((a, b) => a.daysUntil - b.daysUntil);

    return {
      totalEmployees: Number(totalResult[0]?.count ?? 0),
      activeEmployees: Number(activeResult[0]?.count ?? 0),
      onLeaveToday: Number(onLeaveTodayResult[0]?.count ?? 0),
      pendingLeaveRequests: Number(pendingLeavesResult[0]?.count ?? 0),
      openPositions: Number(openPositionsResult[0]?.count ?? 0),
      monthlyHires: Number(monthlyHiresResult[0]?.count ?? 0),
      upcomingBirthdays,
    };
  }

  compliance(orgId: string) {
    return this.cache.cached(`hr:compliance:${orgId}`, () => this.buildCompliance(orgId), CACHE_TTL.MEDIUM);
  }

  private async buildCompliance(orgId: string) {
    const members = await this.db
      .select({
        userId: organizationMembers.userId,
        taxId: users.taxId,
        bankDetails: users.bankDetails,
        dateOfBirth: users.dateOfBirth,
        joiningDate: users.joiningDate,
        gender: users.gender,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, orgId));

    const total = members.length;

    const checks = [
      { label: "Bank Details", key: "bankDetails", count: members.filter((m) => m.bankDetails !== null).length },
      { label: "Tax ID (PAN/TAN)", key: "taxId", count: members.filter((m) => m.taxId !== null && m.taxId !== "").length },
      { label: "Date of Birth", key: "dateOfBirth", count: members.filter((m) => m.dateOfBirth !== null).length },
      { label: "Joining Date", key: "joiningDate", count: members.filter((m) => m.joiningDate !== null).length },
      { label: "Gender / Profile", key: "gender", count: members.filter((m) => m.gender !== null).length },
    ];

    const overallCompliant = members.filter(
      (m) =>
        m.bankDetails !== null &&
        m.taxId !== null &&
        m.taxId !== "" &&
        m.dateOfBirth !== null &&
        m.joiningDate !== null &&
        m.gender !== null,
    ).length;

    return {
      total,
      overallCompliant,
      overallPct: total > 0 ? Math.round((overallCompliant / total) * 100) : 0,
      checks: checks.map((c) => ({
        label: c.label,
        compliant: c.count,
        missing: total - c.count,
        pct: total > 0 ? Math.round((c.count / total) * 100) : 0,
      })),
    };
  }

  diversity(orgId: string) {
    return this.cache.cached(`hr:dashboard:diversity:${orgId}`, () => this.buildDiversity(orgId), CACHE_TTL.LONG);
  }

  private async buildDiversity(orgId: string) {
    const genderRows = await this.db
      .select({ gender: users.gender, count: count() })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
      .groupBy(users.gender);

    const genderBreakdown = genderRows.map((r) => ({
      gender: r.gender ?? "NOT_SPECIFIED",
      count: Number(r.count),
    }));

    const membersForAge = await this.db
      .select({ dateOfBirth: users.dateOfBirth })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true), sql`${users.dateOfBirth} IS NOT NULL`));

    const ageBuckets: Record<string, number> = {
      "Under 25": 0,
      "25–34": 0,
      "35–44": 0,
      "45–54": 0,
      "55+": 0,
    };

    const now = new Date();
    for (const m of membersForAge) {
      if (!m.dateOfBirth) continue;
      const dob = new Date(m.dateOfBirth);
      const age =
        now.getFullYear() - dob.getFullYear() - (now < new Date(now.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0);
      if (age < 25) ageBuckets["Under 25"]++;
      else if (age < 35) ageBuckets["25–34"]++;
      else if (age < 45) ageBuckets["35–44"]++;
      else if (age < 55) ageBuckets["45–54"]++;
      else ageBuckets["55+"]++;
    }

    const ageDistribution = Object.entries(ageBuckets).map(([range, value]) => ({ range, count: value }));

    return { genderBreakdown, ageDistribution };
  }

  async onboardingStatus(orgId: string) {
    const taskStats = await this.db
      .select({
        userId: onboardingTasks.userId,
        total: count(),
        completed: sql<number>`SUM(CASE WHEN ${onboardingTasks.status} = 'COMPLETED' THEN 1 ELSE 0 END)`,
      })
      .from(onboardingTasks)
      .where(eq(onboardingTasks.orgId, orgId))
      .groupBy(onboardingTasks.userId);

    if (taskStats.length === 0) {
      return { inProgress: 0, completed: 0, total: 0, completionPct: 0, newHires: [] };
    }

    let inProgress = 0;
    let completedCount = 0;
    const inProgressIds: string[] = [];

    for (const stat of taskStats) {
      const done = Number(stat.completed);
      const tot = Number(stat.total);
      if (tot > 0 && done >= tot) {
        completedCount++;
      } else {
        inProgress++;
        inProgressIds.push(stat.userId);
      }
    }

    const total = inProgress + completedCount;
    const completionPct = total > 0 ? Math.round((completedCount / total) * 100) : 0;

    const newHires: { userId: string; name: string; completedTasks: number; totalTasks: number; pct: number }[] = [];

    const previewIds = inProgressIds.slice(0, 5);
    if (previewIds.length > 0) {
      const userDetails = await this.db
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, name: users.name })
        .from(users)
        .where(inArray(users.id, previewIds));

      const statsByUser = Object.fromEntries(taskStats.map((s) => [s.userId, s]));

      for (const u of userDetails) {
        const stat = statsByUser[u.id];
        if (!stat) continue;
        const completedTasks = Number(stat.completed);
        const totalTasks = Number(stat.total);
        const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
        const name = u.firstName && u.lastName ? `${u.firstName} ${u.lastName}` : (u.name ?? "Unknown");
        newHires.push({ userId: u.id, name, completedTasks, totalTasks, pct });
      }
    }

    return { inProgress, completed: completedCount, total, completionPct, newHires };
  }
}
