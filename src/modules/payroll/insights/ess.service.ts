import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, lte, not, sql, sum } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  employeeSalaryProfileComponents,
  employeeSalaryProfiles,
  fnfSettlements,
  payrollCalendarEvents,
  payrollPolicies,
  payrollPolicyVersions,
  payrollRunEmployees,
  payrollRuns,
  payrollTaxWindows,
  payslipPublications,
  reimbursements,
  salaryComponents,
  salaryLoans,
  leaveBalances,
  leaveTypes,
} from "../../../db/schema";
import { hrBenefitEnrollments, hrBenefitPlans } from "../../../db/schema/hr/benefits";
import { hrEquityGrants } from "../../../db/schema/hr/enterprise-comp";
import { TaxService } from "../hr-payroll/tax.service";
import { DEFAULT_PAYROLL_TOGGLES, PayrollToggles } from "../payroll.types";
import { buildTotalRewardsStatement } from "./lib/total-rewards";

@Injectable()
export class EssService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly taxService: TaxService,
  ) {}

  async getActiveToggles(orgId: string): Promise<PayrollToggles> {
    const policy = await this.db.query.payrollPolicies.findFirst({
      where: eq(payrollPolicies.orgId, orgId),
      columns: { activeVersionId: true },
    });
    if (!policy?.activeVersionId) {
      return {
        ...DEFAULT_PAYROLL_TOGGLES,
        essShowSalaryStructure: true,
        essAllowBankUpdate: true,
        essAllowLoanRequests: true,
        essAllowTaxDeclarations: true,
        essAllowReimbursements: true,
      };
    }
    const version = await this.db.query.payrollPolicyVersions.findFirst({
      where: eq(payrollPolicyVersions.id, policy.activeVersionId),
      columns: { toggles: true },
    });
    const stored = version?.toggles;
    if (!stored || typeof stored !== "object") return { ...DEFAULT_PAYROLL_TOGGLES };
    return { ...DEFAULT_PAYROLL_TOGGLES, ...(stored as Partial<PayrollToggles>) };
  }

  async getActiveWindow(orgId: string) {
    return this.db.query.payrollTaxWindows.findFirst({
      where: and(eq(payrollTaxWindows.orgId, orgId), eq(payrollTaxWindows.status, "OPEN")),
    });
  }

  async getOverview(orgId: string, userId: string, membershipId: number | null) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const pubOwner = eq(payslipPublications.userMembershipId, membershipId);
    const pubWhere = and(pubOwner, eq(payslipPublications.orgId, orgId), eq(payslipPublications.status, "PUBLISHED"));

    const now = new Date(), yr = now.getFullYear(), mo = now.getMonth() + 1;
    const fyStart = mo >= 4 ? `${yr}-04` : `${yr - 1}-04`;
    const fyEnd = mo >= 4 ? `${yr + 1}-03` : `${yr}-03`;
    const today = now.toISOString().slice(0, 10);

    const [toggles, [latestPub], fyPubs, [activeLoanRow], [pendingRow], window, [nextPayEvent]] = await Promise.all([
      this.getActiveToggles(orgId),
      this.db
        .select({ id: payslipPublications.id, publishedAt: payslipPublications.publishedAt, month: payrollRuns.month, net: payrollRunEmployees.net })
        .from(payslipPublications)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payslipPublications.runId))
        .innerJoin(payrollRunEmployees, eq(payrollRunEmployees.id, payslipPublications.runEmployeeId))
        .where(pubWhere)
        .orderBy(desc(payslipPublications.publishedAt))
        .limit(1),
      this.db
        .select({ runId: payslipPublications.runId })
        .from(payslipPublications)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payslipPublications.runId))
        .where(and(pubWhere, gte(payrollRuns.month, fyStart), lte(payrollRuns.month, fyEnd))),
      this.db
        .select({
          balance: sql<string>`coalesce(sum((coalesce(${salaryLoans.totalEmis}, 0) - coalesce(${salaryLoans.paidEmis}, 0)) * coalesce(${salaryLoans.emiAmount}, 0)::numeric), 0)::text`,
        })
        .from(salaryLoans)
        .where(and(eq(salaryLoans.userMembershipId, membershipId), eq(salaryLoans.orgId, orgId), inArray(salaryLoans.status, ["APPROVED", "ACTIVE"]))),
      this.db
        .select({ total: count() })
        .from(reimbursements)
        .where(and(eq(reimbursements.userMembershipId, membershipId ?? 0), eq(reimbursements.orgId, orgId), eq(reimbursements.status, "PENDING"))),
      this.getActiveWindow(orgId),
      this.db
        .select({ date: payrollCalendarEvents.date, title: payrollCalendarEvents.title })
        .from(payrollCalendarEvents)
        .where(
          and(
            eq(payrollCalendarEvents.orgId, orgId),
            eq(payrollCalendarEvents.type, "PAY_DATE"),
            gte(payrollCalendarEvents.date, today),
          ),
        )
        .orderBy(asc(payrollCalendarEvents.date))
        .limit(1),
    ]);

    const [ytdRows, declarations] = await Promise.all([
      fyPubs.length > 0
        ? this.db
            .select({ gross: sum(payrollRunEmployees.gross), net: sum(payrollRunEmployees.net) })
            .from(payrollRunEmployees)
            .where(and(eq(payrollRunEmployees.userMembershipId, membershipId), inArray(payrollRunEmployees.runId, fyPubs.map((p) => p.runId))))
        : Promise.resolve([]),
      window ? this.taxService.listMine(orgId, userId) : Promise.resolve([]),
    ]);

    let ytdGross = "0.00", ytdNet = "0.00";
    if (ytdRows[0]) {
      ytdGross = parseFloat(ytdRows[0].gross ?? "0").toFixed(2);
      ytdNet = parseFloat(ytdRows[0].net ?? "0").toFixed(2);
    }

    const activeLoanBalance = (parseFloat(activeLoanRow?.balance ?? "0") || 0).toFixed(2);

    const declarationStatus: string | null = window
      ? declarations.find((d) => d.financialYear === window.financialYear)?.status ?? null
      : null;

    const pendingReimbursementsCount = Number(pendingRow?.total ?? 0);
    const actionRequired: {
      key: string;
      label: string;
      severity: "info" | "warning";
      href: string;
    }[] = [];

    if (pendingReimbursementsCount > 0) {
      actionRequired.push({
        key: "pending_reimbursements",
        label: `${pendingReimbursementsCount} reimbursement claim(s) awaiting approval`,
        severity: "info",
        href: "/payroll/me#reimbursements",
      });
    }
    if (window && (!declarationStatus || declarationStatus === "DRAFT")) {
      actionRequired.push({
        key: "tax_declaration_open",
        label: `Tax declaration window open for ${window.financialYear}`,
        severity: "warning",
        href: "/payroll/me#tax",
      });
    }
    if (!latestPub) {
      actionRequired.push({
        key: "no_payslip_yet",
        label: "No published payslip yet — available after payroll publishes",
        severity: "info",
        href: "/payroll/me#payslips",
      });
    }

    return {
      toggles,
      capabilities: {
        mode: "employee_self_service" as const,
        honestyNote:
          "ESS shows your own payroll data only. You cannot change locked payslips or approve your own claims.",
        canViewSalaryStructure: Boolean(toggles.essShowSalaryStructure),
        canUpdateBank: Boolean(toggles.essAllowBankUpdate),
        canRequestLoans: Boolean(toggles.essAllowLoanRequests),
        canDeclareTax: Boolean(toggles.essAllowTaxDeclarations),
        canClaimReimbursements: Boolean(toggles.essAllowReimbursements),
      },
      latestPayslip: latestPub
        ? {
            publicationId: latestPub.id,
            month: latestPub.month,
            net: latestPub.net,
            downloadHref: `/payroll/payslips/${latestPub.id}/download`,
          }
        : null,
      nextPayDate: nextPayEvent
        ? { date: nextPayEvent.date, label: nextPayEvent.title }
        : null,
      ytd: { gross: ytdGross, net: ytdNet },
      activeLoanBalance,
      pendingReimbursementsCount,
      taxWindow: window
        ? {
            status: window.status,
            financialYear: window.financialYear,
            closesAt: window.closesAt,
          }
        : null,
      declarationStatus,
      actionRequired,
    };
  }

  async getPayslips(orgId: string, userId: string, membershipId: number | null) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const pubOwner = eq(payslipPublications.userMembershipId, membershipId);
    const pubs = await this.db
      .select({
        publicationId: payslipPublications.id,
        publishedAt: payslipPublications.publishedAt,
        month: payrollRuns.month,
        net: payrollRunEmployees.net,
      })
      .from(payslipPublications)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payslipPublications.runId))
      .innerJoin(payrollRunEmployees, eq(payrollRunEmployees.id, payslipPublications.runEmployeeId))
      .where(and(pubOwner, eq(payslipPublications.orgId, orgId), eq(payslipPublications.status, "PUBLISHED")))
      .orderBy(desc(payslipPublications.publishedAt))
      .limit(100);

    return pubs.map((pub) => ({
      publicationId: pub.publicationId,
      month: pub.month,
      net: pub.net,
      publishedAt: pub.publishedAt,
      downloadHref: `/payroll/payslips/${pub.publicationId}/download`,
    }));
  }

  async getSalaryStructure(orgId: string, userId: string, membershipId: number | null) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const toggles = await this.getActiveToggles(orgId);
    if (!toggles.essShowSalaryStructure) throw new ForbiddenException("Salary structure access is disabled");

    const profile = await this.db.query.employeeSalaryProfiles.findFirst({
      where: and(
        eq(employeeSalaryProfiles.userMembershipId, membershipId),
        eq(employeeSalaryProfiles.orgId, orgId),
        eq(employeeSalaryProfiles.status, "ACTIVE"),
      ),
      orderBy: (fields, { desc: d }) => [d(fields.effectiveFrom)],
    });
    if (!profile) throw new NotFoundException("No active salary profile found");

    const components = await this.db
      .select({
        code: salaryComponents.code,
        name: salaryComponents.name,
        type: salaryComponents.type,
        amount: employeeSalaryProfileComponents.amount,
        percent: employeeSalaryProfileComponents.percent,
      })
      .from(employeeSalaryProfileComponents)
      .innerJoin(salaryComponents, eq(salaryComponents.id, employeeSalaryProfileComponents.componentId))
      .where(eq(employeeSalaryProfileComponents.profileId, profile.id))
      .limit(500);

    return {
      profile: {
        annualCtc: profile.annualCtc,
        workerType: profile.workerType,
        taxRegime: profile.taxRegime,
        costCenter: profile.costCenter,
        effectiveFrom: profile.effectiveFrom,
      },
      components,
    };
  }

  async getOwnFnf(orgId: string, userId: string, membershipId: number | null) {
    const [settlement] = await this.db
      .select({
        id: fnfSettlements.id,
        basicDues: fnfSettlements.basicDues,
        leaveEncashment: fnfSettlements.leaveEncashment,
        bonusDue: fnfSettlements.bonusDue,
        deductions: fnfSettlements.deductions,
        loanRecovery: fnfSettlements.loanRecovery,
        netPayable: fnfSettlements.netPayable,
        status: fnfSettlements.status,
        notes: fnfSettlements.notes,
        reimbursementsDue: fnfSettlements.reimbursementsDue,
        assetRecovery: fnfSettlements.assetRecovery,
        noticeRecovery: fnfSettlements.noticeRecovery,
        otherDeductions: fnfSettlements.otherDeductions,
        statementPublishedAt: fnfSettlements.statementPublishedAt,
        createdAt: fnfSettlements.createdAt,
      })
      .from(fnfSettlements)
      .where(
        and(
          eq(fnfSettlements.userMembershipId, membershipId ?? 0),
          eq(fnfSettlements.orgId, orgId),
          not(eq(fnfSettlements.status, "DRAFT")),
        ),
      )
      .orderBy(desc(fnfSettlements.createdAt))
      .limit(1);
    return settlement ?? null;
  }

  /**
   * Illustrative total rewards: salary CTC, YTD payslips, benefits, equity units, leave.
   * Not a certified compensation statement; equity is not mark-to-market.
   */
  async getTotalRewards(orgId: string, userId: string, membershipId: number | null) {
    const now = new Date();
    const yr = now.getFullYear();
    const mo = now.getMonth() + 1;
    const fyStart = mo >= 4 ? `${yr}-04` : `${yr - 1}-04`;
    const fyEnd = mo >= 4 ? `${yr + 1}-03` : `${yr}-03`;

    const [profile, fyPubs, [activeLoanRow], benefitRows, equityRows, leaveRows] =
      await Promise.all([
        this.db.query.employeeSalaryProfiles.findFirst({
          where: and(
            eq(employeeSalaryProfiles.userMembershipId, membershipId ?? 0),
            eq(employeeSalaryProfiles.orgId, orgId),
            eq(employeeSalaryProfiles.status, "ACTIVE"),
          ),
          orderBy: (fields, { desc: d }) => [d(fields.effectiveFrom)],
        }),
        this.db
          .select({ runId: payslipPublications.runId })
          .from(payslipPublications)
          .innerJoin(payrollRuns, eq(payrollRuns.id, payslipPublications.runId))
          .where(
            and(
              eq(payslipPublications.userMembershipId, membershipId ?? 0),
              eq(payslipPublications.orgId, orgId),
              eq(payslipPublications.status, "PUBLISHED"),
              gte(payrollRuns.month, fyStart),
              lte(payrollRuns.month, fyEnd),
            ),
          ),
        this.db
          .select({
            balance: sql<string>`coalesce(sum((coalesce(${salaryLoans.totalEmis}, 0) - coalesce(${salaryLoans.paidEmis}, 0)) * coalesce(${salaryLoans.emiAmount}, 0)::numeric), 0)::text`,
          })
          .from(salaryLoans)
          .where(and(
            eq(salaryLoans.userMembershipId, membershipId ?? 0),
            eq(salaryLoans.orgId, orgId),
            inArray(salaryLoans.status, ["APPROVED", "ACTIVE"]),
          )),
        this.db
          .select({
            planName: hrBenefitPlans.name,
            category: hrBenefitPlans.category,
            premiumCents: hrBenefitPlans.premiumCents,
            employerContributionPct: hrBenefitPlans.employerContributionPct,
            status: hrBenefitEnrollments.status,
          })
          .from(hrBenefitEnrollments)
          .innerJoin(hrBenefitPlans, eq(hrBenefitPlans.id, hrBenefitEnrollments.planId))
          .where(
            and(
              eq(hrBenefitEnrollments.orgId, orgId),
              eq(hrBenefitEnrollments.userId, userId),
              eq(hrBenefitEnrollments.status, "active"),
            ),
          )
          .limit(100),
        this.db
          .select({
            grantType: hrEquityGrants.grantType,
            units: hrEquityGrants.units,
            strikePriceCents: hrEquityGrants.strikePriceCents,
            status: hrEquityGrants.status,
            grantDate: hrEquityGrants.grantDate,
          })
          .from(hrEquityGrants)
          .where(
            and(
              eq(hrEquityGrants.orgId, orgId),
              eq(hrEquityGrants.userId, userId),
              eq(hrEquityGrants.status, "active"),
            ),
          )
          .limit(100),
        this.db
          .select({
            leaveType: leaveTypes.name,
            balance: leaveBalances.balance,
          })
          .from(leaveBalances)
          .leftJoin(leaveTypes, eq(leaveTypes.id, leaveBalances.leaveTypeId))
          .where(
            and(
              eq(leaveBalances.orgId, orgId),
              eq(leaveBalances.userId, userId),
              eq(leaveBalances.year, yr),
            ),
          )
          .limit(100),
      ]);

    let ytdGross = 0;
    let ytdNet = 0;
    if (fyPubs.length > 0) {
      const [ytd] = await this.db
        .select({
          gross: sum(payrollRunEmployees.gross),
          net: sum(payrollRunEmployees.net),
        })
        .from(payrollRunEmployees)
        .where(
          and(
            eq(payrollRunEmployees.userMembershipId, membershipId ?? 0),
            inArray(
              payrollRunEmployees.runId,
              fyPubs.map((p) => p.runId),
            ),
          ),
        );
      ytdGross = parseFloat(ytd?.gross ?? "0") || 0;
      ytdNet = parseFloat(ytd?.net ?? "0") || 0;
    }

    const activeLoanBalance = parseFloat(activeLoanRow?.balance ?? "0") || 0;

    const annualCtc =
      profile?.annualCtc != null ? parseFloat(profile.annualCtc) || null : null;

    return buildTotalRewardsStatement({
      asOf: now,
      cash: {
        annualCtc: annualCtc != null && !Number.isNaN(annualCtc) ? annualCtc : null,
        ytdGross,
        ytdNet,
        activeLoanBalance,
      },
      benefits: benefitRows.map((b) => ({
        planName: b.planName,
        category: String(b.category),
        premiumCents: b.premiumCents,
        employerContributionPct: b.employerContributionPct ?? 0,
        status: String(b.status),
      })),
      equity: equityRows.map((e) => ({
        grantType: String(e.grantType),
        units: e.units,
        strikePriceCents: e.strikePriceCents,
        status: String(e.status),
        grantDate: e.grantDate,
      })),
      leave: leaveRows.map((l) => ({
        leaveType: l.leaveType ?? "Leave",
        balance: parseFloat(String(l.balance ?? 0)) || 0,
      })),
    });
  }
}
