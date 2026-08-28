import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  hrEmployeeSensitiveFields,
  hrEmployments,
  hrPeople,
  organizationMembers,
  users,
  leaveRequests,
  jobPostings,
  onboardingTasks,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";

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
        .leftJoin(hrPeople, and(eq(hrPeople.userId, users.id), eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt)))
        .leftJoin(hrEmployments, and(eq(hrEmployments.personId, hrPeople.id), eq(hrEmployments.orgId, orgId), eq(hrEmployments.isPrimary, true), isNull(hrEmployments.deletedAt)))
        .where(and(eq(organizationMembers.orgId, orgId), gte(hrEmployments.joiningDate, monthStart), lte(hrEmployments.joiningDate, monthEnd))),
    ]);

    const windowDates = Array.from({ length: 8 }, (_, i) => {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    const mmddValues = sql.join(windowDates.map((d) => sql`${d}`), sql`, `);

    const bdayMembers = await this.db
      .select({
        id: users.id,
        name: users.name,
        firstName: users.firstName,
        lastName: users.lastName,
        image: users.image,
        dateOfBirth: users.dateOfBirth,
        mmdd: sql<string>`to_char(${users.dateOfBirth}::date, 'MM-DD')`,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(users.isActive, true),
          isNotNull(users.dateOfBirth),
          sql`to_char(${users.dateOfBirth}::date, 'MM-DD') IN (${mmddValues})`,
        ),
      )
      .limit(50);

    const mmddToOffset = new Map(windowDates.map((mmdd, i) => [mmdd, i]));
    const upcomingBirthdays: UpcomingBirthday[] = [];
    for (const m of bdayMembers) {
      if (!m.dateOfBirth) continue;
      upcomingBirthdays.push({
        id: m.id,
        name: m.name,
        firstName: m.firstName,
        lastName: m.lastName,
        image: m.image,
        dateOfBirth: m.dateOfBirth,
        daysUntil: mmddToOffset.get(m.mmdd) ?? 0,
      });
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
    const [totalResult, bankResult, taxResult, dobResult, joiningResult, genderResult, allCompliantResult] =
      await Promise.all([
        this.db.select({ count: count() }).from(organizationMembers).where(eq(organizationMembers.orgId, orgId)),

        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .leftJoin(hrPeople, and(eq(hrPeople.userId, users.id), eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt)))
          .leftJoin(hrEmployments, and(eq(hrEmployments.personId, hrPeople.id), eq(hrEmployments.orgId, orgId), eq(hrEmployments.isPrimary, true), isNull(hrEmployments.deletedAt)))
          .leftJoin(hrEmployeeSensitiveFields, eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id))
          .where(and(eq(organizationMembers.orgId, orgId), isNotNull(hrEmployeeSensitiveFields.bankDetails))),

        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .leftJoin(hrPeople, and(eq(hrPeople.userId, users.id), eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt)))
          .leftJoin(hrEmployments, and(eq(hrEmployments.personId, hrPeople.id), eq(hrEmployments.orgId, orgId), eq(hrEmployments.isPrimary, true), isNull(hrEmployments.deletedAt)))
          .leftJoin(hrEmployeeSensitiveFields, eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id))
          .where(and(eq(organizationMembers.orgId, orgId), isNotNull(hrEmployeeSensitiveFields.taxId), sql`${hrEmployeeSensitiveFields.taxId} <> ''`)),

        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(and(eq(organizationMembers.orgId, orgId), isNotNull(users.dateOfBirth))),

        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .leftJoin(hrPeople, and(eq(hrPeople.userId, users.id), eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt)))
          .leftJoin(hrEmployments, and(eq(hrEmployments.personId, hrPeople.id), eq(hrEmployments.orgId, orgId), eq(hrEmployments.isPrimary, true), isNull(hrEmployments.deletedAt)))
          .where(and(eq(organizationMembers.orgId, orgId), isNotNull(hrEmployments.joiningDate))),

        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(and(eq(organizationMembers.orgId, orgId), isNotNull(users.gender))),

        this.db
          .select({ count: count() })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .leftJoin(hrPeople, and(eq(hrPeople.userId, users.id), eq(hrPeople.orgId, orgId), isNull(hrPeople.deletedAt)))
          .leftJoin(hrEmployments, and(eq(hrEmployments.personId, hrPeople.id), eq(hrEmployments.orgId, orgId), eq(hrEmployments.isPrimary, true), isNull(hrEmployments.deletedAt)))
          .leftJoin(hrEmployeeSensitiveFields, eq(hrEmployeeSensitiveFields.employmentId, hrEmployments.id))
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              isNotNull(hrEmployeeSensitiveFields.bankDetails),
              isNotNull(hrEmployeeSensitiveFields.taxId),
              sql`${hrEmployeeSensitiveFields.taxId} <> ''`,
              isNotNull(users.dateOfBirth),
              isNotNull(hrEmployments.joiningDate),
              isNotNull(users.gender),
            ),
          ),
      ]);

    const total = Number(totalResult[0]?.count ?? 0);
    const overallCompliant = Number(allCompliantResult[0]?.count ?? 0);

    const checks = [
      { label: "Bank Details", compliant: Number(bankResult[0]?.count ?? 0) },
      { label: "Tax ID (PAN/TAN)", compliant: Number(taxResult[0]?.count ?? 0) },
      { label: "Date of Birth", compliant: Number(dobResult[0]?.count ?? 0) },
      { label: "Joining Date", compliant: Number(joiningResult[0]?.count ?? 0) },
      { label: "Gender / Profile", compliant: Number(genderResult[0]?.count ?? 0) },
    ];

    return {
      total,
      overallCompliant,
      overallPct: total > 0 ? Math.round((overallCompliant / total) * 100) : 0,
      checks: checks.map((c) => ({
        label: c.label,
        compliant: c.compliant,
        missing: total - c.compliant,
        pct: total > 0 ? Math.round((c.compliant / total) * 100) : 0,
      })),
    };
  }

  diversity(orgId: string) {
    return this.cache.cached(`hr:dashboard:diversity:${orgId}`, () => this.buildDiversity(orgId), CACHE_TTL.LONG);
  }

  private async buildDiversity(orgId: string) {
    const [genderRows, ageRows] = await Promise.all([
      this.db
        .select({ gender: users.gender, count: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(organizationMembers.orgId, orgId), eq(users.isActive, true)))
        .groupBy(users.gender),

      this.db
        .select({
          range: sql<string>`
            CASE
              WHEN EXTRACT(YEAR FROM age(${users.dateOfBirth}::date)) < 25 THEN 'Under 25'
              WHEN EXTRACT(YEAR FROM age(${users.dateOfBirth}::date)) < 35 THEN '25–34'
              WHEN EXTRACT(YEAR FROM age(${users.dateOfBirth}::date)) < 45 THEN '35–44'
              WHEN EXTRACT(YEAR FROM age(${users.dateOfBirth}::date)) < 55 THEN '45–54'
              ELSE '55+'
            END
          `,
          count: count(),
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(users.isActive, true),
            isNotNull(users.dateOfBirth),
          ),
        )
        .groupBy(sql`
          CASE
            WHEN EXTRACT(YEAR FROM age(${users.dateOfBirth}::date)) < 25 THEN 'Under 25'
            WHEN EXTRACT(YEAR FROM age(${users.dateOfBirth}::date)) < 35 THEN '25–34'
            WHEN EXTRACT(YEAR FROM age(${users.dateOfBirth}::date)) < 45 THEN '35–44'
            WHEN EXTRACT(YEAR FROM age(${users.dateOfBirth}::date)) < 55 THEN '45–54'
            ELSE '55+'
          END
        `),
    ]);

    const genderBreakdown = genderRows.map((r) => ({
      gender: r.gender ?? "NOT_SPECIFIED",
      count: Number(r.count),
    }));

    const ORDER = ["Under 25", "25–34", "35–44", "45–54", "55+"];
    const ageMap = new Map(ageRows.map((r) => [r.range, Number(r.count)]));
    const ageDistribution = ORDER.map((range) => ({ range, count: ageMap.get(range) ?? 0 }));

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
