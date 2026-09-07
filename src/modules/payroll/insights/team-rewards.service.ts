import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { employeeSalaryProfiles, users } from "../../../db/schema";
import { hrBenefitEnrollments, hrBenefitPlans } from "../../../db/schema/hr/benefits";
import { hrEquityGrants } from "../../../db/schema/hr/enterprise-comp";
import { EssService } from "./ess.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { analyzePayCompression } from "./lib/pay-compression";
import { estimateEmployerMonthlyBenefit } from "./lib/total-rewards";

const MAX_BENEFIT_ENROLLMENTS_PER_REPORT = 100;
const MAX_EQUITY_GRANTS_PER_REPORT = 1_000;
const MAX_ORG_PAY_COMPRESSION_PROFILES = 10_000;

export interface TeamRewardsMemberRow {
  userId: string;
  name: string | null;
  email: string | null;
  annualCtc: string | null;
  activeBenefitPlans: number;
  estimatedEmployerBenefitsAnnual: string | null;
  equityUnits: number;
}

export interface TeamRewardsResult {
  mode: "manager_team_rewards";
  honestyNote: string;
  reportCount: number;
  members: TeamRewardsMemberRow[];
  payCompression: ReturnType<typeof analyzePayCompression>;
}

/**
 * Manager-scoped total-rewards lite + pay compression for direct reports.
 */
