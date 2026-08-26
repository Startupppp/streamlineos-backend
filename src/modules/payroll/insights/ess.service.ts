import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, lte, not, sum } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  auditLogs,
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
  taxDeclarations,
  users,
  leaveBalances,
  leaveTypes,
} from "../../../db/schema";
import { hrBenefitEnrollments, hrBenefitPlans } from "../../../db/schema/hr/benefits";
import { hrEquityGrants } from "../../../db/schema/hr/enterprise-comp";
import { LoansService } from "../hr-payroll/loans.service";
import { ReimbursementsService } from "../hr-payroll/reimbursements.service";
import { TaxService } from "../hr-payroll/tax.service";
import { type BankDetails, decryptBankDetails, encryptBankDetails } from "../../hr/onboarding/core/crypto.helpers";
import { detectScheme, validateSchemeCode } from "../../payroll/payout/lib/bank-validation";
import type { EssBank } from "./dto/insights.schemas";
import { DEFAULT_PAYROLL_TOGGLES, PayrollToggles } from "../payroll.types";
import { buildTotalRewardsStatement } from "./lib/total-rewards";

@Injectable()
export class EssService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly loansService: LoansService,
    private readonly reimbursementsService: ReimbursementsService,
    private readonly taxService: TaxService,
  ) {}

  async getActiveToggles(orgId: string): Promise<PayrollToggles> {
    const policy = await this.db.query.payrollPolicies.findFirst({
      where: eq(payrollPolicies.orgId, orgId),
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

  async getOverview(orgId: string, userId: string) {
    const pubWhere = and(
      eq(payslipPublications.userId, userId),
      eq(payslipPublications.orgId, orgId),
      eq(payslipPublications.status, "PUBLISHED"),
    );

    const now = new Date(), yr = now.getFullYear(), mo = now.getMonth() + 1;
    const fyStart = mo >= 4 ? `${yr}-04` : `${yr - 1}-04`;
    const fyEnd = mo >= 4 ? `${yr + 1}-03` : `${yr}-03`;
    const today = now.toISOString().slice(0, 10);

    const [toggles, [latestPub], fyPubs, activeLoans, [pendingRow], window, [nextPayEvent]] = await Promise.all([
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
      this.db.query.salaryLoans.findMany({
        where: and(eq(salaryLoans.userId, userId), eq(salaryLoans.orgId, orgId), inArray(salaryLoans.status, ["APPROVED", "ACTIVE"])),
        columns: { totalEmis: true, paidEmis: true, emiAmount: true },
      }),
      this.db
        .select({ total: count() })
        .from(reimbursements)
        .where(and(eq(reimbursements.userId, userId), eq(reimbursements.orgId, orgId), eq(reimbursements.status, "PENDING"))),
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
            .where(and(eq(payrollRunEmployees.userId, userId), inArray(payrollRunEmployees.runId, fyPubs.map((p) => p.runId))))
        : Promise.resolve([]),
      window ? this.taxService.listMine(orgId, userId) : Promise.resolve([]),
    ]);

    let ytdGross = "0.00", ytdNet = "0.00";
    if (ytdRows[0]) {
      ytdGross = parseFloat(ytdRows[0].gross ?? "0").toFixed(2);
      ytdNet = parseFloat(ytdRows[0].net ?? "0").toFixed(2);
    }

    const activeLoanBalance = activeLoans
      .reduce((acc, l) => acc + ((l.totalEmis ?? 0) - l.paidEmis) * parseFloat(l.emiAmount ?? "0"), 0)
      .toFixed(2);

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

  async getPayslips(orgId: string, userId: string) {
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
      .where(and(eq(payslipPublications.userId, userId), eq(payslipPublications.orgId, orgId), eq(payslipPublications.status, "PUBLISHED")))
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

  async getSalaryStructure(orgId: string, userId: string) {
    const toggles = await this.getActiveToggles(orgId);
    if (!toggles.essShowSalaryStructure) throw new ForbiddenException("Salary structure access is disabled");

    const profile = await this.db.query.employeeSalaryProfiles.findFirst({
      where: and(
        eq(employeeSalaryProfiles.userId, userId),
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
      .where(eq(employeeSalaryProfileComponents.profileId, profile.id));

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

  async createReimbursement(
    orgId: string,
    userId: string,
    body: { category: string; amount: number; description?: string; receiptUrl?: string; payrollMonth?: string },
  ) {
    const toggles = await this.getActiveToggles(orgId);
    if (!toggles.essAllowReimbursements) throw new ForbiddenException("Reimbursements are disabled");
    return this.reimbursementsService.createReimbursement(orgId, userId, {
      category: body.category,
      amount: body.amount,
      description: body.description,
      receiptUrl: body.receiptUrl,
      payrollMonth: body.payrollMonth,
    });
  }

  async listReimbursements(orgId: string, userId: string) {
    const toggles = await this.getActiveToggles(orgId);
    if (!toggles.essAllowReimbursements) throw new ForbiddenException("Reimbursements are disabled");
    return this.reimbursementsService.listReimbursements(orgId, userId, "own");
  }

  async listLoans(orgId: string, userId: string) {
    const toggles = await this.getActiveToggles(orgId);
    if (!toggles.essAllowLoanRequests) throw new ForbiddenException("Loan requests are disabled");
    const loans = await this.loansService.listLoans(orgId, userId, false);
    return loans.map((l) => ({
      ...l,
      balance: (((l.totalEmis ?? 0) - l.paidEmis) * parseFloat(l.emiAmount ?? "0")).toFixed(2),
    }));
  }

  async createLoan(orgId: string, userId: string, body: { amount: number; reason: string; totalEmis: number }) {
    const toggles = await this.getActiveToggles(orgId);
    if (!toggles.essAllowLoanRequests) throw new ForbiddenException("Loan requests are disabled");
    return this.loansService.createLoan(orgId, userId, false, { amount: body.amount, reason: body.reason, totalEmis: body.totalEmis });
  }

  async getTaxDeclaration(orgId: string, userId: string) {
    const [toggles, window] = await Promise.all([
      this.getActiveToggles(orgId),
      this.getActiveWindow(orgId),
    ]);
    if (!toggles.essAllowTaxDeclarations) throw new ForbiddenException("Tax declarations are disabled");
    if (!window) return { windowStatus: null, declaration: null, proofs: [] };

    const declarations = await this.taxService.listMine(orgId, userId);
    const declaration = declarations.find((d) => d.financialYear === window.financialYear) ?? null;
    const proofs = declaration ? await this.taxService.listProofs(orgId, declaration.id) : [];

    return { windowStatus: "OPEN" as const, financialYear: window.financialYear, closesAt: window.closesAt, declaration, proofs };
  }

  async submitTaxDeclaration(
    orgId: string,
    userId: string,
    body: {
      financialYear: string;
      regime: "OLD" | "NEW";
      hra?: number;
      lta?: number;
      section80c?: number;
      section80d?: number;
      section80g?: number;
      homeLoanInterest?: number;
    },
  ) {
    const toggles = await this.getActiveToggles(orgId);
    if (!toggles.essAllowTaxDeclarations) throw new ForbiddenException("Tax declarations are disabled");
    const window = await this.getActiveWindow(orgId);
    if (!window) throw new ForbiddenException("Tax declaration window is not open");

    if (window.lockDate) {
      const todayIso = new Date().toISOString().slice(0, 10);
      if (todayIso > window.lockDate) {
        throw new ForbiddenException(
          `Tax declaration window is locked — submission deadline was ${window.lockDate}`,
        );
      }
    }

    return this.taxService.createOrUpdate(orgId, userId, {
      financialYear: body.financialYear,
      regime: body.regime,
      hra: body.hra?.toString(),
      lta: body.lta?.toString(),
      section80c: body.section80c?.toString(),
      section80d: body.section80d?.toString(),
      section80g: body.section80g?.toString(),
      homeLoanInterest: body.homeLoanInterest?.toString(),
      status: "SUBMITTED",
    });
  }

  async addTaxProof(
    orgId: string,
    userId: string,
    body: { declarationId: number; category: string; amount: number; description?: string; proofUrl?: string },
  ) {
    const [toggles, declaration, window] = await Promise.all([
      this.getActiveToggles(orgId),
      this.db.query.taxDeclarations.findFirst({
        where: and(eq(taxDeclarations.id, body.declarationId), eq(taxDeclarations.userId, userId), eq(taxDeclarations.orgId, orgId)),
      }),
      this.getActiveWindow(orgId),
    ]);
    if (!toggles.essAllowTaxDeclarations) throw new ForbiddenException("Tax declarations are disabled");
    if (!declaration) throw new NotFoundException("Tax declaration not found");
    if (!window) throw new ForbiddenException("Tax declaration window is not open");
    if (window.lockDate) {
      const todayIso = new Date().toISOString().slice(0, 10);
      if (todayIso > window.lockDate) {
        throw new ForbiddenException(
          `Tax declaration window is locked — submission deadline was ${window.lockDate}`,
        );
      }
    }

    return this.taxService.addProof(orgId, body.declarationId, {
      category: body.category,
      amount: body.amount.toString(),
      description: body.description,
      proofUrl: body.proofUrl,
    });
  }

  async getBankDetails(orgId: string, userId: string) {
    const toggles = await this.getActiveToggles(orgId);
    if (!toggles.essAllowBankUpdate) throw new ForbiddenException("Bank details access is disabled");
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new NotFoundException("User not found");
    const details = decryptBankDetails(user.bankDetails);
    if (!details) return { hasBank: false, masked: null };
    return {
      hasBank: true,
      masked: {
        accountNumber: `****${details.accountNumber.slice(-4)}`,
        bankName: details.bankName,
        branch: details.branch,
        ifsc: details.ifsc,
        accountHolder: details.accountHolder,
        bankCountry: details.bankCountry ?? null,
      },
    };
  }

  async updateBankDetails(orgId: string, userId: string, body: EssBank) {
    const toggles = await this.getActiveToggles(orgId);
    if (!toggles.essAllowBankUpdate) throw new ForbiddenException("Bank details update is disabled");

    const activeRun = await this.db.query.payrollRuns.findFirst({
      where: and(
        eq(payrollRuns.orgId, orgId),
        inArray(payrollRuns.status, ["LOCKED", "APPROVED", "PAID", "PAYSLIPS_PUBLISHED"]),
      ),
      columns: { id: true, status: true, month: true },
    });
    if (activeRun) {
      throw new ConflictException(
        `Bank details are frozen: payroll run ${activeRun.month} is in status ${activeRun.status}. Contact HR to update after payout is complete.`,
      );
    }

    const effectiveCode = body.code ?? body.ifsc ?? "";
    const effectiveHolder = body.accountHolder ?? body.accountHolderName ?? "";
    const effectiveCountry = body.bankCountry ?? "IN";
    const scheme = detectScheme(effectiveCountry);
    const codeValidation = validateSchemeCode(scheme, effectiveCode);
    if (!codeValidation.valid) {
      throw new BadRequestException(codeValidation.issue ?? `Invalid ${codeValidation.label}`);
    }

    const stored: BankDetails = {
      accountNumber: body.accountNumber,
      bankName: body.bankName,
      branch: body.branch,
      ifsc: effectiveCode,
      accountHolder: effectiveHolder,
      pfUanNumber: body.pfUanNumber,
      bankCountry: body.bankCountry,
    };

    const encrypted = encryptBankDetails(stored);
    await this.db.update(users).set({ bankDetails: encrypted }).where(eq(users.id, userId));
    await this.db.insert(auditLogs).values({
      action: "bank_details.updated",
      userId,
      orgId,
      actorUserId: userId,
      resourceType: "user",
      resourceId: userId,
    });
    return { updated: true };
  }

  async getOwnFnf(orgId: string, userId: string) {
    const [settlement] = await this.db
      .select()
      .from(fnfSettlements)
      .where(
        and(
          eq(fnfSettlements.userId, userId),
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
  async getTotalRewards(orgId: string, userId: string) {
    const now = new Date();
    const yr = now.getFullYear();
    const mo = now.getMonth() + 1;
    const fyStart = mo >= 4 ? `${yr}-04` : `${yr - 1}-04`;
    const fyEnd = mo >= 4 ? `${yr + 1}-03` : `${yr}-03`;

    const [profile, fyPubs, activeLoans, benefitRows, equityRows, leaveRows] =
      await Promise.all([
        this.db.query.employeeSalaryProfiles.findFirst({
          where: and(
            eq(employeeSalaryProfiles.userId, userId),
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
              eq(payslipPublications.userId, userId),
              eq(payslipPublications.orgId, orgId),
              eq(payslipPublications.status, "PUBLISHED"),
              gte(payrollRuns.month, fyStart),
              lte(payrollRuns.month, fyEnd),
            ),
          ),
        this.db.query.salaryLoans.findMany({
          where: and(
            eq(salaryLoans.userId, userId),
            eq(salaryLoans.orgId, orgId),
            inArray(salaryLoans.status, ["APPROVED", "ACTIVE"]),
          ),
          columns: { totalEmis: true, paidEmis: true, emiAmount: true },
        }),
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
          ),
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
          ),
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
          ),
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
            eq(payrollRunEmployees.userId, userId),
            inArray(
              payrollRunEmployees.runId,
              fyPubs.map((p) => p.runId),
            ),
          ),
        );
      ytdGross = parseFloat(ytd?.gross ?? "0") || 0;
      ytdNet = parseFloat(ytd?.net ?? "0") || 0;
    }

    const activeLoanBalance = activeLoans.reduce(
      (acc, l) =>
        acc + ((l.totalEmis ?? 0) - (l.paidEmis ?? 0)) * parseFloat(l.emiAmount ?? "0"),
      0,
    );

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