@Injectable()
export class TeamRewardsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ess: EssService,
    private readonly employmentFacts: EmploymentFactsService,
  ) {}

  async getTeamRewards(orgId: string, managerUserId: string): Promise<TeamRewardsResult> {
    const reports = await this.loadDirectReports(orgId, managerUserId);
    const honestyNote =
      "Team total rewards is an illustrative cash + benefits estimate + equity units view of your direct reports. Equity is not mark-to-market. Pay compression uses CTC only with no protected attributes.";

    if (reports.length === 0) {
      return {
        mode: "manager_team_rewards",
        honestyNote,
        reportCount: 0,
        members: [],
        payCompression: analyzePayCompression([], 0),
      };
    }

    const reportIds = reports.map((r) => r.id);
    const [profiles, enrollments, grants] = await Promise.all([
      this.db
        .select({
          userId: employeeSalaryProfiles.userId,
          annualCtc: employeeSalaryProfiles.annualCtc,
        })
        .from(employeeSalaryProfiles)
        .where(
          and(
            eq(employeeSalaryProfiles.orgId, orgId),
            inArray(employeeSalaryProfiles.userId, reportIds),
            eq(employeeSalaryProfiles.status, "ACTIVE"),
          ),
        )
        .limit(reportIds.length + 1),
      this.db
        .select({
          userId: hrBenefitEnrollments.userId,
          premiumCents: hrBenefitPlans.premiumCents,
          employerContributionPct: hrBenefitPlans.employerContributionPct,
        })
        .from(hrBenefitEnrollments)
        .innerJoin(hrBenefitPlans, eq(hrBenefitPlans.id, hrBenefitEnrollments.planId))
        .where(
          and(
            eq(hrBenefitEnrollments.orgId, orgId),
            inArray(hrBenefitEnrollments.userId, reportIds),
            eq(hrBenefitEnrollments.status, "active"),
          ),
        )
        .limit(reportIds.length * MAX_BENEFIT_ENROLLMENTS_PER_REPORT + 1),
      this.db
        .select({
          userId: hrEquityGrants.userId,
          units: hrEquityGrants.units,
        })
        .from(hrEquityGrants)
        .where(
          and(
            eq(hrEquityGrants.orgId, orgId),
            inArray(hrEquityGrants.userId, reportIds),
            eq(hrEquityGrants.status, "active"),
          ),
        )
        .limit(reportIds.length * MAX_EQUITY_GRANTS_PER_REPORT + 1),
    ]);

    if (profiles.length > reportIds.length) {
      throw new ConflictException("Direct reports have duplicate active salary profiles");
    }
    if (enrollments.length > reportIds.length * MAX_BENEFIT_ENROLLMENTS_PER_REPORT) {
      throw new ConflictException("Direct-report benefit enrollments exceed the supported analysis bound");
    }
    if (grants.length > reportIds.length * MAX_EQUITY_GRANTS_PER_REPORT) {
      throw new ConflictException("Direct-report equity grants exceed the supported analysis bound");
    }

    const ctcByUser = new Map(profiles.map((p) => [p.userId, p.annualCtc]));
    const benefitsByUser = new Map<string, { count: number; annual: number }>();
    for (const e of enrollments) {
      const cur = benefitsByUser.get(e.userId) ?? { count: 0, annual: 0 };
      cur.count += 1;
      const monthly = estimateEmployerMonthlyBenefit(
        e.premiumCents,
        e.employerContributionPct ?? 0,
      );
      if (monthly != null) cur.annual += monthly * 12;
      benefitsByUser.set(e.userId, cur);
    }
    const equityByUser = new Map<string, number>();
    for (const g of grants) {
      equityByUser.set(g.userId, (equityByUser.get(g.userId) ?? 0) + g.units);
    }

    const members: TeamRewardsMemberRow[] = reports.map((r) => {
      const ctcStr = ctcByUser.get(r.id) ?? null;
      const ctcNum = ctcStr != null ? parseFloat(ctcStr) : NaN;
      const ben = benefitsByUser.get(r.id);
      return {
        userId: r.id,
        name: r.name,
        email: r.email,
        annualCtc:
          ctcStr != null && Number.isFinite(ctcNum) ? ctcNum.toFixed(2) : null,
        activeBenefitPlans: ben?.count ?? 0,
        estimatedEmployerBenefitsAnnual:
          ben && ben.annual > 0 ? ben.annual.toFixed(2) : null,
        equityUnits: equityByUser.get(r.id) ?? 0,
      };
    });

    const compressionMembers = members
      .filter((m): m is TeamRewardsMemberRow & { annualCtc: string } => m.annualCtc != null)
      .map((m) => ({
        userId: m.userId,
        annualCtc: parseFloat(m.annualCtc),
        label: m.name,
      }));
    const missingCtcCount = members.filter((m) => m.annualCtc == null).length;

    return {
      mode: "manager_team_rewards",
      honestyNote,
      reportCount: members.length,
      members,
      payCompression: analyzePayCompression(compressionMembers, missingCtcCount),
    };
  }

  /**
   * Full total-rewards statement for one direct report (manager view).
   */
  async getReportTotalRewards(orgId: string, managerUserId: string, reportUserId: string) {
    await this.assertDirectReport(orgId, managerUserId, reportUserId);
    return this.ess.getTotalRewards(orgId, reportUserId, null);
  }

  /**
   * Org-wide pay compression (admin). CTC only; no protected attributes.
   */
  async getOrgPayCompression(orgId: string) {
    const rows = await this.db
      .select({
        userId: employeeSalaryProfiles.userId,
        annualCtc: employeeSalaryProfiles.annualCtc,
        name: users.name,
      })
      .from(employeeSalaryProfiles)
      .leftJoin(users, eq(users.id, employeeSalaryProfiles.userId))
      .where(
        and(
          eq(employeeSalaryProfiles.orgId, orgId),
          eq(employeeSalaryProfiles.status, "ACTIVE"),
        ),
      )
      .limit(MAX_ORG_PAY_COMPRESSION_PROFILES + 1);

    if (rows.length > MAX_ORG_PAY_COMPRESSION_PROFILES) {
      throw new ConflictException(
        `Organization pay compression exceeds the supported ${MAX_ORG_PAY_COMPRESSION_PROFILES}-profile bound`,
      );
    }

    const members = rows
      .filter((r): r is typeof r & { userId: string } => r.userId !== null)
      .map((r) => ({
        userId: r.userId,
        annualCtc: parseFloat(r.annualCtc ?? "0") || 0,
        label: r.name,
      }))
      .filter((m) => m.annualCtc > 0);

    const missingCtcCount = rows.length - members.length;
    return {
      scope: "organization" as const,
      ...analyzePayCompression(members, missingCtcCount),
    };
  }

  private async loadDirectReports(orgId: string, managerUserId: string) {
    const reportIds = await this.employmentFacts.getDirectReportUserIds(orgId, managerUserId);
    if (reportIds.length === 0) return [];
    return this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, reportIds))
      .limit(reportIds.length);
  }

  private async assertDirectReport(
    orgId: string,
    managerUserId: string,
    subjectUserId: string,
  ) {
    const subject = await this.employmentFacts.getFacts(orgId, subjectUserId);
    if (subject.managerUserId !== managerUserId) {
      throw new ForbiddenException("You can only view total rewards for your direct reports");
    }
  }
}
